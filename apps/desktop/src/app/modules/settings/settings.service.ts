import { rename, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
    SettingsFileSchema,
    appEvents,
    type SettingsFile,
    type SettingsPatch,
} from '@desktop-frame/contracts';
import {
    defineService,
    serviceToken,
    type DisposableService,
} from '../../core/container';
import type { EventPublisher } from '../../core/ipc/events';
import type { Logger } from '../../core/logging';
import { envToken, eventsToken, loggerToken } from '../../core/tokens';

/** 防抖落盘间隔（ms）。 */
const FLUSH_DEBOUNCE_MS = 500;

/**
 * 设置服务的**公开接口**：token 的类型参数，即模块外允许调用的全部
 * 方法。生命周期方法（load/flush/dispose）刻意不在其中——dispose 是
 * 框架钩子（DisposableService），只由容器在关停时调用。
 */
export interface SettingsService {
    /** 读取当前完整设置（schema 默认值已填充）。 */
    get(): SettingsFile;
    /** 合并补丁、广播变更事件并安排防抖落盘；返回更新后的完整设置。 */
    update(patch: SettingsPatch): SettingsFile;
}

/** 设置服务的服务 token（类型即公开接口）。 */
export const settingsToken = serviceToken<SettingsService>('modules.settings');

/**
 * 设置服务实现：类型化 JSON 持久化 + 防抖原子写 + dispose 兜底落盘——
 * 一个同时具有异步启动（load）与关停（flush/dispose）工作的服务的标准
 * 范例。实现细节对模块外不可见（跨模块只允许 import *.service.ts 中
 * 的接口与 token）。
 */
export class SettingsServiceImpl implements SettingsService, DisposableService {
    private data: SettingsFile = SettingsFileSchema.parse({});
    private dirty = false;
    private flushTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly filePath: string,
        private readonly logger: Logger,
        private readonly events: EventPublisher,
    ) {}

    /** 当前完整设置（schema 默认值已填充）。 */
    get(): SettingsFile {
        return this.data;
    }

    /** 合并补丁、广播变更事件并安排防抖落盘；返回更新后的完整设置。 */
    update(patch: SettingsPatch): SettingsFile {
        this.data = SettingsFileSchema.parse({ ...this.data, ...patch });
        this.dirty = true;
        this.scheduleFlush();
        this.events.publish(appEvents.settingsChanged, { settings: this.data });
        return this.data;
    }

    /** 从磁盘加载并校验设置；文件缺失/损坏时保持默认值。 */
    async load(): Promise<void> {
        let raw: unknown;
        try {
            raw = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
        } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.logger.warn('settings file unreadable; using defaults', {
                    error: cause,
                });
            }
            return;
        }
        const parsed = SettingsFileSchema.safeParse(raw);
        if (parsed.success) {
            this.data = parsed.data;
        } else {
            this.logger.warn('settings file invalid; using defaults', {
                filePath: this.filePath,
            });
        }
    }

    /** 有脏数据时原子落盘（写临时文件后 rename）。 */
    async flush(): Promise<void> {
        if (!this.dirty) return;
        this.dirty = false;
        const tmp = `${this.filePath}.${process.pid}.tmp`;
        await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
        await rename(tmp, this.filePath);
    }

    /** 框架钩子（DisposableService）：取消挂起的防抖并立即落盘。 */
    async dispose(): Promise<void> {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
        await this.flush();
    }

    /** 安排一次防抖落盘（unref，不阻止进程退出）。 */
    private scheduleFlush(): void {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            this.flush().catch((cause) => {
                this.logger.error('settings flush failed', { error: cause });
            });
        }, FLUSH_DEBOUNCE_MS);
        this.flushTimer.unref();
    }
}

/** 设置服务的注册定义：组装依赖并在工厂内完成异步加载。 */
export const settingsService = defineService(settingsToken, async (accessor) => {
    const env = await accessor.get(envToken);
    const logger = await accessor.get(loggerToken);
    const events = await accessor.get(eventsToken);
    const impl = new SettingsServiceImpl(
        path.join(env.userDataPath, 'settings.json'),
        logger.child('settings'),
        events,
    );
    await impl.load();
    return impl;
});
