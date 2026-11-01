import { serviceToken } from './di';
import type { AppControl } from './app-control';
import type { AppEnv } from './env';
import type { EventPublisher } from './event-publisher';
import type { DeploymentAdmin, DeploymentReadiness } from './deployment';
import type { Logger } from './logger';

/**
 * 公开服务 token（builder.build 注册，业务模块经 `ctx.services.get` 或
 * 工厂依赖取用）。id 一律 `core.*` 命名空间，与业务模块的 `modules.*`
 * 区分。只收录向业务公开的窄能力；内部 token（进程宿主、部署控制面
 * controller）见 core/kernel/tokens.ts，不从 core 公共面导出。
 */

/** 环境信息（应用信息、dev server、路径、来源白名单等只读数据）。 */
export const envToken = serviceToken<AppEnv>('core.env');
/** 根 logger。 */
export const loggerToken = serviceToken<Logger>('core.logger');
/** main→renderer 事件发布器。 */
export const eventsToken = serviceToken<EventPublisher>('core.events');
/** 应用控制窄面（只提供会进入优雅关停的 quit，不提供 exit/宿主事件）。 */
export const appControlToken = serviceToken<AppControl>('core.appControl');
/** 部署控制面的就绪查询受众（外部服务适配层客户端用）。 */
export const deploymentReadinessToken = serviceToken<DeploymentReadiness>(
    'core.deployments.readiness',
);
/** 部署控制面的管理受众（deployments 管理模块用）。 */
export const deploymentAdminToken = serviceToken<DeploymentAdmin>(
    'core.deployments.admin',
);
