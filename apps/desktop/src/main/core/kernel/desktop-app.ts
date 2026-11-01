import { appEvents } from '@desktop-frame/contracts';
import type { ServiceContainer } from './container';
import type { DeploymentControlPlane } from '../deployment/controller';
import { deploymentControlPlaneToken } from './tokens';
import type { AppEnv } from '../api/env';
import type { HostRuntime } from '../spi/host';
import type { EventPublisher } from '../api/event-publisher';
import type { IpcRouter } from '../ipc/router';
import type { IpcTransport } from '../spi/ipc-transport';
import type { LifecycleView } from '../api/lifecycle';
import type { Lifecycle } from './lifecycle';
import type { Logger } from '../api/logger';
import type { AppModule } from '../api/module';
import type { WindowController } from '../spi/window';

/** DesktopApp 的组成部件（全部由 builder.build 构造并注入，内核私有）。 */
export interface DesktopAppParts {
    /** 生命周期状态机。 */
    readonly lifecycle: Lifecycle;
    /** 服务容器（核心 token 与模块服务工厂已登记）。 */
    readonly container: ServiceContainer;
    /** IPC 路由（build 期已登记声明，run 期安装）。 */
    readonly router: IpcRouter;
    /** Electron app 的窄接口适配。 */
    readonly host: HostRuntime;
    /** 窗口控制器。 */
    readonly windows: WindowController;
    /** IPC 传输适配（electron ipcMain）。 */
    readonly transport: IpcTransport;
    /** 环境信息。 */
    readonly env: AppEnv;
    /** 根 logger。 */
    readonly logger: Logger;
    /** 事件发布器。 */
    readonly events: EventPublisher;
    /** 待激活的业务模块。 */
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
 * 对外只暴露最小面：`run()` / `quit()` / `logger` / 只读生命周期视图
 * （LifecycleView）。内部部件（host/container/router/windows/events/
 * 部署控制面）都是私有字段，业务模块无法经公共 API 取得。
 *
 *   build：构造对象图 + 登记服务/路由/窗口/部署声明 + 纯声明冲突校验
 *          （不打开数据库、不启动 sidecar、不安装 transport、不开窗口）。
 *   run()：whenReady -> 解析并启动部署 -> 模块 init -> 安装路由
 *          -> lifecycle "ready" -> 等 dev server -> 打开主窗口 -> 挂起。
 *   quit()：host.quit() -> before-quit -> shutdown joiner 管线 -> host.exit(0)。
 *   启动失败：复用同一关停管线回滚（不调用 host.exit），随后 reject。
 */
export class DesktopApp {
    /** 根 logger（进程壳兜底日志用）。 */
    readonly logger: Logger;

    private readonly host: HostRuntime;
    private readonly env: AppEnv;
    private readonly lifecycleImpl: Lifecycle;
    private readonly container: ServiceContainer;
    private readonly router: IpcRouter;
    private readonly windows: WindowController;
    private readonly events: EventPublisher;
    private readonly transport: IpcTransport;
    private readonly modules: ReadonlyArray<AppModule>;
    private readonly primaryWindowId: string | undefined;
    /** 部署控制面（run 期从容器解析；controller+readiness/admin 同一对象）。 */
    private deployments: DeploymentControlPlane | undefined;
    /** 已进入（或正在进入）init 的模块，关停/回滚时逆序 dispose。 */
    private readonly initializedModules: AppModule[] = [];
    /** 已进入关停流程的标志（防止 before-quit 二次触发）。 */
    private quitting = false;
    /** run() 是否已调用过。 */
    private started = false;

    constructor(parts: DesktopAppParts) {
        this.host = parts.host;
        this.env = parts.env;
        this.logger = parts.logger;
        this.lifecycleImpl = parts.lifecycle;
        this.container = parts.container;
        this.router = parts.router;
        this.windows = parts.windows;
        this.events = parts.events;
        this.transport = parts.transport;
        this.modules = parts.modules;
        this.primaryWindowId = parts.primaryWindowId;
    }

    /** 生命周期的只读视图（进程壳与测试等待/断言用；不可迁移或关停）。 */
    get lifecycle(): LifecycleView {
        return this.lifecycleImpl;
    }

    /**
     * 启动应用并拥有其整个生命周期；Promise 在 lifecycle 到达 `exited`
     * 后 resolve（Tauri `App::run` 阻塞语义的 Promise 化）。启动失败会
     * 先执行统一回滚（复用关停管线）再 reject——进程壳据此决定非零退出，
     * 本对象绝不以正常退出的 host.exit(0) 收尾。
     */
    async run(): Promise<void> {
        if (this.started) {
            throw new Error('DesktopApp.run() must only be called once');
        }
        this.started = true;

        try {
            // 关停/回滚管线先于任何可失败的解析注册：控制面工厂可能经
            // accessor 实例化其他服务（如 Database 类基础设施），这些解析
            // 失败时也必须能清理已创建的资源（容器 dispose joiner 已在场）。
            this.registerShutdownPipeline();

            // 解析内部部署控制面（build 已登记工厂与声明；此步仅构造对象，
            // 无进程副作用），随后才接线宿主事件与部署状态广播（订阅需要
            // 控制面实例，不能提前 wire 导致丢失）。
            this.deployments = await this.container.get(deploymentControlPlaneToken);
            this.wireHostEvents();

            await this.host.whenReady();

            // 外部部署先于模块 init 拉起（managed 等待就绪或失败；external
            // 挂探测即返回），适配层服务因此可以假定控制面已开始运转。
            // required 部署失败会 reject —— 进入下方统一回滚。
            await this.deployments.startAll();

            // 模块激活：按声明顺序执行 init（框架调用业务的起点）。
            for (const module of this.modules) {
                this.initializedModules.push(module);
                await module.init?.({
                    services: this.container,
                    logger: this.logger,
                    events: this.events,
                    env: this.env,
                });
            }

            // 路由上线（声明已在 build 期登记）。
            this.router.install(this.transport);
            this.lifecycleImpl.transition('ready');
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
        } catch (cause) {
            this.logger.error('bootstrap failed; rolling back started resources', {
                error: cause,
            });
            await this.rollback();
            throw cause;
        }

        // 挂起直到退出：quit/before-quit 链路最终把 lifecycle 推到 exited。
        await this.lifecycleImpl.when('exited');
    }

    /**
     * 编程式退出（对齐 Tauri `AppHandle::exit`）：触发 before-quit ->
     * 关停管线，并等待 lifecycle 落到 `exited`。
     */
    async quit(): Promise<void> {
        this.host.quit();
        await this.lifecycleImpl.when('exited');
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
        this.lifecycleImpl.onChange((change) => {
            this.events.publish(appEvents.lifecycleChanged, {
                state: change.to,
                at: Date.now(),
            });
        });

        // 部署状态迁移同样广播（web 界面的控制面面板）；订阅在控制面
        // 解析之后接线（wireHostEvents 由 run 在解析完成后调用）。
        this.deployments?.onChange((change) => {
            this.events.publish(appEvents.deploymentChanged, {
                deployment: change.status,
            });
        });
    }

    /**
     * 注册关停管线 joiner。刻意先于 run() 内任何可失败的解析调用——
     * 启动失败回滚（rollback）复用同一条管线，任何失败路径都能清理
     * 已实例化的资源。joiner 顺序有意义：窗口先销毁、模块逆序 dispose、
     * 服务后 dispose、外部进程最后终止（窗口关停与服务 dispose 期间
     * 仍可使用外部服务）。
     */
    private registerShutdownPipeline(): void {
        this.lifecycleImpl.onShutdown(() => this.windows.closeAll());
        this.lifecycleImpl.onShutdown(() => this.disposeModules());
        this.lifecycleImpl.onShutdown(() => this.container.dispose());
        this.lifecycleImpl.onShutdown(() => this.deployments?.stopAll());
    }

    /**
     * 模块逆序 dispose（与 init 对称的钩子；单项失败不阻断其余清理）。
     * 此刻在 container dispose joiner 之前执行：传入与 init 相同能力的
     * 受限上下文，模块 dispose 内仍可解析依赖，且解析到的服务尚未回收。
     */
    private async disposeModules(): Promise<void> {
        const modules = [...this.initializedModules].reverse();
        for (const module of modules) {
            if (!module.dispose) continue;
            try {
                await module.dispose({
                    services: this.container,
                    logger: this.logger,
                    events: this.events,
                    env: this.env,
                });
            } catch (cause) {
                this.logger.error('module dispose failed', {
                    module: module.id,
                    error: cause,
                });
            }
        }
    }

    /**
     * 启动失败回滚：复用正常关停的幂等、best-effort 清理管线（窗口 →
     * 模块逆序 dispose → 容器 dispose → 部署 stopAll），但不调用
     * host.exit —— 失败退出码由进程壳决定。
     */
    private async rollback(): Promise<void> {
        try {
            await this.lifecycleImpl.shutdown();
        } catch (cause) {
            this.logger.error('bootstrap rollback failed', { error: cause });
        }
    }

    /** 优雅关停：执行 shutdown joiner 管线后以 host.exit(0) 收尾。 */
    private async gracefulShutdown(): Promise<void> {
        this.logger.info('graceful shutdown starting');
        try {
            await this.lifecycleImpl.shutdown();
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
