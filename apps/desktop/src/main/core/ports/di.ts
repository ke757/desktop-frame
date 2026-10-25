/**
 * DI 端口词汇：服务身份（token）与容器对外契约的纯类型。
 * 实现见 core/container.ts；本文件只允许依赖 ports 内其他文件。
 */

/** 服务 token：依赖接缝的命名句柄，`__type` 为幻影类型载体（运行时不存在）。 */
export interface ServiceToken<T> {
    /** token 的全局唯一 id（`core.*` / `modules.<mod>.*` 命名空间）。 */
    readonly id: string;
    /** 幻影类型载体，仅用于编译期。 */
    readonly __type?: T;
}

/** 容器访问器：工厂与 handler 经它按 token 解析依赖。 */
export interface ServiceAccessor {
    /** 解析（并 memoize）token 对应的服务实例。 */
    get<T>(token: ServiceToken<T>): Promise<T>;
}

/** 可释放服务：dispose 由容器在关停时逆序独占调用。 */
export interface DisposableService {
    /** 释放资源；生命周期方法不进服务的公开接口。 */
    dispose?(): void | Promise<void>;
}

/** 服务工厂：服务的私有组合根（私有协作者在此直接 new）。 */
export type ServiceFactory<T> = (accessor: ServiceAccessor) => T | Promise<T>;

/** 一条服务注册（token + 工厂），由模块的 services 数组申报。 */
export interface ServiceRegistration<T> {
    /** 服务 token。 */
    readonly token: ServiceToken<T>;
    /** 服务工厂。 */
    readonly factory: ServiceFactory<T>;
}
