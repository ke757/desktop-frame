import type { ServiceAccessor, ServiceRegistration } from './container';
import type { AppEnv } from './env';
import type { RouteRegistrar } from './ipc/router';
import type { EventPublisher } from './ipc/events';
import type { Logger } from './logging';

/**
 * 业务特性以模块形式接入后端：注册服务（app 级单例）、IPC 路由，
 * 以及可选的异步 init 钩子。组合根只需列出模块列表。
 */
export interface ModuleInitContext {
    /** 服务获取器（可在此预热服务）。 */
    readonly services: ServiceAccessor;
    /** 根 logger。 */
    readonly logger: Logger;
    /** 事件发布器。 */
    readonly events: EventPublisher;
    /** 环境信息。 */
    readonly env: AppEnv;
}

/** 业务模块协议。 */
export interface AppModule {
    /** 模块 id（日志与装配信息使用）。 */
    readonly id: string;
    /** 模块注册的 app 级服务列表。 */
    readonly services?: ReadonlyArray<ServiceRegistration<unknown>>;
    /** 向路由注册本模块的 IPC 端点。 */
    registerRoutes?(registrar: RouteRegistrar): void;
    /** 注册完成后、路由上线前执行（可做启动准备工作）。 */
    init?(ctx: ModuleInitContext): void | Promise<void>;
}
