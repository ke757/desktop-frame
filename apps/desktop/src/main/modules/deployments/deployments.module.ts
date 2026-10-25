import { RpcError, contract } from '@desktop-frame/contracts';
import type { AppModule } from '../../core';
import { deploymentsToken } from '../../core';
import type { DeploymentStatus } from '../../core';
import {
    DeploymentError,
    DeploymentManagerClosedError,
    UnknownDeploymentError,
} from '../../core';

/**
 * deployments 模块：把控制面（DeploymentManager 的公开接口）暴露为类型化
 * RPC 端点——renderer 的服务状态面板、dev 下的手动 start/stop/restart 都
 * 走这里。纯路由模块（0 个服务），模式同 system 模块。
 */
export const deploymentsModule: AppModule = {
    id: 'deployments',

    registerRoutes(registrar) {
        registrar.handle(contract.deployments.list, async (ctx) => {
            const manager = await ctx.services.get(deploymentsToken);
            return manager.list();
        });

        registrar.handle(contract.deployments.start, async (ctx, input) => {
            const manager = await ctx.services.get(deploymentsToken);
            return translate(manager.start(input.id));
        });

        registrar.handle(contract.deployments.stop, async (ctx, input) => {
            const manager = await ctx.services.get(deploymentsToken);
            return translate(manager.stop(input.id));
        });

        registrar.handle(contract.deployments.restart, async (ctx, input) => {
            const manager = await ctx.services.get(deploymentsToken);
            return translate(manager.restart(input.id));
        });
    },
};

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
