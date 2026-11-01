import { RpcError, contract } from '@desktop-frame/contracts';
import type { AppModule, DeploymentStatus } from '../../core';
import { deploymentAdminToken } from '../../core';
import {
    DeploymentError,
    DeploymentManagerClosedError,
    UnknownDeploymentError,
} from '../../core';

/**
 * deployments 模块：把控制面的管理受众（DeploymentAdmin：list/start/
 * stop/restart）暴露为类型化 RPC 端点——renderer 的服务状态面板、dev 下
 * 的手动操作都走这里。就绪查询受众（DeploymentReadiness）供外部服务
 * 客户端使用；批量编排（register/startAll/stopAll）是框架内部受众，
 * 两者都不经本模块暴露。纯路由模块（0 个服务），模式同 system 模块。
 */
export const deploymentsModule: AppModule = {
    id: 'deployments',

    registerRoutes(registrar) {
        registrar.handle(contract.deployments.list, async (ctx) => {
            const admin = await ctx.services.get(deploymentAdminToken);
            return admin.list();
        });

        registrar.handle(contract.deployments.start, async (ctx, input) => {
            const admin = await ctx.services.get(deploymentAdminToken);
            return translate(admin.start(input.id));
        });

        registrar.handle(contract.deployments.stop, async (ctx, input) => {
            const admin = await ctx.services.get(deploymentAdminToken);
            return translate(admin.stop(input.id));
        });

        registrar.handle(contract.deployments.restart, async (ctx, input) => {
            const admin = await ctx.services.get(deploymentAdminToken);
            return translate(admin.restart(input.id));
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
