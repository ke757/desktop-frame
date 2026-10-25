import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { desktopApp } from '../src/app/core/builder';
import type { HostApp, BeforeQuitEvent } from '../src/app/core/host';
import type { IpcTransport, IpcListener, IpcCallInfo } from '../src/app/core/ipc/router';
import type { RpcResult } from '@desktop-frame/contracts';
import { MemoryLogger } from '../src/app/core/logging';
import type { WindowDefinition, WindowHost } from '../src/app/core/window';
import { settingsToken } from '../src/app/modules/settings/settings.service';
import { settingsModule } from '../src/app/modules/settings/settings.module';

/** HostApp 假实现：isPackaged=true 走 file 入口（跳过 dev server 等待）。 */
class FakeHost implements HostApp {
    readonly isPackaged = true;
    readonly whenReadyPromise: Promise<void>;
    exitCode: number | undefined;
    secondInstanceArgv: string[] = [];
    private readonly beforeQuitListeners: Array<(event: BeforeQuitEvent) => void> = [];
    private readonly windowAllClosedListeners: Array<() => void> = [];
    private readonly activateListeners: Array<() => void> = [];
    private readonly secondInstanceListeners: Array<(argv: string[]) => void> = [];
    private quitRequested = false;

    constructor(readonly userDataPath: string) {
        this.whenReadyPromise = Promise.resolve();
    }

    getName(): string {
        return 'fake-app';
    }

    getVersion(): string {
        return '0.0.0-test';
    }

    getLocale(): string {
        return 'en-US';
    }

    getPath(): string {
        return this.userDataPath;
    }

    whenReady(): Promise<void> {
        return this.whenReadyPromise;
    }

    /** 触发 before-quit 链（真实 electron 中 quit() 会先走该事件）。 */
    quit(): void {
        if (this.quitRequested) return;
        this.quitRequested = true;
        for (const listener of Array.from(this.beforeQuitListeners)) {
            listener({ preventDefault: () => {} });
        }
    }

    exit(code = 0): void {
        this.exitCode = code;
    }

    requestSingleInstanceLock(): boolean {
        return true;
    }

    onBeforeQuit(listener: (event: BeforeQuitEvent) => void): void {
        this.beforeQuitListeners.push(listener);
    }

    onWindowAllClosed(listener: () => void): void {
        this.windowAllClosedListeners.push(listener);
    }

    onActivate(listener: () => void): void {
        this.activateListeners.push(listener);
    }

    onSecondInstance(listener: (argv: string[]) => void): void {
        this.secondInstanceListeners.push(listener);
    }

    /** 测试辅助：模拟再次启动。 */
    emitSecondInstance(argv: string[]): void {
        for (const listener of this.secondInstanceListeners) listener(argv);
    }

    /** 测试辅助：模拟 Dock 激活。 */
    emitActivate(): void {
        for (const listener of this.activateListeners) listener();
    }
}

/** IpcTransport 假实现：捕获注册的 listener，可手动触发调用。 */
class FakeTransport implements IpcTransport {
    readonly listeners = new Map<string, IpcListener>();

    handle(channel: string, listener: IpcListener): void {
        this.listeners.set(channel, listener);
    }

    call(
        channel: string,
        payload: unknown,
        frameUrl = 'file:///app/index.html',
    ): Promise<RpcResult<unknown>> {
        const listener = this.listeners.get(channel);
        if (!listener) throw new Error(`no listener for ${channel}`);
        const info: IpcCallInfo = { webContentsId: 7, frameUrl };
        return listener(payload, info);
    }
}

/** WindowHost 假实现：记录调用，不触碰 electron。 */
class FakeWindowHost implements WindowHost {
    readonly registered: WindowDefinition[] = [];
    readonly opened: string[] = [];
    readonly sent: Array<{ channel: string; payload: unknown }> = [];
    focusPrimaryCalls = 0;
    closeAllCalls = 0;

    register(definition: WindowDefinition): void {
        this.registered.push(definition);
    }

    get primaryDefinitionId(): string | undefined {
        return this.registered.find((def) => def.isPrimary)?.id ?? this.registered[0]?.id;
    }

    async openWindow(definitionId: string): Promise<void> {
        this.opened.push(definitionId);
    }

    send(channel: string, payload: unknown): void {
        this.sent.push({ channel, payload });
    }

    focusPrimary(): void {
        this.focusPrimaryCalls += 1;
    }

    async openPrimaryIfNone(): Promise<void> {
        if (this.opened.length === 0 && this.primaryDefinitionId) {
            this.opened.push(this.primaryDefinitionId);
        }
    }

    closeAll(): void {
        this.closeAllCalls += 1;
    }
}

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'df-app-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs = [];
});

function makeApp(dir: string) {
    const host = new FakeHost(dir);
    const windows = new FakeWindowHost();
    const transport = new FakeTransport();
    const logger = new MemoryLogger();
    const app = desktopApp({
        host,
        transport,
        mainDir: dir,
        createWindows: () => windows,
        createLogger: () => logger,
    })
        .use(settingsModule)
        .window({ id: 'main', isPrimary: true, create: () => undefined })
        .build();
    return { app, host, windows, transport, logger };
}

describe('DesktopApp (builder 集成)', () => {
    it('build() 只装配不启动：核心对象图就绪，模块尚未注册、lifecycle 未动', () => {
        const { app } = makeApp('/tmp/unused');
        expect(app.lifecycle.state).toBe('initializing');
        // 模块服务/路由在 run() 才装配（build 不产生启动副作用）。
        expect(app.container.has(settingsToken)).toBe(false);
        expect(app.router.channels).toHaveLength(0);
    });

    it('run() 驱动完整启动：模块装配 -> ready -> 打开主窗口', async () => {
        const { app, windows, transport } = makeApp(await makeTempDir());
        const running = app.run();

        await app.lifecycle.when('ready');
        expect(app.router.channels).toContain('settings.getAll');
        expect(windows.opened).toEqual(['main']);
        // 生命周期变化已广播到窗口宿主。
        expect(windows.sent.map((entry) => entry.channel)).toContain(
            'app.lifecycleChanged',
        );

        // 路由已可用：通过 transport 直调 settings.getAll 走完整管线。
        const result = await transport.call('settings.getAll', undefined);
        expect(result).toMatchObject({
            ok: true,
            data: { theme: 'system', launchCount: 1 },
        });

        await app.quit();
        await running;
    });

    it('quit() 走关停管线：窗口先关、服务后 dispose、run() 在 exited 后 resolve', async () => {
        const dir = await makeTempDir();
        const { app, host, windows } = makeApp(dir);
        const running = app.run();
        await app.lifecycle.when('ready');

        const joinerOrder: string[] = [];
        app.lifecycle.onShutdown(() => {
            joinerOrder.push('late-joiner');
        });
        await app.quit();

        expect(app.lifecycle.state).toBe('exited');
        expect(windows.closeAllCalls).toBe(1);
        // settings dispose 已把 init 自增的 launchCount 落盘。
        const persisted = JSON.parse(
            await readFile(path.join(dir, 'settings.json'), 'utf8'),
        ) as { launchCount: number };
        expect(persisted.launchCount).toBe(1);
        expect(joinerOrder).toEqual(['late-joiner']);
        expect(host.exitCode).toBe(0);
        await running;
    });

    it('host 事件接线：second-instance 聚焦主窗口，activate 无窗重开', async () => {
        const { app, host, windows } = makeApp(await makeTempDir());
        const running = app.run();
        await app.lifecycle.when('ready');

        host.emitSecondInstance(['--foo']);
        expect(windows.focusPrimaryCalls).toBe(1);

        host.emitActivate();
        // FakeWindowHost 的 openPrimaryIfNone 在有窗口时是 no-op。
        expect(windows.opened).toEqual(['main']);

        await app.quit();
        await running;
    });
});
