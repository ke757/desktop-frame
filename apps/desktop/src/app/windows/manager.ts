import { BrowserWindow } from 'electron';
import type { AppEnv } from '../core/env';
import type { EventSink } from '../core/ipc/events';
import type { Logger } from '../core/logging';

/**
 * 声明式窗口配方。`create` 负责构造 BrowserWindow（安全偏好写在这里）；
 * 加载 renderer 入口、ready-to-show 后显示、跟踪与清理由管理器统一处理。
 */
export interface WindowDefinition {
    /** 窗口定义 id。 */
    readonly id: string;
    /** 是否主窗口（second-instance/activate 时聚焦/重开它）。 */
    readonly isPrimary?: boolean;
    /** 按环境构造 BrowserWindow。 */
    create(env: AppEnv): BrowserWindow;
}

/** 一个被管理窗口的运行时记录。 */
export interface ManagedWindow {
    /** 窗口定义 id。 */
    readonly definitionId: string;
    /** BrowserWindow 实例。 */
    readonly win: BrowserWindow;
    /** 创建时即缓存的 webContents id（destroyed 后不可再触碰 win.webContents）。 */
    readonly webContentsId: number;
}

/**
 * 窗口生命周期的唯一管理者：创建、跟踪、事件扇出与有序关闭。
 * 实现 EventSink，使类型化事件广播到每个存活的 renderer。
 */
export class WindowManager implements EventSink {
    private readonly definitions = new Map<string, WindowDefinition>();
    private readonly open = new Map<string, ManagedWindow>();

    constructor(
        private readonly env: AppEnv,
        private readonly logger: Logger,
    ) {}

    /** 注册窗口定义（id 重复抛错）。 */
    register(definition: WindowDefinition): void {
        if (this.definitions.has(definition.id)) {
            throw new Error(`window definition already registered: ${definition.id}`);
        }
        this.definitions.set(definition.id, definition);
    }

    /** 主窗口定义 id（显式标记优先，否则取首个注册项）。 */
    get primaryDefinitionId(): string | undefined {
        const definitions = [...this.definitions.values()];
        return definitions.find((def) => def.isPrimary)?.id ?? definitions[0]?.id;
    }

    /** 当前打开的窗口数。 */
    get size(): number {
        return this.open.size;
    }

    /** 打开（或聚焦已存在的）指定定义的窗口。 */
    async openWindow(definitionId: string): Promise<ManagedWindow> {
        const existing = this.open.get(definitionId);
        if (existing && !existing.win.isDestroyed()) {
            existing.win.focus();
            return existing;
        }
        const definition = this.definitions.get(definitionId);
        if (!definition) {
            throw new Error(`unknown window definition: ${definitionId}`);
        }

        const win = definition.create(this.env);
        const managed: ManagedWindow = {
            definitionId,
            win,
            // 教训（electron-trpc #156）：destroyed 之后访问 win.webContents 会抛
            // "Object has been destroyed"，因此创建时立即缓存 id。
            webContentsId: win.webContents.id,
        };
        win.once('ready-to-show', () => {
            if (!win.isDestroyed()) win.show();
        });
        win.on('closed', () => {
            this.open.delete(definitionId);
            this.logger.info('window closed', { window: definitionId });
        });
        win.webContents.on('render-process-gone', (_event, details) => {
            this.logger.error('renderer process gone', {
                window: definitionId,
                reason: details.reason,
            });
        });
        this.open.set(definitionId, managed);

        const entry = this.env.rendererEntry;
        try {
            if (entry.kind === 'url') {
                await win.loadURL(entry.url);
            } else {
                await win.loadFile(entry.path);
            }
        } catch (cause) {
            this.logger.error('failed to load renderer entry', {
                window: definitionId,
                entry,
                error: cause,
            });
        }
        this.logger.info('window opened', { window: definitionId });
        return managed;
    }

    /** 把事件负载广播给每个存活的 renderer。 */
    send(channel: string, payload: unknown): void {
        for (const managed of this.open.values()) {
            if (!managed.win.isDestroyed()) {
                managed.win.webContents.send(channel, payload);
            }
        }
    }

    /** 聚焦主窗口（second-instance 激活场景）。 */
    focusPrimary(): void {
        const id = this.primaryDefinitionId;
        const primary = id ? this.open.get(id) : undefined;
        if (primary && !primary.win.isDestroyed()) {
            if (primary.win.isMinimized()) primary.win.restore();
            primary.win.focus();
        }
    }

    /** 无存活窗口时重开主窗口（macOS activate 场景）。 */
    async openPrimaryIfNone(): Promise<void> {
        if (this.open.size > 0) return;
        const id = this.primaryDefinitionId;
        if (id) await this.openWindow(id);
    }

    /** 立即销毁全部窗口（关停路径）。 */
    closeAll(): void {
        // 拷贝快照：destroy() 会同步触发 'closed'，修改 this.open。
        const windows = Array.from(this.open.values());
        for (const managed of windows) {
            if (!managed.win.isDestroyed()) managed.win.destroy();
        }
        this.open.clear();
    }
}
