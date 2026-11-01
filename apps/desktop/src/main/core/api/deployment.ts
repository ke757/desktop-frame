/**
 * 部署 API（模块作者公共面）：外部领域服务（独立可执行程序）接入框架的
 * 配置契约与按受众分离的控制面接口。
 *
 * 同一个控制面对象承载三个逻辑接口，按受众分发（实现见
 * core/deployment/manager.ts，完整类型见 core/deployment/controller.ts）：
 * - DeploymentReadiness：外部服务客户端（createExternalServiceClient）的
 *   查询与就绪面；
 * - DeploymentAdmin：deployments 管理模块的管理面（list/start/stop/restart）；
 * - DeploymentController：框架内部受众（register/startAll/stopAll），刻意
 *   不在本文件——它不从 core 公共面导出。
 *
 * 状态/快照的线上格式与 `@desktop-frame/contracts` 的 schema 平行定义
 * （同 LifecycleState 的既有惯例），一致性由 desktop 侧测试守护。
 */

/** 部署运行模式：managed = 框架托管进程；external = 外部自行运行、只连接。 */
export type DeploymentMode = 'managed' | 'external';

/** 健康探测配置（就绪判定：对 health.path 的请求返回 2xx）。 */
export interface DeploymentHealthConfig {
    /** 探测路径（相对 baseUrl 的 origin 的绝对路径，缺省 '/health'）。 */
    readonly path?: string;
    /** 探测轮询间隔（ms，缺省 500）。 */
    readonly intervalMs?: number;
    /** 单次探测超时（ms，缺省 2000）。 */
    readonly timeoutMs?: number;
}

/**
 * 一个外部部署的声明（当前版本硬编码为模块变量，经 AppModule.deployments
 * 申报给框架）。baseUrl 约定只含 origin（如 `http://127.0.0.1:7801`），
 * HTTP/WS 路径均为相对 origin 的绝对路径。
 */
export interface DeploymentSpec {
    /** 部署唯一 id（建议与领域服务同名，如 'search'）。 */
    readonly id: string;
    /** 运行模式（缺省 'managed'；dev profile 可覆盖为 'external'）。 */
    readonly mode?: DeploymentMode;
    /** 是否为应用启动的硬依赖（缺省 false）：required 部署启动失败会使 startAll reject、应用启动回滚；可选部署失败只记录状态、不阻止其余模块启动。 */
    readonly required?: boolean;
    /** 可执行文件（managed 模式必填；external 模式忽略）。 */
    readonly command?: string;
    /** 命令行参数。 */
    readonly args?: ReadonlyArray<string>;
    /** 工作目录。 */
    readonly cwd?: string;
    /** 附加环境变量（在继承主进程环境之上覆盖）。 */
    readonly env?: Readonly<Record<string, string>>;
    /** 服务根地址（仅 origin）。 */
    readonly baseUrl: string;
    /** 健康探测配置；false 表示不做探测（拉起即视为就绪）。 */
    readonly health?: DeploymentHealthConfig | false;
    /** managed 就绪等待上限（ms，缺省 15000；超时置 failed）。 */
    readonly readyTimeoutMs?: number;
    /** 优雅停止等待上限（ms，缺省 5000；超时升级 SIGKILL）。 */
    readonly stopTimeoutMs?: number;
}

/** profile 中对单个部署的覆盖项（浅合并到原 spec 之上，id 不可变）。 */
export type DeploymentOverride = Partial<Omit<DeploymentSpec, 'id'>>;

/** 部署 profile：按部署 id 索引的覆盖集合。仅在 dev（未打包）模式生效。 */
export type DeploymentProfile = Readonly<Record<string, DeploymentOverride>>;

/** 外部部署的运行状态（与 contracts 的 DeploymentStateSchema 平行定义）。 */
export type DeploymentState =
    | 'registered'
    | 'starting'
    | 'waiting'
    | 'running'
    | 'stopping'
    | 'stopped'
    | 'failed'
    | 'crashed';

/** 一个外部部署的状态快照。 */
export interface DeploymentStatus {
    /** 部署 id。 */
    readonly id: string;
    /** 当前运行状态。 */
    readonly state: DeploymentState;
    /** 生效的运行模式。 */
    readonly mode: DeploymentMode;
    /** 服务根地址（仅 origin）。 */
    readonly baseUrl: string;
    /** 托管进程 pid（external 模式或未拉起时为 null）。 */
    readonly pid: number | null;
    /** 状态补充说明（失败原因、崩溃退出码等）。 */
    readonly detail?: string;
    /** 快照更新时间戳（ms）。 */
    readonly updatedAt: number;
}

/** 一次部署状态迁移。 */
export interface DeploymentChange {
    /** 迁移前状态。 */
    readonly from: DeploymentState;
    /** 迁移后状态。 */
    readonly to: DeploymentState;
    /** 迁移后的完整快照。 */
    readonly status: DeploymentStatus;
}

/** 部署控制面错误基类。 */
export class DeploymentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DeploymentError';
    }
}

/** 请求了未注册的部署 id。 */
export class UnknownDeploymentError extends DeploymentError {}

/** 部署声明不合法（重复 id、managed 缺 command、baseUrl 非法等）。 */
export class InvalidDeploymentError extends DeploymentError {}

/** 部署未在期望时间内就绪（whenReady 超时或终态）。 */
export class DeploymentNotReadyError extends DeploymentError {}

/** 部署启动失败（托管拉起失败/就绪超时，或 required 部署令 startAll 整体失败）。 */
export class DeploymentStartFailedError extends DeploymentError {
    /** 启动失败的部署 id 集合。 */
    readonly deploymentIds: readonly string[];

    constructor(message: string, deploymentIds: readonly string[]) {
        super(message);
        this.name = 'DeploymentStartFailedError';
        this.deploymentIds = deploymentIds;
    }
}

/** 控制面已随应用关停关闭，不再接受启动类操作。 */
export class DeploymentManagerClosedError extends DeploymentError {}

/**
 * 部署控制面的就绪查询受众：外部服务适配层（createExternalServiceClient）
 * 经 `deploymentReadinessToken` 消费。注册与批量编排（register/startAll/
 * stopAll）与管理面（start/stop/restart）都不在此受众——权限按需分发。
 */
export interface DeploymentReadiness {
    /** 单个部署的状态快照；未知 id 返回 undefined。 */
    getStatus(id: string): DeploymentStatus | undefined;
    /** 等待部署就绪（running）；终态或超时 reject DeploymentNotReadyError。 */
    whenReady(id: string, timeoutMs?: number): Promise<void>;
    /** 订阅状态迁移；返回取消订阅函数。 */
    onChange(listener: (change: DeploymentChange) => void): () => void;
}

/**
 * 部署控制面的管理受众：deployments 管理模块经 `deploymentAdminToken`
 * 消费，供 renderer 的控制面面板使用。不含声明接管与批量编排。
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
