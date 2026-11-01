import { RpcError, contract } from '@desktop-frame/contracts';
import {
    DeploymentError,
    DeploymentManagerClosedError,
    UnknownDeploymentError,
} from '../api/deployment';
import type { DeploymentStatus } from '../api/deployment';
import type { DeploymentAdmin } from './controller';
import type { RouteRegistrar } from '../api/route-registrar';

/**
 * deployments 管理 RPC 的框架内置路由接线：由 DesktopApp 在构造期登记、
 * run 期随路由安装。直接消费内部 DeploymentAdmin——管理受众不进入
 * AppHandle，也不作为 token 公开，普通业务模块无法经公共面取得
 * （app.deployments 只是 DeploymentReadiness）。
 *
 * channel、输入输出与错误翻译（未知 id → NOT_FOUND、控制面已关闭 →
 * UNAVAILABLE、其余部署错误 → DEPLOYMENT_ERROR）与原业务模块保持一致，
 * renderer 行为不变。
 */

/** 把控制面 Promise 的失败翻译为类型化 RPC 错误信封。 */
async function translate(status: Promise<DeploymentStatus>): Promise<DeploymentStatus> {
    try {
        return await status;
    } catch (cause) {
        if (cause instanceof UnknownDeploymentError) {
            throw new RpcError('NOT_FOUND', cause.message);
        }
        if (cause instanceof DeploymentManagerClosedError) {
            throw new RpcError('UNAVAILABLE', cause.message);
        }
        if (cause instanceof DeploymentError) {
            throw new RpcError('DEPLOYMENT_ERROR', cause.message);
        }
        throw cause;
    }
}

/** 在路由上登记 deployments.list/start/stop/restart 内置端点（build 期调用）。 */
export function registerDeploymentAdminRoutes(
    registrar: RouteRegistrar,
    admin: DeploymentAdmin,
): void {
    registrar.handle(contract.deployments.list, async () => admin.list());
    registrar.handle(contract.deployments.start, (_ctx, input) =>
        translate(admin.start(input.id)),
    );
    registrar.handle(contract.deployments.stop, (_ctx, input) =>
        translate(admin.stop(input.id)),
    );
    registrar.handle(contract.deployments.restart, (_ctx, input) =>
        translate(admin.restart(input.id)),
    );
}
