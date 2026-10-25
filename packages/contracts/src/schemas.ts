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
