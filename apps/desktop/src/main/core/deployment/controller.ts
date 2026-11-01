import type {
    DeploymentReadiness,
    DeploymentSpec,
    DeploymentStatus,
} from '../api/deployment';

/**
 * 部署控制面的框架内部受众：声明接管与批量编排。只由内核（builder 登记
 * 声明、DesktopApp 启动/关停时序）消费，不从 core 公共面导出——业务接触点
 * 只能拿到 AppHandle 里的 Readiness 窄面。
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
 * 部署控制面的管理受众：deployments 管理 RPC（list/start/stop/restart）
 * 的消费面，供 renderer 的控制面面板使用。不含声明接管与批量编排。
 * 管理端点是框架内置路由（core/deployment/admin-routes.ts，DesktopApp 接线）
 * ——本类型只在该接线内部使用，不进入 AppHandle，也不作为 token 公开。
 */
export interface DeploymentAdmin {
    /** 全部部署的状态快照（按注册顺序）。 */
    list(): DeploymentStatus[];
    /** 启动部署并返回快照（managed 等待就绪或失败；external 立即返回 waiting）。 */
    start(id: string): Promise<DeploymentStatus>;
    /** 停止部署并返回快照（managed 优雅终止；external 撤销探测）。 */
    stop(id: string): Promise<DeploymentStatus>;
    /** 重启部署（停止后重新启动）并返回快照。 */
    restart(id: string): Promise<DeploymentStatus>;
}

/**
 * 部署控制面完整类型：controller/readiness/admin 三个受众接口载于同一
 * 对象、共享同一份状态（内核直接构造的唯一实例，按受众分发窄接口，
 * 不形成两套对象图）。
 */
export type DeploymentControlPlane = DeploymentController &
    DeploymentReadiness &
    DeploymentAdmin;
