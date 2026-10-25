import { appEvents } from '@desktop-frame/contracts';
import { defineService } from './core/container';
import type { ServiceContainer } from './core/container';
import type { AppEnv } from './core/env';
import type { HostApp } from './core/host';
import type { IpcTransport } from './core/ipc/router';
import type { IpcRouter } from './core/ipc/router';
import type { EventPublisher } from './core/ipc/events';
import type { LifecycleService } from './core/lifecycle';
import type { Logger } from './core/logging';
import type { AppModule } from './core/module';
import {
    envToken,
    eventsToken,
    hostToken,
    lifecycleToken,
    loggerToken,
    windowsToken,
} from './tokens';
import type { WindowManager } from './windows/manager';

/** AppRuntime 的全部依赖。 */
export interface RuntimeDeps {
    /** Electron app 的窄接口适配。 */
    readonly host: HostApp;
    /** 环境信息（dev server、路径、来源白名单等）。 */
    readonly env: AppEnv;
    /** 根 logger。 */
    readonly logger: Logger;
    /** 生命周期状态机。 */
    readonly lifecycle: LifecycleService;
    /** 服务容器。 */
    readonly container: ServiceContainer;
    /** IPC 路由。 */
    readonly router: IpcRouter;
    /** 窗口管理器。 */
    readonly windows: WindowManager;
    /** 事件发布器。 */
    readonly events: EventPublisher;
    /** electron ipcMain 传输适配。 */
    readonly transport: IpcTransport;
    /** 待装配的业务模块列表。 */
    readonly modules: ReadonlyArray<AppModule>;
    /** 主窗口的 definition id。 */
    readonly primaryWindowId: string;
}

/** dev server 等待上限（ms）。 */
const DEV_SERVER_TIMEOUT_MS = 30_000;
/** dev server 轮询间隔（ms）。 */
const DEV_SERVER_POLL_MS = 250;

/**
 * 启动/关停编排器：把 Electron 裸事件纳入到 lifecycle 生命周期状态机。
 *
 *   app.whenReady -> 注册模块 -> 模块 init -> 路由上线
 *                  -> lifecycle "ready" -> 打开主窗口
 *   before-quit   -> preventDefault -> lifecycle.shutdown()（joiner 管线）
 *                  -> app.exit(0)
 *   window-all-closed（win/linux）-> app.quit() -> before-quit 链
 */
export class AppRuntime {
    // deforeQuit 标志
    private quitting = false;

    constructor(private readonly deps: RuntimeDeps) {}

    /** 启动后端（核心）：装配模块、上线路由、进入 ready 并打开主窗口。 */
    async start(): Promise<void> {
        const { 
            host,
            env,
            logger,
            lifecycle,
            container,
            router,
            windows,
            events
        } = this.deps;

        // 核心对象本身也注册为服务，业务模块可通过 token 取用。
        container.register(defineService(hostToken, () => host));
        container.register(defineService(envToken, () => env));
        container.register(defineService(loggerToken, () => logger));
        container.register(defineService(lifecycleToken, () => lifecycle));
        container.register(defineService(eventsToken, () => events));
        container.register(defineService(windowsToken, () => windows));

        host.onSecondInstance(() => windows.focusPrimary());
        host.onActivate(() => {
            void windows.openPrimaryIfNone().catch((cause) => {
                logger.error('failed to reopen primary window', { error: cause });
            });
        });
        host.onWindowAllClosed(() => {
            // macOS 惯例：应用留在 Dock 存活；其余平台直接退出。
            if (process.platform !== 'darwin') host.quit();
        });
        host.onBeforeQuit((event) => {
            if (this.quitting) return;
            event.preventDefault();
            this.quitting = true;
            void this.gracefulShutdown();
        });

        // 状态迁移广播给所有 renderer（web 界面的生命周期徽标）。
        lifecycle.onChange((change) => {
            events.publish(appEvents.lifecycleChanged, {
                state: change.to,
                at: Date.now(),
            });
        });

        // joiner 顺序有意义：窗口先销毁、服务后 dispose，
        // 使窗口关停期间的逻辑仍能使用服务。
        lifecycle.onShutdown(() => windows.closeAll());
        lifecycle.onShutdown(() => container.dispose());

        await host.whenReady();

        // 注册模块、注册路由、模块init
        for (const module of this.deps.modules) {
            for (const registration of module.services ?? []) {
                container.register(registration);
            }
        }
        for (const module of this.deps.modules) {
            module.registerRoutes?.(router);
        }
        for (const module of this.deps.modules) {
            await module.init?.({
                services: container,
                logger,
                events,
                env,
            });
        }

        // 路由接入
        router.install(this.deps.transport);
        lifecycle.transition('ready');
        logger.info('backend ready', {
            modules: this.deps.modules.map((module) => module.id),
            channels: router.channels,
        });

        if (env.rendererEntry.kind === 'url') {
            await this.waitForDevServer(env.rendererEntry.url);
        }
        await windows.openWindow(this.deps.primaryWindowId);
    }

    /** 优雅关停：执行 shutdown joiner 管线后以 app.exit(0) 收尾。 */
    private async gracefulShutdown(): Promise<void> {
        const { host, logger, lifecycle } = this.deps;
        logger.info('graceful shutdown starting');
        try {
            await lifecycle.shutdown();
        } catch (cause) {
            logger.error('shutdown pipeline failed', { error: cause });
        }
        logger.info('graceful shutdown complete');
        host.exit(0);
    }

    /** 轮询等待 web dev server 就绪（仅 dev 模式需要）。 */
    private async waitForDevServer(url: string): Promise<void> {
        const deadline = Date.now() + DEV_SERVER_TIMEOUT_MS;
        this.deps.logger.info('waiting for web dev server', { url });
        while (Date.now() < deadline) {
            try {
                const response = await fetch(url, { redirect: 'manual' });
                response.body?.cancel().catch(() => {});
                if (response.status < 500) {
                    this.deps.logger.info('web dev server is up', { url });
                    return;
                }
            } catch {
                // 尚未就绪，继续轮询。
            }
            await new Promise((resolve) => setTimeout(resolve, DEV_SERVER_POLL_MS));
        }
        this.deps.logger.warn(
            'web dev server did not come up in time; window may fail to load',
            { url },
        );
    }
}
