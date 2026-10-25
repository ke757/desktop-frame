import type { Logger } from './logging';

/**
 * 轻量异步服务容器（composition-root 风格的 DI）。
 *
 * 设计要点（与大型 Electron 代码库的收敛实践对齐）：
 * - 服务以类型化 token（`serviceToken<T>`）标识，在组合根统一注册，
 *   首次 `get` 时才惰性实例化（VS Code 的 `InstantiationType.Delayed` 同为其推荐模式）。
 * - 与 VS Code 的同步 instantiation service 不同，工厂可以是异步的
 *   （打开数据库、读文件）——反正 handler 都是异步的。
 * - 实例会被 memoize；dispose 按实例化的逆序执行，保证依赖方先于其依赖被释放。
 *
 * 已知限制（文档化）：嵌套/顺序解析场景下循环依赖检测是精确的；若工厂内
 * `Promise.all` 两个子图重叠的 `get`，可能被误判为循环——避免在工厂里
 * 并行获取重叠子图。
 */

/** 服务 token：运行时只有字符串 id，`__type` 仅承载幻影类型。 */
export interface ServiceToken<T> {
    /** 服务唯一标识（注册与查找的键）。 */
    readonly id: string;
    /** 幻影类型载体，运行时永不赋值。 */
    readonly __type?: T;
}

/** 创建一个类型化服务 token。 */
export function serviceToken<T>(id: string): ServiceToken<T> {
    return { id };
}

/** 服务获取器：在工厂或 handler 内按 token 取依赖。 */
export interface ServiceAccessor {
    /** 获取（必要时创建）token 对应的服务实例。 */
    get<T>(token: ServiceToken<T>): Promise<T>;
}

/** 拥有资源的服务可实现 `dispose`，由容器在关停时逆序调用。 */
export interface DisposableService {
    /** 释放资源；容器保证只在关停管线中调用一次。 */
    dispose?(): void | Promise<void>;
}

/** 服务工厂：通过 accessor 声明并获取依赖，返回服务实例。 */
export type ServiceFactory<T> = (accessor: ServiceAccessor) => T | Promise<T>;

/** 一项服务注册：token + 工厂。 */
export interface ServiceRegistration<T> {
    /** 服务 token。 */
    readonly token: ServiceToken<T>;
    /** 服务工厂。 */
    readonly factory: ServiceFactory<T>;
}

/**
 * 定义一项服务注册的函数。
 * 调用后返回注册项对象。
 */
export function defineService<T>(
    token: ServiceToken<T>,
    factory: ServiceFactory<T>,
): ServiceRegistration<T> {
    return { token, factory };
}

/** 容器相关错误基类。 */
export class ContainerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ContainerError';
    }
}

/** 请求了未注册的服务。 */
export class UnknownServiceError extends ContainerError {}

/** 检测到循环依赖，chain 记录完整环路。 */
export class CyclicDependencyError extends ContainerError {
    constructor(readonly chain: string[]) {
        super(`cyclic service dependency: ${chain.join(' -> ')}`);
        this.name = 'CyclicDependencyError';
    }
}

/** 容器已 dispose 后再次使用。 */
export class ContainerDisposedError extends ContainerError {}

/** 服务容器：注册、惰性创建、memoize 与逆序 dispose。 */
export class ServiceContainer implements ServiceAccessor {
    private readonly factories = new Map<string, ServiceFactory<unknown>>();
    private readonly instances = new Map<string, Promise<unknown>>();
    private readonly instantiationOrder: string[] = [];
    private readonly resolutionChain: string[] = [];
    private disposed = false;

    constructor(private readonly logger?: Logger) {}

    /** 注册服务（重复注册同 id 抛错）；dispose 后不可再注册。 */
    register<T>(registration: ServiceRegistration<T>): this {
        if (this.disposed) {
            throw new ContainerDisposedError('cannot register into disposed container');
        }
        if (this.factories.has(registration.token.id)) {
            throw new ContainerError(
                `service already registered: ${registration.token.id}`,
            );
        }
        this.factories.set(
            registration.token.id,
            registration.factory as ServiceFactory<unknown>,
        );
        return this;
    }

    /** 判断服务是否已注册。 */
    has(token: ServiceToken<unknown>): boolean {
        return this.factories.has(token.id);
    }

    /** 获取服务实例：memoize 命中直接返回，否则创建并缓存。 */
    async get<T>(token: ServiceToken<T>): Promise<T> {
        const memoized = this.instances.get(token.id);
        if (memoized) {
            if (this.resolutionChain.includes(token.id)) {
                // 对"创建中的我"的重入请求，即循环依赖。
                throw new CyclicDependencyError([...this.resolutionChain, token.id]);
            }
            return memoized as Promise<T>;
        }
        const pending = this.create(token);
        this.instances.set(token.id, pending);
        // 创建失败则丢弃缓存，允许之后的 get 重试（身份守卫防止误删更新的尝试）。
        void pending.catch(() => {
            if (this.instances.get(token.id) === pending) {
                this.instances.delete(token.id);
            }
        });
        return pending;
    }

    /** 启动时预热指定服务（例如模块声明为 eager 的服务）。 */
    async init(tokens: ReadonlyArray<ServiceToken<unknown>>): Promise<void> {
        await Promise.all(tokens.map((token) => this.get(token)));
    }

    /** 按实例化逆序调用各服务的 dispose；单项失败只记日志不中断。 */
    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        const order = [...this.instantiationOrder].reverse();
        for (const id of order) {
            try {
                const instance = (await this.instances.get(id)) as DisposableService;
                await instance?.dispose?.();
            } catch (cause) {
                this.logger?.error('service dispose failed', {
                    service: id,
                    error: cause,
                });
            }
        }
        this.instances.clear();
        this.instantiationOrder.length = 0;
    }

    /** 执行工厂创建实例，维护解析链以检测循环依赖。 */
    private async create<T>(token: ServiceToken<T>): Promise<T> {
        const factory = this.factories.get(token.id);
        if (!factory) {
            const known = [...this.factories.keys()].join(', ') || '<none>';
            throw new UnknownServiceError(
                `service not registered: ${token.id} (registered: ${known})`,
            );
        }
        if (this.disposed) {
            throw new ContainerDisposedError(`container is disposed: ${token.id}`);
        }
        if (this.resolutionChain.includes(token.id)) {
            throw new CyclicDependencyError([...this.resolutionChain, token.id]);
        }
        this.resolutionChain.push(token.id);
        try {
            const instance = await factory(this);
            this.instantiationOrder.push(token.id);
            return instance as T;
        } finally {
            this.resolutionChain.pop();
        }
    }
}
