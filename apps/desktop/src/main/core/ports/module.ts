import type { ServiceAccessor } from './di';
import type { Logger } from './logger';
import type { EventPublisher } from './event-publisher';
import type { AppEnv } from './env';
import type { RouteRegistrar } from './route-registrar';
import type { ServiceRegistration } from './di';

/**
 * 模块端口（driving port）：业务实现它、框架消费它——一个业务特性向
 * 组合根申报的内容（声明期数据，运行时"溶解"为 token 与 channel）。
 */

/** 模块 init 钩子的上下文（框架在启动期调用 init 时注入）。 */
export interface ModuleInitContext {
    /** 服务访问器（warm-up 依赖、取本模块服务实例）。 */
    readonly services: ServiceAccessor;
    /** 根 logger。 */
    readonly logger: Logger;
    /** 事件发布器（发初始事件）。 */
    readonly events: EventPublisher;
    /** 环境信息。 */
    readonly env: AppEnv;
}

/** 业务模块协议。 */
export interface AppModule {
    /** 模块 id（建议与目录名一致）。 */
    readonly id: string;
    /** 申报的服务注册（app 级单例，惰性构造）。 */
    readonly services?: ReadonlyArray<ServiceRegistration<unknown>>;
    /** 向路由申报本模块的 IPC 端点。 */
    registerRoutes?(registrar: RouteRegistrar): void;
    /** 注册完成后、路由上线前执行（特性的启动仪式）。 */
    init?(ctx: ModuleInitContext): void | Promise<void>;
}
