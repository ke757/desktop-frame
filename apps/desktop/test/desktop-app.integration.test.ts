import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { procedure, type RpcResult } from '@desktop-frame/contracts';
import { desktopApp } from '../src/main/core/kernel/builder';
import { UnknownServiceError } from '../src/main/core/kernel/container';
import type { BeforeQuitEvent, HostRuntime } from '../src/main/core/spi/host';
import type {
    IpcTransport,
    IpcListener,
    IpcCallInfo,
} from '../src/main/core/spi/ipc-transport';
import type { WindowController, WindowDefinition } from '../src/main/core/spi/window';
import { MemoryLogger } from '../src/main/core/kernel/logging';
import {
    defineService,
    DeploymentStartFailedError,
    InvalidDeploymentError,
    serviceToken,
    type AppHandle,
    type AppModule,
    type DeploymentChange,
} from '../src/main/core';
import { settingsModule } from '../src/main/modules/settings/settings.module';
import { FakeProcessHost, startHealthServer } from './fakes';

/**
 * DesktopApp 集成测试：经内核 builder 注入 Fake runtime，只通过公开面
 * （run/quit/logger/只读 lifecycle）与 IPC 行为验证——不为测试重新开放
 * 内部控制面。覆盖：build 纯声明校验（含无效部署 spec 在 build 失败）、
 * run 启动时序、正常退出、ctx.app 受限能力、部署受众与内置管理路由、
 * 模块 init 失败回滚、required 部署失败回滚。
 */

/** 测试用 echo procedure（channel 冲突用例也复用它）。 */
const echo = procedure(
    't.echo',
    z.object({ message: z.string() }),
    z.object({ message: z.string() }),
);

/** HostRuntime 假实现：isPackaged=true 走 file 入口（跳过 dev server 等待）。 */
class FakeHost implements HostRuntime {
    readonly isPackaged = true;
    readonly whenReadyPromise: Promise<void>;
    exitCode: number | undefined;
    /** host.quit() 被调用的次数（受控退出入口的 no-op 验证用）。 */
    quitCalls = 0;
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
        this.quitCalls += 1;
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

/** WindowController 假实现：记录调用，不触碰 electron。 */
class FakeWindowController implements WindowController {
    readonly registered: WindowDefinition[] = [];
    readonly opened: string[] = [];
    readonly sent: Array<{ channel: string; payload: unknown }> = [];
    focusPrimaryCalls = 0;
    closeAllCalls = 0;

    register(definition: WindowDefinition): void {
        if (this.registered.some((def) => def.id === definition.id)) {
            throw new Error(`window definition already registered: ${definition.id}`);
        }
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

/** 一套完整的 Fake 装配（builder 选项 + 全部替身）。 */
function makeHarness(dir: string, modules: AppModule[] = []) {
    const host = new FakeHost(dir);
    const windows = new FakeWindowController();
    const transport = new FakeTransport();
    const logger = new MemoryLogger();
    const processHost = new FakeProcessHost();
    const builder = desktopApp({
        host,
        transport,
        mainDir: dir,
        createWindows: () => windows,
        createLogger: () => logger,
        processHost,
    })
        .use(...modules)
        .window({ id: 'main', isPrimary: true, create: () => undefined });
    return { builder, host, windows, transport, logger, processHost };
}

describe('DesktopApp（build 纯声明装配）', () => {
    it('build() 只装配不启动：无模块 init、transport 未安装、无窗口与进程副作用', async () => {
        const initCalls: string[] = [];
        const spyModule: AppModule = {
            id: 'spy',
            registerRoutes(registrar) {
                registrar.handle(echo, () => ({ message: 'x' }));
            },
            async init() {
                initCalls.push('spy');
            },
        };
        const { builder, transport, windows, processHost } = makeHarness('/tmp/unused', [
            spyModule,
        ]);
        const app = builder.build();

        expect(app.lifecycle.state).toBe('initializing');
        expect(initCalls).toEqual([]);
        // 路由声明已在 build 期登记，但 transport（ipcMain 绑定）未安装。
        expect(transport.listeners.size).toBe(0);
        expect(windows.opened).toEqual([]);
        expect(processHost.spawns).toEqual([]);
    });

    it('build() 校验重复模块 id / 服务 token / 部署 id', () => {
        const token = serviceToken('dup-token');
        const dupTokenModuleA: AppModule = {
            id: 'a',
            services: [defineService(token, () => ({}))],
        };
        const dupTokenModuleB: AppModule = {
            id: 'b',
            services: [defineService(token, () => ({}))],
        };
        const dupIdA: AppModule = { id: 'same' };
        const dupIdB: AppModule = { id: 'same' };
        const dupDepA: AppModule = {
            id: 'dep-a',
            deployments: [{ id: 'dup-dep', command: 'x', baseUrl: 'http://127.0.0.1:1' }],
        };
        const dupDepB: AppModule = {
            id: 'dep-b',
            deployments: [{ id: 'dup-dep', command: 'x', baseUrl: 'http://127.0.0.1:1' }],
        };

        expect(() => makeHarness('/tmp/u1').builder.use(dupIdA, dupIdB).build()).toThrow(
            /duplicate module id/,
        );
        expect(() =>
            makeHarness('/tmp/u2').builder.use(dupTokenModuleA, dupTokenModuleB).build(),
        ).toThrow(/already registered/);
        expect(() =>
            makeHarness('/tmp/u3').builder.use(dupDepA, dupDepB).build(),
        ).toThrow(/duplicate deployment id/);
    });

    it('build() 校验重复窗口 id 与重复 IPC channel', () => {
        const chanA: AppModule = {
            id: 'chan-a',
            registerRoutes(registrar) {
                registrar.handle(echo, () => ({ message: 'a' }));
            },
        };
        const chanB: AppModule = {
            id: 'chan-b',
            registerRoutes(registrar) {
                registrar.handle(echo, () => ({ message: 'b' }));
            },
        };
        expect(() => makeHarness('/tmp/u4').builder.use(chanA, chanB).build()).toThrow(
            /already handled/,
        );
        expect(() =>
            makeHarness('/tmp/u5')
                .builder.window({ id: 'extra', create: () => undefined })
                .window({ id: 'extra', create: () => undefined })
                .build(),
        ).toThrow(/already registered/);
    });

    it('纯声明冲突先于启动副作用：路由冲突时进程/窗口/transport 均未触碰', () => {
        const withDeployment: AppModule = {
            id: 'deploying',
            deployments: [{ id: 'svc', command: 'x', baseUrl: 'http://127.0.0.1:1' }],
            registerRoutes(registrar) {
                registrar.handle(echo, () => ({ message: 'x' }));
            },
        };
        const conflicting: AppModule = {
            id: 'conflicting',
            registerRoutes(registrar) {
                registrar.handle(echo, () => ({ message: 'y' }));
            },
        };
        const { builder, processHost, windows, transport } = makeHarness('/tmp/u6', [
            withDeployment,
            conflicting,
        ]);
        expect(() => builder.build()).toThrow(/already handled/);
        // build 是同步纯声明阶段：任何启动副作用都不会发生。
        expect(processHost.spawns).toEqual([]);
        expect(windows.opened).toEqual([]);
        expect(transport.listeners.size).toBe(0);
    });

    it('无效 DeploymentSpec 在 build 期失败：字段校验同步抛错且无任何 run 副作用', () => {
        const badSpecModule: AppModule = {
            id: 'bad-spec',
            deployments: [{ id: 'bad-svc', command: 'x', baseUrl: 'not-a-url' }],
        };
        const { builder, processHost, windows, transport } = makeHarness('/tmp/u7', [
            badSpecModule,
        ]);
        // spec 登记在 build 期完成，字段合法性同步校验（不需要等到 run）。
        expect(() => builder.build()).toThrow(InvalidDeploymentError);
        expect(processHost.spawns).toEqual([]);
        expect(windows.opened).toEqual([]);
        expect(transport.listeners.size).toBe(0);
    });
});

describe('DesktopApp（run 启动时序与正常退出）', () => {
    it('run() 驱动完整启动：模块 init -> 路由上线 -> ready -> 打开主窗口', async () => {
        const dir = await makeTempDir();
        const { builder, transport, windows } = makeHarness(dir, [settingsModule]);
        const app = builder.build();
        const running = app.run();

        await app.lifecycle.when('ready');
        // 路由已上线：通过 transport 直调 settings.getAll 走完整管线。
        const result = await transport.call('settings.getAll', undefined);
        expect(result).toMatchObject({
            ok: true,
            data: { theme: 'system', launchCount: 1 },
        });
        expect(windows.opened).toEqual(['main']);
        // 生命周期变化已广播到窗口宿主。
        expect(windows.sent.map((entry) => entry.channel)).toContain(
            'app.lifecycleChanged',
        );

        await app.quit();
        await running;
    });

    it('quit() 走关停管线：窗口先关、服务落盘、host.exit(0)、run() 在 exited 后 resolve', async () => {
        const dir = await makeTempDir();
        const { builder, host, windows } = makeHarness(dir, [settingsModule]);
        const app = builder.build();
        const running = app.run();
        await app.lifecycle.when('ready');

        await app.quit();

        expect(app.lifecycle.state).toBe('exited');
        expect(windows.closeAllCalls).toBe(1);
        // settings dispose 已把 init 自增的 launchCount 落盘。
        const persisted = JSON.parse(
            await readFile(path.join(dir, 'settings.json'), 'utf8'),
        ) as { launchCount: number };
        expect(persisted.launchCount).toBe(1);
        expect(host.exitCode).toBe(0);
        await running;
    });

    it('host 事件接线：second-instance 聚焦主窗口，activate 无窗重开', async () => {
        const dir = await makeTempDir();
        const { builder, host, windows } = makeHarness(dir, [settingsModule]);
        const app = builder.build();
        const running = app.run();
        await app.lifecycle.when('ready');

        host.emitSecondInstance(['--foo']);
        expect(windows.focusPrimaryCalls).toBe(1);

        host.emitActivate();
        // FakeWindowController 的 openPrimaryIfNone 在有窗口时是 no-op。
        expect(windows.opened).toEqual(['main']);

        await app.quit();
        await running;
    });

    it('模块 dispose 拿到与 init 对称的上下文：可解析服务且此刻服务尚未 dispose', async () => {
        const dir = await makeTempDir();
        const order: string[] = [];
        let instance: { dispose(): void } | undefined;
        const svcToken = serviceToken<{ dispose(): void }>('modules.dispose-demo');
        const demoModule: AppModule = {
            id: 'dispose-demo',
            services: [
                defineService(svcToken, () => {
                    const inst = {
                        dispose: () => {
                            order.push('service-disposed');
                        },
                    };
                    instance = inst;
                    return inst;
                }),
            ],
            async init(ctx) {
                await ctx.services.get(svcToken);
            },
            async dispose(ctx) {
                // 与 init 同形的受限上下文：dispose 内仍可解析服务，且解析
                // 到的是同一实例（容器尚未释放、服务尚未 dispose）。
                const svc = await ctx.services.get(svcToken);
                order.push(
                    svc === instance ? 'dispose-resolved-same' : 'dispose-resolved-wrong',
                );
            },
        };
        const { builder } = makeHarness(dir, [demoModule]);
        const app = builder.build();
        const running = app.run();
        await app.lifecycle.when('ready');

        await app.quit();
        await running;
        // 关停顺序：模块逆序 dispose（内可解析服务）先于容器服务 dispose。
        expect(order).toEqual(['dispose-resolved-same', 'service-disposed']);
    });

    it('模块 init 经 ctx.app 使用内核能力：env/logger/events/lifecycle/readiness 同源', async () => {
        const dir = await makeTempDir();
        const probeModule: AppModule = {
            id: 'ctx-probe',
            async init(ctx) {
                // ctx.app 是受限门面（不是 DesktopApp）：组合根/容器/路由
                // 等内核内部部件不出现在公共面上。
                const appKeys = Object.keys(ctx.app).sort();
                expect(appKeys).toEqual([
                    'deployments',
                    'env',
                    'events',
                    'lifecycle',
                    'logger',
                    'quit',
                ]);
                // env：只读环境数据可达。
                expect(ctx.app.env.appName).toBe('fake-app');
                // logger：可写日志。
                ctx.app.logger.info('probe via ctx.app.logger');
                // events：可发布事件（经窗口宿主扇出可观察）。
                ctx.app.events.publish(ctxProbeEvent(), { at: 1 });
                // lifecycle：只读视图，状态与 app.lifecycle 同步。
                expect(ctx.app.lifecycle.state).toBe('initializing');
                // deployments：就绪查询受众可达（可订阅/查询）。
                const off = ctx.app.deployments.onChange(() => {});
                off();
                expect(ctx.app.deployments.getStatus('ghost')).toBeUndefined();
                // 内核能力不在容器注册表：core.* 形状 token 不可解析。
                await expect(
                    ctx.services.get(serviceToken('core.env')),
                ).rejects.toBeInstanceOf(UnknownServiceError);
            },
        };
        const { builder, logger, windows } = makeHarness(dir, [probeModule]);
        const app = builder.build();
        const running = app.run();
        await app.lifecycle.when('ready');

        // init 期间发布的事件经 ctx.app.events 真实到达窗口宿主。
        expect(windows.sent.some((entry) => entry.channel === 'app.ctxProbe')).toBe(true);
        expect(
            logger.entries.some((entry) => entry.message === 'probe via ctx.app.logger'),
        ).toBe(true);
        // 模块接触点的 lifecycle 视图与进程壳看到的是同一个状态机。
        expect(app.lifecycle.state).toBe('ready');

        await app.quit();
        await running;
    });

    it('ctx.app 是冻结的委托句柄：模块拿不到 Lifecycle/DeploymentManager 运行时本体', async () => {
        const dir = await makeTempDir();
        let seen: AppHandle | undefined;
        const probeModule: AppModule = {
            id: 'handle-probe',
            async init(ctx) {
                seen = ctx.app;
            },
        };
        const { builder } = makeHarness(dir, [probeModule]);
        const app = builder.build();
        const running = app.run();
        await app.lifecycle.when('ready');
        expect(seen).toBeDefined();

        const handle = seen as AppHandle;
        // 句柄本身冻结：能力面不可被模块替换。
        expect(Object.isFrozen(handle)).toBe(true);
        // 生命周期运行时窄面：完整 Lifecycle 的迁移/关停方法不在对象上。
        for (const method of ['transition', 'shutdown', 'onShutdown']) {
            expect(method in handle.lifecycle).toBe(false);
        }
        // 部署运行时窄面：Admin/Controller 方法不在对象上（Readiness 受众）。
        for (const method of [
            'start',
            'stop',
            'restart',
            'list',
            'register',
            'startAll',
            'stopAll',
        ]) {
            expect(method in handle.deployments).toBe(false);
        }

        await app.quit();
        await running;
    });

    it('ctx.app.env 是冻结快照：修改内核环境数据被拒绝且不影响原值', async () => {
        const dir = await makeTempDir();
        let appName = '';
        const probeModule: AppModule = {
            id: 'env-freeze-probe',
            async init(ctx) {
                appName = ctx.app.env.appName;
                expect(Object.isFrozen(ctx.app.env)).toBe(true);
                expect(Object.isFrozen(ctx.app.env.rendererEntry)).toBe(true);
                expect(Object.isFrozen(ctx.app.env.allowedFrameOrigins)).toBe(true);
                // ESM 严格模式下对冻结对象赋值抛 TypeError。
                const mutableEnv = ctx.app.env as unknown as { appName: string };
                expect(() => {
                    mutableEnv.appName = 'hijacked';
                }).toThrow(TypeError);
            },
        };
        const { builder } = makeHarness(dir, [probeModule]);
        const app = builder.build();
        const running = app.run();
        await app.lifecycle.when('ready');

        expect(appName).toBe('fake-app');
        await app.quit();
        await running;
    });

    it('ctx.app.quit 走 DesktopApp 受控入口：关停后重复调用是 no-op', async () => {
        const dir = await makeTempDir();
        let quit: (() => void) | undefined;
        const probeModule: AppModule = {
            id: 'quit-probe',
            async init(ctx) {
                quit = () => ctx.app.quit();
            },
        };
        const { builder, host } = makeHarness(dir, [probeModule]);
        const app = builder.build();
        const running = app.run();
        await app.lifecycle.when('ready');

        (quit as () => void)(); // 受控入口 → before-quit → 关停管线
        await running;
        expect(app.lifecycle.state).toBe('exited');
        expect(host.quitCalls).toBe(1);

        // exited 之后的再次调用不再触达宿主（受控入口的幂等防护）。
        (quit as () => void)();
        expect(host.quitCalls).toBe(1);
    });
});

/** 测试用事件定义（ctx.app.events 发布通路验证）。 */
function ctxProbeEvent() {
    return {
        kind: 'event' as const,
        channel: 'app.ctxProbe',
        payload: z.object({ at: z.number() }),
    };
}

describe('DesktopApp（外部部署控制面）', () => {
    it('部署在模块 init 前拉起（ctx.app.deployments 可观察）；关停时服务 dispose 先于部署终止', async () => {
        const dir = await makeTempDir();
        const health = await startHealthServer();
        const order: string[] = [];
        const changes: DeploymentChange[] = [];

        /** 带可观察 dispose 的演示服务（证明 dispose 先于进程终止）。 */
        const demoToken = serviceToken<{ ping(): string }>('modules.demo');
        const demoService = defineService(demoToken, () => ({
            ping: () => 'pong',
            dispose: () => {
                order.push('service-disposed');
            },
        }));
        const demoModule: AppModule = {
            id: 'demo',
            deployments: [
                {
                    id: 'demo-svc',
                    command: 'demo-server',
                    baseUrl: `http://127.0.0.1:${health.port}`,
                    health: { path: '/health', intervalMs: 30 },
                },
            ],
            services: [demoService],
            async init(ctx) {
                await ctx.services.get(demoToken);
                // 模块只能拿到就绪查询受众：观察状态、订阅迁移。
                const readiness = ctx.app.deployments;
                readiness.onChange((change) => {
                    if (change.status.id !== 'demo-svc') return;
                    changes.push(change);
                    if (change.to === 'stopping') order.push('deployment-stopping');
                });
                // 部署先于模块 init 拉起：init 观察到的必须是 running。
                order.push(`init:${readiness.getStatus('demo-svc')?.state}`);
            },
        };

        const { builder, transport, windows, processHost } = makeHarness(dir, [
            demoModule,
        ]);
        const app = builder.build();
        const running = app.run();
        await app.lifecycle.when('ready');
        expect(order).toEqual(['init:running']);

        // 内置管理路由可用（deployments.list 走完整路由管线，无需业务模块）。
        const result = await transport.call('deployments.list', undefined);
        expect(result).toMatchObject({
            ok: true,
            data: [expect.objectContaining({ id: 'demo-svc', state: 'running' })],
        });
        // 状态迁移广播走 contracts schema 校验（不合法会被 EventPublisher 丢弃）。
        expect(
            windows.sent.some((entry) => entry.channel === 'app.deploymentChanged'),
        ).toBe(true);

        await app.quit();
        await running;
        // joiner 顺序：服务 dispose 先于外部进程终止。
        expect(order.indexOf('service-disposed')).toBeLessThan(
            order.indexOf('deployment-stopping'),
        );
        // 关停结束：托管进程被优雅终止、状态落 stopped。
        expect(processHost.processes[0]?.killSignals).toEqual(['SIGTERM']);
        const last = changes[changes.length - 1];
        expect(last?.status.id).toBe('demo-svc');
        expect(last?.to).toBe('stopped');
        await health.close();
    });

    it('内置管理路由：start/stop/restart 行为与错误翻译保持（未知 id → NOT_FOUND）', async () => {
        const dir = await makeTempDir();
        const demoModule: AppModule = {
            id: 'demo',
            deployments: [
                {
                    id: 'demo-svc',
                    command: 'demo-server',
                    baseUrl: 'http://127.0.0.1:1',
                    health: false,
                },
            ],
        };
        const { builder, transport } = makeHarness(dir, [demoModule]);
        const app = builder.build();
        const running = app.run();
        await app.lifecycle.when('ready');

        // 未知 id：管理端点翻译为 NOT_FOUND 信封。
        const unknown = await transport.call('deployments.start', { id: 'ghost' });
        expect(unknown).toMatchObject({
            ok: false,
            error: { code: 'NOT_FOUND' },
        });

        // start：health:false 的托管部署立即就绪（快照回传 running）。
        const started = await transport.call('deployments.start', { id: 'demo-svc' });
        expect(started).toMatchObject({
            ok: true,
            data: { id: 'demo-svc', state: 'running', mode: 'managed' },
        });

        // restart：停止后重新拉起。
        const restarted = await transport.call('deployments.restart', {
            id: 'demo-svc',
        });
        expect(restarted).toMatchObject({ ok: true, data: { state: 'running' } });

        // stop：优雅终止后落 stopped。
        const stopped = await transport.call('deployments.stop', { id: 'demo-svc' });
        expect(stopped).toMatchObject({ ok: true, data: { state: 'stopped' } });

        await app.quit();
        await running;
    });

    it('模块 init 失败触发统一回滚：已 init 模块 dispose、容器回收、run() reject', async () => {
        const dir = await makeTempDir();
        const events: string[] = [];
        const okToken = serviceToken<{ dispose(): void }>('modules.ok');
        const okModule: AppModule = {
            id: 'ok',
            services: [
                defineService(okToken, () => ({
                    dispose: () => {
                        events.push('service-disposed');
                    },
                })),
            ],
            async init(ctx) {
                await ctx.services.get(okToken);
                events.push('ok-init');
            },
            dispose() {
                events.push('ok-module-disposed');
            },
        };
        const failingModule: AppModule = {
            id: 'failing',
            async init() {
                throw new Error('init boom');
            },
        };
        const { builder, host, windows, transport } = makeHarness(dir, [
            okModule,
            failingModule,
        ]);
        const app = builder.build();

        await expect(app.run()).rejects.toThrow('init boom');

        // 回滚完成：生命周期落 exited（不是 ready），窗口未打开。
        expect(app.lifecycle.state).toBe('exited');
        expect(windows.opened).toEqual([]);
        expect(transport.listeners.size).toBe(0);
        // 清理顺序：模块逆序 dispose -> 容器内服务 dispose。
        expect(events).toEqual(['ok-init', 'ok-module-disposed', 'service-disposed']);
        // 启动失败不以正常退出的 host.exit(0) 收尾，退出码由进程壳决定。
        expect(host.exitCode).toBeUndefined();
    });

    it('required 部署启动失败：startAll reject，统一回滚后 run() 以原错误 reject', async () => {
        const dir = await makeTempDir();
        const initCalls: string[] = [];
        const okModule: AppModule = {
            id: 'ok',
            async init() {
                initCalls.push('ok');
            },
        };
        const hardModule: AppModule = {
            id: 'hard',
            deployments: [
                {
                    id: 'hard-svc',
                    required: true,
                    command: 'missing-binary',
                    baseUrl: 'http://127.0.0.1:1',
                    health: { intervalMs: 20 },
                    readyTimeoutMs: 1_000,
                },
            ],
            async init() {
                initCalls.push('hard');
            },
        };
        const { builder, host, windows, processHost } = makeHarness(dir, [
            okModule,
            hardModule,
        ]);
        const app = builder.build();
        processHost.nextSpawnError = 'spawn missing-binary ENOENT';

        await expect(app.run()).rejects.toBeInstanceOf(DeploymentStartFailedError);

        // 回滚完成：部署先于模块 init，因此任何模块 init 都未执行。
        expect(initCalls).toEqual([]);
        expect(app.lifecycle.state).toBe('exited');
        expect(windows.opened).toEqual([]);
        expect(processHost.spawns).toHaveLength(1);
        // 不以正常退出的 host.exit(0) 收尾，非零退出码由进程壳决定。
        expect(host.exitCode).toBeUndefined();
    });

    it('可选部署启动失败不阻断启动：应用照常 ready、IPC 可用', async () => {
        const dir = await makeTempDir();
        let observedState: string | undefined;
        const softModule: AppModule = {
            id: 'soft',
            deployments: [
                {
                    id: 'soft-svc',
                    command: 'missing-binary',
                    baseUrl: 'http://127.0.0.1:1',
                    health: { intervalMs: 20 },
                    readyTimeoutMs: 1_000,
                },
            ],
            async init(ctx) {
                observedState = ctx.app.deployments.getStatus('soft-svc')?.state;
            },
        };
        const { builder, transport } = makeHarness(dir, [settingsModule, softModule]);
        const app = builder.build();
        const running = app.run();

        await app.lifecycle.when('ready');
        expect(observedState).toBe('failed');
        // 可选 sidecar 缺席，应用照常可用。
        const result = await transport.call('settings.getAll', undefined);
        expect(result).toMatchObject({ ok: true });

        await app.quit();
        await running;
    });
});
