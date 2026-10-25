/**
 * 部署端口：外部领域服务（独立可执行程序）接入框架的配置契约与控制面
 * 公开接口。配置类型（DeploymentSpec/DeploymentProfile）由业务模块申报、
 * 框架消费；DeploymentManager 是控制面的公开面（token 的类型参数，实现见
 * core/deployment/manager.ts 的 DeploymentManagerImpl）。
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

/** 控制面已随应用关停关闭，不再接受启动类操作。 */
export class DeploymentManagerClosedError extends DeploymentError {}

/**
 * 部署控制面的公开接口：业务模块经 `deploymentsToken` 消费。框架内部的
 * 注册与批量编排（register/startAll/stopAll）刻意不在此面——它们由
 * DesktopApp 在启动/关停时序中独占调用（受众分离，同 DisposableService）。
 */
export interface DeploymentManager {
    /** 全部部署的状态快照（按注册顺序）。 */
    list(): DeploymentStatus[];
    /** 单个部署的状态快照；未知 id 返回 undefined。 */
    getStatus(id: string): DeploymentStatus | undefined;
    /** 启动部署并返回快照（managed 等待就绪或失败；external 立即返回 waiting）。 */
    start(id: string): Promise<DeploymentStatus>;
    /** 停止部署并返回快照（managed 优雅终止；external 撤销探测）。 */
    stop(id: string): Promise<DeploymentStatus>;
    /** 重启部署（停止后重新启动）并返回快照。 */
    restart(id: string): Promise<DeploymentStatus>;
    /** 等待部署就绪（running）；终态或超时 reject DeploymentNotReadyError。 */
    whenReady(id: string, timeoutMs?: number): Promise<void>;
    /** 订阅状态迁移；返回取消订阅函数。 */
    onChange(listener: (change: DeploymentChange) => void): () => void;
}
