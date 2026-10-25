import { serviceToken } from './core/container';
import type { EventPublisher } from './core/ipc/events';
import type { AppEnv } from './core/env';
import type { HostApp } from './core/host';
import type { LifecycleService } from './core/lifecycle';
import type { Logger } from './core/logging';
import type { WindowManager } from './windows/manager';

/**
 * 组合根注册的核心服务 token。业务模块通过 `ctx.services.get(...)`
 * 或工厂依赖获取它们。
 */
/** Electron app 的窄接口适配。 */
export const hostToken = serviceToken<HostApp>('core.host');
/** 环境信息服务。 */
export const envToken = serviceToken<AppEnv>('core.env');
/** 根 logger。 */
export const loggerToken = serviceToken<Logger>('core.logger');
/** 生命周期状态机。 */
export const lifecycleToken = serviceToken<LifecycleService>('core.lifecycle');
/** 事件发布器。 */
export const eventsToken = serviceToken<EventPublisher>('core.events');
/** 窗口管理器。 */
export const windowsToken = serviceToken<WindowManager>('core.windows');
