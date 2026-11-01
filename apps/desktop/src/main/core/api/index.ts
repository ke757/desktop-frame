/**
 * 模块作者公共 API 的二级 barrel：core/index.ts 只从这里再导出。
 * 本目录不得依赖 kernel/ipc/deployment 实现（守护测试固化）。
 */
export type {
    DisposableService,
    ServiceAccessor,
    ServiceFactory,
    ServiceRegistration,
    ServiceToken,
} from './di';
export { defineService, serviceToken } from './di';
export type { LogLevel, LogMeta, Logger } from './logger';
export type { AppEnv, RendererEntry } from './env';
export type { AppModule, ModuleDisposeContext, ModuleInitContext } from './module';
export type { HandlerContext, RouteHandler, RouteRegistrar } from './route-registrar';
export type { EventPublisher } from './event-publisher';
export type { LifecycleChange, LifecycleState, LifecycleView } from './lifecycle';
export type { AppControl } from './app-control';
export type {
    DeploymentChange,
    DeploymentHealthConfig,
    DeploymentMode,
    DeploymentOverride,
    DeploymentProfile,
    DeploymentSpec,
    DeploymentState,
    DeploymentStatus,
} from './deployment';
export {
    DeploymentError,
    DeploymentManagerClosedError,
    DeploymentNotReadyError,
    DeploymentStartFailedError,
    InvalidDeploymentError,
    UnknownDeploymentError,
    type DeploymentAdmin,
    type DeploymentReadiness,
} from './deployment';
export type {
    ExternalClientOptions,
    ExternalErrorCode,
    ExternalServiceClient,
} from './external-client';
export { ExternalServiceError, createExternalServiceClient } from './external-client';
export {
    appControlToken,
    deploymentAdminToken,
    deploymentReadinessToken,
    envToken,
    eventsToken,
    loggerToken,
} from './tokens';
