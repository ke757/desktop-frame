import { appEvents } from '@desktop-frame/contracts';
import type { ServiceContainer } from './container';
import type { AppEnv } from './env';
import type { HostApp } from './host';
import type { EventPublisher } from './ipc/events';
import type { IpcRouter } from './ipc/router';
import type { IpcTransport } from './ipc/router';
import type { Lifecycle } from './lifecycle';
import type { Logger } from './logging';
import type { AppModule } from './module';
import type { WindowHost } from './window';

/** DesktopApp 的组成部件（全部由 builder.build 构造并注入）。 */
export interface DesktopAppParts {
    /** Electron app 的窄接口适配。 */
    readonly host: HostApp;
    /** 环境信息。 */
    readonly env: AppEnv;
    /** 根 logger。 */
    readonly logger: Logger;
    /** 生命周期状态机。 */
    readonly lifecycle: Lifecycle;
    /** 服务容器（核心 token 已注册）。 */
    readonly container: ServiceContainer;
    /** IPC 路由。 */
    readonly router: IpcRouter;
    /** 窗口宿主。 */
    readonly windows: WindowHost;
    /** 事件发布器。 */
    readonly events: EventPublisher;
    /** IPC 传输适配（electron ipcMain）。 */
    readonly transport: IpcTransport;
    /** 待装配的业务模块。 */
    readonly modules: ReadonlyArray<AppModule>;
    /** 主窗口的 definition id（无窗口定义时为 undefined）。 */
    readonly primaryWindowId: string | undefined;
}

/** dev server 等待上限（ms）。 */
const DEV_SERVER_TIMEOUT_MS = 30_000;
/** dev server 轮询间隔（ms）。 */
const DEV_SERVER_POLL_MS = 250;

/**
 * 应用总对象（builder.build 的产物）：持有完整对象图，并拥有从启动到
 * 退出的全部生命周期。对齐 Tauri v2 的 `App::run` / FastAPI 的
 * lifespan 驱动：业务代码只声明（模块 init / dispose / onShutdown），
 * 时序由本对象驱动。
 *
 *   run():  whenReady -> 注册模块 -> 模块 init -> 路由上线
 *           -> lifecycle "ready" -> 打开主窗口 -> 挂起直到 "exited"
 *   quit(): host.quit() -> before-quit -> shutdown joiner 管线 -> host.exit(0)
 */
export class DesktopApp {
    /** Electron app 的窄接口适配。 */
    readonly host: HostApp;
    /** 环境信息。 */
    readonly env: AppEnv;
    /** 根 logger。 */
    readonly logger: Logger;
    /** 生命周期状态机（readonly 暴露供测试等待/断言）。 */
    readonly lifecycle: Lifecycle;
    /** 服务容器（readonly 暴露供测试断言注册表）。 */
    readonly container: ServiceContainer;
    /** IPC 路由。 */
    readonly router: IpcRouter;
    /** 窗口宿主。 */
    readonly windows: WindowHost;
    /** 事件发布器。 */
    readonly events: EventPublisher;

    private readonly transport: IpcTransport;
    private readonly modules: ReadonlyArray<AppModule>;
    private readonly primaryWindowId: string | undefined;

    /** 已进入关停流程的标志（防止 before-quit 二次触发）。 */
    private quitting = false;
    /** run() 是否已调用过。 */
    private started = false;

    constructor(parts: DesktopAppParts) {
        this.host = parts.host;
        this.env = parts.env;
        this.logger = parts.logger;
        this.lifecycle = parts.lifecycle;
        this.container = parts.container;
        this.router = parts.router;
        this.windows = parts.windows;
        this.events = parts.events;
        this.transport = parts.transport;
        this.modules = parts.modules;
        this.primaryWindowId = parts.primaryWindowId;
    }

    /**
     * 启动应用并拥有其整个生命周期；Promise 在 lifecycle 到达 `exited`
     * 后 resolve（Tauri `App::run` 阻塞语义的 Promise 化）。致命启动错误
     * 会 reject（记录日志后由入口决定退出码）。
     */
    async run(): Promise<void> {
        if (this.started) {
            throw new Error('DesktopApp.run() must only be called once');
        }
        this.started = true;

        this.wireHostEvents();

        await this.host.whenReady();

        // 装配模块：注册服务 -> 注册路由 -> 模块 init（框架调用业务的起点）。
        for (const module of this.modules) {
            for (const registration of module.services ?? []) {
                this.container.register(registration);
            }
        }
        for (const module of this.modules) {
            module.registerRoutes?.(this.router);
        }
        for (const module of this.modules) {
            await module.init?.({
                services: this.container,
                logger: this.logger,
                events: this.events,
                env: this.env,
            });
        }

        this.router.install(this.transport);
        this.lifecycle.transition('ready');
        this.logger.info('backend ready', {
            modules: this.modules.map((module) => module.id),
            channels: this.router.channels,
        });

        if (this.env.rendererEntry.kind === 'url') {
            await this.waitForDevServer(this.env.rendererEntry.url);
        }
        if (this.primaryWindowId) {
            await this.windows.openWindow(this.primaryWindowId);
        }

        // 挂起直到退出：quit/before-quit 链路最终把 lifecycle 推到 exited。
        await this.lifecycle.when('exited');
    }

    /**
     * 编程式退出（对齐 Tauri `AppHandle::exit`）：触发 before-quit ->
     * 关停管线，并等待 lifecycle 落到 `exited`。
     */
    async quit(): Promise<void> {
        this.host.quit();
        await this.lifecycle.when('exited');
    }

    /** 把 Electron 裸事件接到生命周期与窗口策略上。 */
    private wireHostEvents(): void {
        this.host.onSecondInstance(() => this.windows.focusPrimary());
        this.host.onActivate(() => {
            void this.windows.openPrimaryIfNone().catch((cause) => {
                this.logger.error('failed to reopen primary window', {
                    error: cause,
                });
            });
        });
        this.host.onWindowAllClosed(() => {
            // macOS 惯例：应用留在 Dock 存活；其余平台直接退出。
            if (process.platform !== 'darwin') this.host.quit();
        });
        this.host.onBeforeQuit((event) => {
            if (this.quitting) return;
            event.preventDefault();
            this.quitting = true;
            void this.gracefulShutdown();
        });

        // 状态迁移广播给所有 renderer（web 界面的生命周期徽标）。
        this.lifecycle.onChange((change) => {
            this.events.publish(appEvents.lifecycleChanged, {
                state: change.to,
                at: Date.now(),
            });
        });

        // joiner 顺序有意义：窗口先销毁、服务后 dispose，
        // 使窗口关停期间的逻辑仍能使用服务。
        this.lifecycle.onShutdown(() => this.windows.closeAll());
        this.lifecycle.onShutdown(() => this.container.dispose());
    }

    /** 优雅关停：执行 shutdown joiner 管线后以 host.exit(0) 收尾。 */
    private async gracefulShutdown(): Promise<void> {
        this.logger.info('graceful shutdown starting');
        try {
            await this.lifecycle.shutdown();
        } catch (cause) {
            this.logger.error('shutdown pipeline failed', { error: cause });
        }
        this.logger.info('graceful shutdown complete');
        this.host.exit(0);
    }

    /** 轮询等待 web dev server 就绪（仅 dev 模式需要）。 */
    private async waitForDevServer(url: string): Promise<void> {
        const deadline = Date.now() + DEV_SERVER_TIMEOUT_MS;
        this.logger.info('waiting for web dev server', { url });
        while (Date.now() < deadline) {
            try {
                const response = await fetch(url, { redirect: 'manual' });
                response.body?.cancel().catch(() => {});
                if (response.status < 500) {
                    this.logger.info('web dev server is up', { url });
                    return;
                }
            } catch {
                // 尚未就绪，继续轮询。
            }
            await new Promise((resolve) => setTimeout(resolve, DEV_SERVER_POLL_MS));
        }
        this.logger.warn(
            'web dev server did not come up in time; window may fail to load',
            { url },
        );
    }
}
