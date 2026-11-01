import type {
    DisposableService,
    ServiceAccessor,
    ServiceFactory,
    ServiceFactoryContext,
    ServiceRegistration,
    ServiceToken,
} from '../api/di';
import type { AppHandle } from '../api/app-handle';
import type { Logger } from '../api/logger';

/**
 * 轻量异步服务容器（内核部件，模块作者经 api/di 的词汇使用它）。
 *
 * 职责边界：容器只管理**业务与应用服务**（模块/组合根申报的 token）——
 * Logger、AppEnv、EventPublisher、Deployment 等内核能力由 DesktopApp 持有，
 * 不在这里登记；工厂经构造注入的 AppHandle（`ctx.app`）使用内核能力。
 *
 * 设计要点（与大型 Electron 代码库的收敛实践对齐）：
 * - 服务以类型化 token 标识，首次 `get` 时才惰性实例化并 memoize；
 *   工厂可以是异步的（打开数据库、读文件）。
 * - **并发安全**：循环检测的祖先链属于单次解析上下文（不可变、随
 *   accessor 传递），不由整个容器共享——顶层并发消费者首次获取同一个
 *   冷服务时共享同一个 memoized Promise，不会误报循环；真正的
 *   A → B → A 仍会快速抛 `CyclicDependencyError`（不会挂起等待自身）。
 * - **dispose 唯一且幂等**：dispose 开始后拒绝新的 register/get；在途
 *   创建全部落定后，按实例化逆序清理所有成功创建的实例（含 dispose
 *   开始后才完成的"晚到"实例），不存在 dispose 返回后实例逃逸的窗口。
 */

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

/** 顶层解析的空祖先链（单例共享，不可变）。 */
const NO_ANCESTORS: readonly string[] = [];

/** 服务容器：注册、并发安全的惰性创建、memoize 与逆序 dispose。 */
export class ServiceContainer implements ServiceAccessor {
    private readonly factories = new Map<string, ServiceFactory<unknown>>();
    /** 每个服务的唯一创建 promise（创建中或已完成；失败会被移除以允许重试）。 */
    private readonly instances = new Map<string, Promise<unknown>>();
    /** 成功创建的实例顺序（dispose 逆序的依据，含 dispose 期间晚完成的创建）。 */
    private readonly instantiationOrder: string[] = [];
    /** 是否已进入 dispose（此后拒绝新的 register/get，对象图不再扩张）。 */
    private disposed = false;
    /** 唯一的 dispose promise（幂等；并发 dispose 共享同一次清理）。 */
    private disposePromise: Promise<void> | undefined;

    /**
     * @param app DesktopApp 签发的受限应用句柄（传给每个工厂的 `ctx.app`，
     *            构造注入的框架依赖，不代表内核能力被登记为服务）。
     * @param logger 容器自身的日志（dispose 失败记录用）。
     */
    constructor(
        private readonly app: AppHandle,
        private readonly logger?: Logger,
    ) {}

    /** 注册服务（重复注册同 id 抛错）；dispose 开始后不可再注册。 */
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

    /** 获取服务实例：并发调用共享同一个创建 promise（含冷启动并发）。 */
    get<T>(token: ServiceToken<T>): Promise<T> {
        return this.resolve(token, NO_ANCESTORS);
    }

    /** 启动时预热指定服务（例如模块声明为 eager 的服务）。 */
    async init(tokens: ReadonlyArray<ServiceToken<unknown>>): Promise<void> {
        await Promise.all(tokens.map((token) => this.get(token)));
    }

    /**
     * 释放全部实例：幂等（并发/重复调用共享同一个 dispose promise）。
     * 先等所有在途创建落定（对象图就此冻结），再按实例化逆序逐个
     * dispose；单项失败只记日志，不阻断其余清理。
     */
    dispose(): Promise<void> {
        if (!this.disposePromise) {
            this.disposed = true;
            this.disposePromise = this.runDispose();
        }
        return this.disposePromise;
    }

    /**
     * 带祖先链的解析入口。ancestors 是当前解析上下文中"正在创建中的
     * 祖先服务"（不可变快照）；memoized 命中且出现在祖先链中，说明某
     * 个正在创建的祖先回过头来请求自身——真实循环依赖。
     */
    private resolve<T>(token: ServiceToken<T>, ancestors: readonly string[]): Promise<T> {
        try {
            if (this.disposed) {
                throw new ContainerDisposedError(`container is disposed: ${token.id}`);
            }
            const memoized = this.instances.get(token.id);
            if (memoized) {
                if (ancestors.includes(token.id)) {
                    throw new CyclicDependencyError([...ancestors, token.id]);
                }
                // 其余情况（其他并发消费者创建的，或已完成的实例）安全共享。
                return memoized as Promise<T>;
            }
            const factory = this.factories.get(token.id);
            if (!factory) {
                const known = [...this.factories.keys()].join(', ') || '<none>';
                throw new UnknownServiceError(
                    `service not registered: ${token.id} (registered: ${known})`,
                );
            }
            // 创建 promise 必须先同步占位、再启动工厂：工厂的同步重入解析
            // （A 的工厂同步请求 B、B 又同步请求 A）据此命中 memo 条目并走
            // 祖先链快速失败，而不是无限递归；并发冷启动也共享同一 promise。
            let settle!: (creation: Promise<unknown>) => void;
            const creation = new Promise<unknown>((resolveCreation) => {
                settle = resolveCreation;
            });
            this.instances.set(token.id, creation);
            // 创建失败则丢弃缓存，允许之后的 get 重试（身份守卫防止误删更新的尝试）。
            void creation.catch(() => {
                if (this.instances.get(token.id) === creation) {
                    this.instances.delete(token.id);
                }
            });
            settle(this.create(token, factory, [...ancestors, token.id]));
            return creation as Promise<T>;
        } catch (cause) {
            // 恒以 rejected promise 表达失败（get 不向调用方同步抛错）。
            return Promise.reject(cause);
        }
    }

    /**
     * 执行工厂创建实例。传给工厂的上下文携带：内核能力（`app`，构造注入
     * 的同一 AppHandle）与业务服务访问器（`services`，携带本上下文祖先
     * 链的 scoped accessor——含自身，依赖解析据此做单次上下文内的循环
     * 检测；不因传 AppHandle 退回全容器共享链）。
     */
    private async create<T>(
        token: ServiceToken<T>,
        factory: ServiceFactory<unknown>,
        chain: readonly string[],
    ): Promise<T> {
        const services: ServiceAccessor = {
            get: <R>(dependency: ServiceToken<R>) => this.resolve(dependency, chain),
        };
        const factoryCtx: ServiceFactoryContext = { app: this.app, services };
        const instance = await factory(factoryCtx);
        this.instantiationOrder.push(token.id);
        return instance as T;
    }

    /** dispose 的实际执行：冻结对象图 → 等在途创建 → 逆序清理。 */
    private async runDispose(): Promise<void> {
        // 快照并等待全部在途创建落定（成功或失败）。此后不可能再出现
        // 新的创建（disposed 已拒绝 get），晚完成的实例也已被记入
        // instantiationOrder，不会逃逸出本次清理。
        const pending = [...this.instances.values()];
        await Promise.allSettled(pending);
        const order = [...this.instantiationOrder].reverse();
        for (const id of order) {
            const creation = this.instances.get(id);
            if (!creation) continue;
            let instance: unknown;
            try {
                instance = await creation;
            } catch {
                continue; // 创建失败的服务没有可释放的实例。
            }
            try {
                await (instance as DisposableService)?.dispose?.();
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
}
