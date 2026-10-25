import { z } from 'zod';
import { event, procedure, voidInput } from './procedure';
import {
    DeploymentChangedEventSchema,
    DeploymentIdSchema,
    DeploymentStatusSchema,
    LifecycleChangedEventSchema,
    OpenDialogOptionsSchema,
    OpenDialogResultSchema,
    SearchIndexChangedEventSchema,
    SearchQuerySchema,
    SearchResponseSchema,
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
    /** 外部部署控制面端点。 */
    deployments: {
        /** 列出全部部署的当前状态快照。 */
        list: procedure('deployments.list', voidInput, z.array(DeploymentStatusSchema)),
        /** 启动指定部署（managed 拉起进程并等待就绪；external 重新挂探测）。 */
        start: procedure('deployments.start', DeploymentIdSchema, DeploymentStatusSchema),
        /** 停止指定部署（managed 走优雅终止；external 撤销探测）。 */
        stop: procedure('deployments.stop', DeploymentIdSchema, DeploymentStatusSchema),
        /** 重启指定部署（停止后重新启动）。 */
        restart: procedure(
            'deployments.restart',
            DeploymentIdSchema,
            DeploymentStatusSchema,
        ),
    },
    /** 搜索域服务端点（外部服务的适配层代理）。 */
    search: {
        /** 调用外部搜索服务。 */
        query: procedure('search.query', SearchQuerySchema, SearchResponseSchema),
    },
} as const;

/** main→renderer 事件定义。 */
export const appEvents = {
    /** 生命周期状态迁移广播。 */
    lifecycleChanged: event('app.lifecycleChanged', LifecycleChangedEventSchema),
    /** 设置变更广播。 */
    settingsChanged: event('app.settingsChanged', SettingsChangedEventSchema),
    /** 部署状态迁移广播（控制面）。 */
    deploymentChanged: event('app.deploymentChanged', DeploymentChangedEventSchema),
    /** 外部搜索索引更新（WS 推送经适配层转发）。 */
    searchIndexChanged: event('app.searchIndexChanged', SearchIndexChangedEventSchema),
} as const;
