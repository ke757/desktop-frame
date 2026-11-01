import { appEvents } from '@desktop-frame/contracts';
import type { AppHandle } from '../api/app-handle';
import { ServiceContainer } from './container';
import type { DeploymentControlPlane } from '../deployment/controller';
import { registerDeploymentAdminRoutes } from '../deployment/admin-routes';
import type { AppEnv } from '../api/env';
import type { DeploymentReadiness } from '../api/deployment';
import type { HostRuntime } from '../spi/host';
import type { EventPublisher } from '../api/event-publisher';
import { IpcRouter } from '../ipc/router';
import type { IpcTransport } from '../spi/ipc-transport';
import type { LifecycleView } from '../api/lifecycle';
import type { Lifecycle } from './lifecycle';
import type { Logger } from '../api/logger';
import type { AppModule } from '../api/module';
import type { WindowController, WindowDefinition } from '../spi/window';

/**
 * DesktopApp 的组成部件（Builder 造好的叶子能力 + 声明，内核私有）。
 * 依赖 AppHandle 的部件（Container/Router）刻意不在其中——它们必须等
 * DesktopApp 签发句柄之后在本对象构造函数内接线（能力调用权归 DesktopApp）。
 */
export interface DesktopAppParts {
    /** Electron app 的窄接口适配。 */
    readonly host: HostRuntime;
    /** IPC 传输适配（electron ipcMain）。 */
    readonly transport: IpcTransport;
    /** 根 logger。 */
    readonly logger: Logger;
    /** 环境信息（resolveEnv 产出的冻结快照）。 */
    readonly env: Readonly<AppEnv>;
    /** 生命周期状态机。 */
    readonly lifecycle: Lifecycle;
    /** 窗口控制器。 */
    readonly windows: WindowController;
    /** 事件发布器。 */
    readonly events: EventPublisher;
    /** 部署控制面（spec 已在 build 期登记；DesktopApp 独占 controller 受众）。 */
    readonly deployments: DeploymentControlPlane;
    /** 待装配的业务模块声明。 */
    readonly modules: ReadonlyArray<AppModule>;
    /** 窗口定义声明。 */
    readonly windowDefinitions: ReadonlyArray<WindowDefinition>;
}

/** dev server 等待上限（ms）。 */
const DEV_SERVER_TIMEOUT_MS = 30_000;
/** dev server 轮询间隔（ms）。 */
const DEV_SERVER_POLL_MS = 250;

/**
 * 应用总对象：持有完整对象图，并拥有从启动到退出的全部生命周期。对齐
 * Tauri v2 的 `App::run` / FastAPI lifespan 驱动：业务代码只声明，时序由
 * 本对象驱动。
 *
 * 职责分界（能力内核 + 业务容器）：Builder 只造叶子能力并收集声明；
 * 本对象在构造函数里签发受限 AppHandle（唯一的句柄签发点，委托回调 +
 * 冻结 facade，模块拿不到 Lifecycle/DeploymentManager 的运行时本体），
 * 再用句柄接线 ServiceContainer 与 IpcRouter，并登记服务/路由/窗口/内置
 * 管理路由——依赖句柄的部件天然由句柄签发者构造。
 *
 * 对外只暴露最小面：`run()` / `quit()` / `logger` / 只读生命周期视图。
 * 内部部件（host/container/router/windows/events/部署控制面/app handle）
 * 都是私有字段。
 *
 *   build：构造对象图 + 登记声明 + 纯声明冲突校验（不打开数据库、不启动
 *          sidecar、不安装 transport、不开窗口、不执行模块 init）。
 *   run()：whenReady -> 部署 startAll -> 模块 init -> 安装路由
 *          -> lifecycle "ready" -> 等 dev server -> 打开主窗口 -> 挂起。
 *   quit()/ctx.app.quit()：受控退出入口 -> before-quit -> 关停管线。
 *   启动失败：复用同一关停管线回滚（不调用 host.exit），随后 reject。
 */
export class DesktopApp {
    /** 根 logger（进程壳兜底日志用）。 */
    readonly logger: Logger;

    private readonly host: HostRuntime;
    private readonly transport: IpcTransport;
    private readonly handle: AppHandle;
    private readonly env: Readonly<AppEnv>;
    private readonly lifecycleImpl: Lifecycle;
    private readonly container: ServiceContainer;
    private readonly router: IpcRouter;
    private readonly windows: WindowController;
    private readonly events: EventPublisher;
    private readonly deployments: DeploymentControlPlane;
    private readonly modules: ReadonlyArray<AppModule>;
    private readonly primaryWindowId: string | undefined;
    /** 已进入（或正在进入）init 的模块，关停/回滚时逆序 dispose。 */
    private readonly initializedModules: AppModule[] = [];
    /** 已进入关停流程的标志（防止 before-quit 二次触发）。 */
    private quitting = false;
    /** run() 是否已调用过。 */
    private started = false;

    constructor(parts: DesktopAppParts) {
        // ---- 叶子能力（Builder 构造，所有权移交本对象）----
        this.host = parts.host;
        this.transport = parts.transport;
        this.logger = parts.logger;
        this.env = parts.env;
        this.lifecycleImpl = parts.lifecycle;
        this.windows = parts.windows;
        this.events = parts.events;
        this.deployments = parts.deployments;
        this.modules = parts.modules;

        // ---- 句柄签发与依赖句柄的接线（本对象的私有装配段）----
        // 顺序固定：先签发 AppHandle（委托闭包引用上方私有字段），再构造
        // 消费句柄的 Container/Router，最后登记声明并解析主窗口。
        this.handle = this.createHandle();
        this.container = new ServiceContainer(
            this.handle,
            this.logger.child('container'),
        );
        this.router = new IpcRouter({ app: this.handle, services: this.container });
        this.registerDeclarations(parts.windowDefinitions);
        this.primaryWindowId = this.windows.primaryDefinitionId;
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
            // 关停/回滚管线最先注册：任何后续失败路径都能清理已启动的资源
            // （容器 dispose joiner 已在场）。
            this.registerShutdownPipeline();
            // 接线宿主事件与部署状态广播（控制面 build 期已构造，订阅
            // 不存在时序问题）。
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
                    app: this.handle,
                    services: this.container,
                });
            }

            // 路由上线（声明已在构造期登记）。
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
     * 编程式退出（对齐 Tauri `AppHandle::exit`）：经受控入口触发
     * before-quit -> 关停管线，并等待 lifecycle 落到 `exited`。
     */
    async quit(): Promise<void> {
        this.requestQuit();
        await this.lifecycleImpl.when('exited');
    }

    /**
     * 签发受限应用句柄：冻结的委托 facade，是模块可见内核能力的唯一形态。
     * 生命周期与部署走 wrapper（模块拿不到完整 Lifecycle/DeploymentManager
     * 的运行时本体）；logger/events 走转发回调；quit 收敛到受控入口。
     */
    private createHandle(): AppHandle {
        const logger = this.logger;
        const events = this.events;
        const lifecycle = this.lifecycleImpl;
        const deployments = this.deployments;
        const lifecycleView: LifecycleView = Object.freeze({
            get state() {
                return lifecycle.state;
            },
            when: (target: Parameters<LifecycleView['when']>[0]) =>
                lifecycle.when(target),
            onChange: (listener: Parameters<LifecycleView['onChange']>[0]) =>
                lifecycle.onChange(listener),
        });
        const readiness: DeploymentReadiness = Object.freeze({
            getStatus: (id: string) => deployments.getStatus(id),
            whenReady: (id: string, timeoutMs?: number) =>
                deployments.whenReady(id, timeoutMs),
            onChange: (listener: Parameters<DeploymentReadiness['onChange']>[0]) =>
                deployments.onChange(listener),
        });
        return Object.freeze<AppHandle>({
            env: this.env,
            logger: {
                debug: (message, meta) => logger.debug(message, meta),
                info: (message, meta) => logger.info(message, meta),
                warn: (message, meta) => logger.warn(message, meta),
                error: (message, meta) => logger.error(message, meta),
                child: (tag) => logger.child(tag),
            },
            events: {
                publish: (evt, payload) => events.publish(evt, payload),
            },
            lifecycle: lifecycleView,
            deployments: readiness,
            quit: () => this.requestQuit(),
        });
    }

    /** 登记声明期数据（构造期调用，仍是纯登记：零实例化、零启动副作用）。 */
    private registerDeclarations(definitions: ReadonlyArray<WindowDefinition>): void {
        // 窗口定义（id 重复由窗口控制器抛错）。
        for (const definition of definitions) {
            this.windows.register(definition);
        }
        // 服务工厂登记（token 重复由容器抛错；只登记工厂，零实例化）。
        for (const module of this.modules) {
            for (const registration of module.services ?? []) {
                this.container.register(registration);
            }
        }
        // 业务路由声明登记（channel 重复由路由抛错）。
        for (const module of this.modules) {
            module.registerRoutes?.(this.router);
        }
        // deployments 管理 RPC：框架内置路由（消费内部 Admin 受众，不进
        // AppHandle、无 token），与业务路由同在构造期登记、run 期安装。
        registerDeploymentAdminRoutes(this.router, this.deployments);
    }

    /**
     * 受控退出入口（ctx.app.quit 与 DesktopApp.quit 的共同路径）：
     * 已在关停/已退出时 no-op，防止重复触发 before-quit；其余状态经
     * host.quit() 走 Electron before-quit → 统一优雅关停管线。
     */
    private requestQuit(): void {
        const state = this.lifecycleImpl.state;
        if (state === 'shuttingDown' || state === 'exited') return;
        this.host.quit();
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

        // 部署状态迁移同样广播（web 界面的控制面面板）。
        this.deployments.onChange((change) => {
            this.events.publish(appEvents.deploymentChanged, {
                deployment: change.status,
            });
        });
    }

    /**
     * 注册关停管线 joiner。刻意先于 run() 内任何可失败步骤——启动失败
     * 回滚（rollback）复用同一条管线，任何失败路径都能清理已启动的资源。
     * joiner 顺序有意义：窗口先销毁、模块逆序 dispose、业务服务后 dispose、
     * 外部进程最后终止（窗口关停与服务 dispose 期间仍可使用外部服务）。
     */
    private registerShutdownPipeline(): void {
        this.lifecycleImpl.onShutdown(() => this.windows.closeAll());
        this.lifecycleImpl.onShutdown(() => this.disposeModules());
        this.lifecycleImpl.onShutdown(() => this.container.dispose());
        this.lifecycleImpl.onShutdown(() => this.deployments.stopAll());
    }

    /**
     * 模块逆序 dispose（与 init 对称的钩子；单项失败不阻断其余清理）。
     * 此刻在 container dispose joiner 之前执行：传入与 init 相同的
     * ctx.app + ctx.services，模块 dispose 内仍可解析依赖，且解析到的
     * 服务尚未回收。
     */
    private async disposeModules(): Promise<void> {
        const modules = [...this.initializedModules].reverse();
        for (const module of modules) {
            if (!module.dispose) continue;
            try {
                await module.dispose({
                    app: this.handle,
                    services: this.container,
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
