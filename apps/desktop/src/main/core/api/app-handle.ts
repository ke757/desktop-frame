import type { AppEnv } from './env';
import type { EventPublisher } from './event-publisher';
import type { DeploymentReadiness } from './deployment';
import type { LifecycleView } from './lifecycle';
import type { Logger } from './logger';

/**
 * 应用能力句柄（模块作者公共 API）：内核能力（Logger/AppEnv/
 * EventPublisher/Lifecycle/Deployment）对业务接触点的统一窄公开面。
 * 模块 init/dispose、服务工厂、IPC handler 都经 `ctx.app` 协作应用宿主、
 * 经 `ctx.services` 获取业务服务——两条依赖通道。
 *
 * 它是 DesktopApp 签发并冻结的委托 facade（对齐 Tauri AppHandle 的角色），
 * 不是 Builder 组装的对象包、更不是 DesktopApp 本体：
 * - 生命周期只暴露只读视图（不能 transition/shutdown）；
 * - 部署只暴露就绪查询受众（不含 start/stop/restart 与批量编排）；
 * - 不暴露 ServiceContainer、IpcRouter、HostRuntime、WindowController；
 * - 业务需要的"退出应用"只有会进入优雅关停管线的 `quit()`（DesktopApp
 *   受控入口，不是 host.exit）。
 */
export interface AppHandle {
    /** 只读应用环境快照（build 期冻结；应用信息、路径、来源白名单等）。 */
    readonly env: Readonly<AppEnv>;
    /** 应用根日志能力（需要命名空间时用 `logger.child(tag)` 派生）。 */
    readonly logger: Logger;
    /** 向 renderer 发布类型化事件。 */
    readonly events: EventPublisher;
    /** 生命周期只读视图（当前状态、可等待、可订阅；不能迁移或关停）。 */
    readonly lifecycle: LifecycleView;
    /** 部署状态与就绪查询（DeploymentReadiness 受众；不含管理与批量编排）。 */
    readonly deployments: DeploymentReadiness;
    /** 请求退出应用：DesktopApp 受控入口，走 before-quit → 优雅关停管线。 */
    quit(): void;
}
