import type {
    DeploymentAdmin,
    DeploymentReadiness,
    DeploymentSpec,
} from '../api/deployment';

/**
 * 部署控制面的框架内部受众：声明接管与批量编排。只由内核（builder 登记
 * 声明、DesktopApp 启动/关停时序）消费，不从 core 公共面导出——业务模块
 * 只能拿到 readiness/admin 窄接口（见 api/deployment.ts）。
 */
export interface DeploymentController {
    /** 注册一个部署声明（应用 profile 覆盖并校验）；重复 id 抛错。 */
    register(spec: DeploymentSpec): void;
    /**
     * 启动全部已注册部署：managed 并行拉起并等待就绪（或失败）；external
     * 只挂上探测循环立即返回。可选部署失败只记录状态；required 部署失败
     * 时 reject（应用启动进入统一回滚）。
     */
    startAll(): Promise<void>;
    /** 停止全部部署并关闭控制面（应用关停 joiner 的最后一段）。幂等。 */
    stopAll(): Promise<void>;
}

/**
 * 部署控制面完整类型：controller/readiness/admin 三个受众接口载于同一
 * 对象、共享同一份状态（容器内只有一个实例，readiness/admin token 都
 * 解析到它，不形成两套对象图）。
 */
export type DeploymentControlPlane = DeploymentController &
    DeploymentReadiness &
    DeploymentAdmin;
