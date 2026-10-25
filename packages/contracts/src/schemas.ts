import { z } from 'zod';

/** 主进程后端的生命周期状态（见 desktop 端 core/lifecycle）。 */
export const LifecycleStateSchema = z.enum([
    'initializing',
    'ready',
    'shuttingDown',
    'exited',
]);
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;

/** 系统信息（system.getInfo 的输出）。 */
export const SystemInfoSchema = z.object({
    /** 应用名。 */
    appName: z.string(),
    /** 应用版本。 */
    appVersion: z.string(),
    /** Electron 版本。 */
    electron: z.string(),
    /** Chromium 版本。 */
    chrome: z.string(),
    /** 内嵌 Node 版本。 */
    node: z.string(),
    /** 操作系统平台（process.platform）。 */
    platform: z.string(),
    /** CPU 架构（process.arch）。 */
    arch: z.string(),
    /** 应用 locale。 */
    locale: z.string(),
    /** 是否为打包后的产物。 */
    isPackaged: z.boolean(),
});
export type SystemInfo = z.infer<typeof SystemInfoSchema>;

/** system.openFilePicker 的输入。 */
export const OpenDialogOptionsSchema = z.object({
    /** 对话框标题。 */
    title: z.string().optional(),
    /** 初始目录/默认文件名。 */
    defaultPath: z.string().optional(),
    /** 文件类型过滤器。 */
    filters: z
        .array(
            z.object({
                name: z.string(),
                extensions: z.array(z.string()),
            }),
        )
        .optional(),
    /** 是否允许多选（默认 false）。 */
    multiple: z.boolean().default(false),
});
export type OpenDialogOptions = z.input<typeof OpenDialogOptionsSchema>;

/** system.openFilePicker 的输出。 */
export const OpenDialogResultSchema = z.object({
    /** 用户是否取消。 */
    canceled: z.boolean(),
    /** 选中的文件路径列表。 */
    filePaths: z.array(z.string()),
});
export type OpenDialogResult = z.infer<typeof OpenDialogResultSchema>;

/**
 * 由主进程持久化的应用设置。默认值定义在 schema 中，
 * 保证两侧对完整的 `SettingsFile` 结构达成一致。
 */
export const SettingsFileSchema = z.object({
    /** 界面主题。 */
    theme: z.enum(['light', 'dark', 'system']).default('system'),
    /** 界面语言。 */
    locale: z.string().default('en-US'),
    /** 累计启动次数（每次启动自增）。 */
    launchCount: z.number().int().nonnegative().default(0),
});
export type SettingsFile = z.output<typeof SettingsFileSchema>;

/** 设置的部分更新补丁（settings.update 的输入）。 */
export const SettingsPatchSchema = SettingsFileSchema.partial();
export type SettingsPatch = z.input<typeof SettingsPatchSchema>;

/** app.lifecycleChanged 事件负载。 */
export const LifecycleChangedEventSchema = z.object({
    /** 迁移后的生命周期状态。 */
    state: LifecycleStateSchema,
    /** 迁移发生的时间戳（ms）。 */
    at: z.number(),
});

/** app.settingsChanged 事件负载。 */
export const SettingsChangedEventSchema = z.object({
    /** 变更后的完整设置。 */
    settings: SettingsFileSchema,
});

/**
 * 外部部署的运行状态（与 desktop 端 `core/ports/deployment.ts` 的
 * `DeploymentState` 平行定义；一致性由 desktop 侧测试守护）。
 */
export const DeploymentStateSchema = z.enum([
    /** 已注册（模块申报）但尚未启动。 */
    'registered',
    /** managed：进程已拉起，健康探测中。 */
    'starting',
    /** external：探测等待外部服务上线（dev 下等用户手动启动）。 */
    'waiting',
    /** 健康检查通过，可对外提供服务。 */
    'running',
    /** 停止流程进行中。 */
    'stopping',
    /** 已正常停止。 */
    'stopped',
    /** 启动失败（拉起失败或就绪超时）。 */
    'failed',
    /** 运行中意外退出。 */
    'crashed',
]);
export type DeploymentState = z.infer<typeof DeploymentStateSchema>;

/**
 * 部署运行模式：managed = 框架托管进程生命周期；external = 进程由外部
 * （开发者/运维）自行运行，框架只探测与连接。
 */
export const DeploymentModeSchema = z.enum(['managed', 'external']);
export type DeploymentMode = z.infer<typeof DeploymentModeSchema>;

/** 一个外部部署的当前状态快照（deployments.* 端点的输出项）。 */
export const DeploymentStatusSchema = z.object({
    /** 部署 id（即 DeploymentSpec.id）。 */
    id: z.string(),
    /** 当前运行状态。 */
    state: DeploymentStateSchema,
    /** 生效的运行模式（dev profile 覆盖后的）。 */
    mode: DeploymentModeSchema,
    /** 服务根地址（仅 origin）。 */
    baseUrl: z.string(),
    /** 托管进程 pid（external 模式或未拉起时为 null）。 */
    pid: z.number().int().positive().nullable(),
    /** 状态补充说明（失败原因、崩溃退出码等）。 */
    detail: z.string().optional(),
    /** 快照更新时间戳（ms）。 */
    updatedAt: z.number(),
});
export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;

/** deployments.start/stop/restart 的输入。 */
export const DeploymentIdSchema = z.object({
    /** 目标部署 id。 */
    id: z.string().min(1),
});
export type DeploymentId = z.input<typeof DeploymentIdSchema>;

/** app.deploymentChanged 事件负载。 */
export const DeploymentChangedEventSchema = z.object({
    /** 变更后的部署状态快照。 */
    deployment: DeploymentStatusSchema,
});

/** search.query 的输入。 */
export const SearchQuerySchema = z.object({
    /** 检索词。 */
    query: z.string().min(1),
});
export type SearchQuery = z.input<typeof SearchQuerySchema>;

/** 一条搜索命中（外部搜索服务的领域数据）。 */
export const SearchHitSchema = z.object({
    /** 命中条目的稳定 id。 */
    id: z.string(),
    /** 展示标题。 */
    title: z.string(),
    /** 相关度得分（0~1）。 */
    score: z.number(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

/** search.query 的输出。 */
export const SearchResponseSchema = z.object({
    /** 命中列表。 */
    hits: z.array(SearchHitSchema),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/** app.searchIndexChanged 事件负载（外部 WS 推送经适配层转发）。 */
export const SearchIndexChangedEventSchema = z.object({
    /** 外部报告的索引更新时间戳（ms）。 */
    at: z.number(),
});
