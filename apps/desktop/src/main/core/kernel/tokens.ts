import { serviceToken } from '../api/di';
import type { DeploymentControlPlane } from '../deployment/controller';
import type { ProcessHost } from '../spi/process-host';

/**
 * 内核内部服务 token（builder.build 注册）。它们是实现细节：不从 core
 * 公共面导出，业务模块无法经公共 API 取得。向业务公开的窄能力 token 见
 * core/api/tokens.ts。
 */

/** 进程宿主 SPI 实例（部署控制面的容器工厂经 accessor 解析它）。 */
export const processHostToken = serviceToken<ProcessHost>('core.processHost');
/**
 * 部署控制面完整实例（controller/readiness/admin 三个受众接口载于同一
 * 对象、共享同一份状态）。公开面只经 readiness/admin 窄 token 分发。
 */
export const deploymentControlPlaneToken = serviceToken<DeploymentControlPlane>(
    'core.deployments.controlPlane',
);
