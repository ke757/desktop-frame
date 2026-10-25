import { serviceToken } from './container';
import type { EventPublisher } from './ports/event-publisher';
import type { AppEnv } from './ports/env';
import type { HostApp } from './ports/host';
import type { DeploymentManager } from './ports/deployment';
import type { Lifecycle } from './lifecycle';
import type { Logger } from './ports/logger';
import type { WindowHost } from './ports/window-host';

/**
 * builder.build 注册的核心服务 token——全部是 DesktopApp 的"部件"，
 * DesktopApp 本身不在此列（组合根不是自己的服务节点）。业务模块通过
 * `ctx.services.get(...)` 或工厂依赖获取它们；id 一律 `core.*` 命名空间，
 * 与业务模块的 `modules.*` 区分。
 */
/** Electron app 的窄接口适配（退出/路径/locale 等应用级能力都在它上面）。 */
export const hostToken = serviceToken<HostApp>('core.host');
/** 环境信息（dev server、路径、来源白名单等）。 */
export const envToken = serviceToken<AppEnv>('core.env');
/** 根 logger。 */
export const loggerToken = serviceToken<Logger>('core.logger');
/** 生命周期状态机。 */
export const lifecycleToken = serviceToken<Lifecycle>('core.lifecycle');
/** main→renderer 事件发布器。 */
export const eventsToken = serviceToken<EventPublisher>('core.events');
/** 窗口宿主（Electron 下为 WindowManager）。 */
export const windowsToken = serviceToken<WindowHost>('core.windows');
/** 外部部署控制面（DeploymentManager 公开接口，见 ports/deployment）。 */
export const deploymentsToken = serviceToken<DeploymentManager>('core.deployments');
