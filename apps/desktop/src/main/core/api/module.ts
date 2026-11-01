import type { AppHandle } from './app-handle';
import type { ServiceAccessor } from './di';
import type { RouteRegistrar } from './route-registrar';
import type { ServiceRegistration } from './di';
import type { DeploymentSpec } from './deployment';

/**
 * 模块协议（模块作者公共 API）：业务实现它、框架消费它——一个业务特性向
 * 组合根申报的内容（声明期数据，运行时"溶解"为 token 与 channel）。
 */

/** 模块 init 钩子的上下文：两条依赖通道（内核能力 + 业务服务）。 */
export interface ModuleInitContext {
    /** 内核能力的受限公开面（DesktopApp 签发的 AppHandle）。 */
    readonly app: AppHandle;
    /** 服务访问器（warm-up 依赖、取本模块服务实例）。 */
    readonly services: ServiceAccessor;
}

/**
 * 模块 dispose 钩子的上下文：与 init 完全同形（受限能力一致）——此刻服务
 * 容器尚未释放，dispose 内仍可解析依赖（解析到的服务尚未 dispose）。
 */
export type ModuleDisposeContext = ModuleInitContext;

/** 业务模块协议。 */
export interface AppModule {
    /** 模块 id（建议与目录名一致，全局唯一）。 */
    readonly id: string;
    /** 申报的服务注册（app 级单例，惰性构造；只登记业务与应用服务）。 */
    readonly services?: ReadonlyArray<ServiceRegistration<unknown>>;
    /** 申报本模块引入的外部部署（框架在 build 期注册给部署控制面）。 */
    readonly deployments?: ReadonlyArray<DeploymentSpec>;
    /** 向路由申报本模块的 IPC 端点（build 期登记，channel 重复在 build 抛错）。 */
    registerRoutes?(registrar: RouteRegistrar): void;
    /** 路由上线前执行（特性的启动仪式；失败会触发应用启动回滚）。 */
    init?(ctx: ModuleInitContext): void | Promise<void>;
    /**
     * 与 init 对称的清理钩子：回收 init 直接持有的非服务资源。关停时按
     * 模块逆序、在 container dispose 之前调用；服务资源的回收仍走服务的
     * dispose（见 DisposableService）。
     */
    dispose?(ctx: ModuleDisposeContext): void | Promise<void>;
}
