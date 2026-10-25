import { z } from 'zod';
import { event, procedure, voidInput } from './procedure';
import {
    LifecycleChangedEventSchema,
    OpenDialogOptionsSchema,
    OpenDialogResultSchema,
    SettingsChangedEventSchema,
    SettingsFileSchema,
    SettingsPatchSchema,
    SystemInfoSchema,
} from './schemas';

/**
 * 应用 RPC 面。此处是唯一事实源：main（注册 handler）、preload（无需改动）、
 * web（类型化 client）三侧都由它派生。
 */
export const contract = {
    /** 系统相关端点。 */
    system: {
        /** 获取系统与应用信息。 */
        getInfo: procedure('system.getInfo', voidInput, SystemInfoSchema),
        /** 打开文件选择对话框。 */
        openFilePicker: procedure(
            'system.openFilePicker',
            OpenDialogOptionsSchema,
            OpenDialogResultSchema,
        ),
        /** 原样回显消息（链路自检用）。 */
        echo: procedure(
            'system.echo',
            z.object({ message: z.string() }),
            z.object({ message: z.string() }),
        ),
        /** 必定失败：用于端到端演示错误信封。 */
        failWith: procedure(
            'system.failWith',
            z.object({ code: z.string().optional() }),
            z.unknown(),
        ),
        /** 请求应用退出（走优雅关停管线）。 */
        quit: procedure('system.quit', voidInput, voidInput),
    },
    /** 设置相关端点。 */
    settings: {
        /** 读取完整设置。 */
        getAll: procedure('settings.getAll', voidInput, SettingsFileSchema),
        /** 应用部分更新并返回更新后的完整设置。 */
        update: procedure('settings.update', SettingsPatchSchema, SettingsFileSchema),
    },
} as const;

/** main→renderer 事件定义。 */
export const appEvents = {
    /** 生命周期状态迁移广播。 */
    lifecycleChanged: event('app.lifecycleChanged', LifecycleChangedEventSchema),
    /** 设置变更广播。 */
    settingsChanged: event('app.settingsChanged', SettingsChangedEventSchema),
} as const;
