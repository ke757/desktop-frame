import { defineService } from '../api/di';
import type { DeploymentProfile } from '../api/deployment';
import type { AppEnv } from '../api/env';
import type { HostRuntime } from '../spi/host';
import type { ProcessHost } from '../spi/process-host';
import { EventPublisherImpl } from '../ipc/events';
import { IpcRouter } from '../ipc/router';
import type { IpcTransport } from '../spi/ipc-transport';
import { Lifecycle } from './lifecycle';
import type { Logger } from '../api/logger';
import { createConsoleLogger } from './logging';
import type { AppModule } from '../api/module';
import { ServiceContainer } from './container';
import { DesktopApp } from './desktop-app';
import { DeploymentManagerImpl } from '../deployment/manager';
import { resolveEnv } from './env';
import { deploymentControlPlaneToken, processHostToken } from './tokens';
import {
    appControlToken,
    deploymentAdminToken,
    deploymentReadinessToken,
    envToken,
    eventsToken,
    loggerToken,
} from '../api/tokens';
import type { WindowController, WindowDefinition } from '../spi/window';

/** desktopApp() 的注入点：全部为接口/工厂，保证 builder 零 electron 依赖。 */
export interface DesktopAppOptions {
    /** Electron app 的窄接口适配（electron/host.ts 提供；测试注入 Fake）。 */
    readonly host: HostRuntime;
    /** IPC 传输适配（electron/ipc-transport.ts 提供；测试注入 Fake）。 */
    readonly transport: IpcTransport;
    /** 进程宿主适配（electron/process-host.ts 提供；测试注入 Fake）。 */
    readonly processHost: ProcessHost;
    /** 主进程 bundle 目录（运行时 `__dirname`），用于解析资源路径。 */
    readonly mainDir: string;
    /** 窗口控制器工厂：由 app 层注入 WindowManager，测试注入 Fake。 */
    readonly createWindows: (context: {
        readonly env: AppEnv;
        readonly logger: Logger;
    }) => WindowController;
    /** 根 logger 工厂（缺省为控制台实现；app 层应传 electron-log 实现）。 */
    readonly createLogger?: () => Logger;
    /**
     * dev 模式的部署覆盖 profile（仅 env.isDev 时由部署控制面应用；
     * 典型用途：把 managed 覆盖为 external，等待用户手动启动服务）。
     */
    readonly deploymentProfile?: DeploymentProfile;
}

/**
 * 声明式装配 builder（内核部件；对齐 Tauri `Builder::default().plugin().manage()`）。
 * 生产组合根应使用 electron/app-factory.ts 的 createElectronDesktopApp
 * （本 builder 不从 core 公共面导出，但测试可注入 Fake runtime 直用）。
 */
export class DesktopAppBuilder {
    private readonly options: DesktopAppOptions;
    private readonly modules: AppModule[] = [];
    private readonly windowDefinitions: WindowDefinition[] = [];

    constructor(options: DesktopAppOptions) {
        this.options = options;
    }

    /** 声明业务模块（可多次调用，按声明顺序装配）。 */
    use(...modules: AppModule[]): this {
        this.modules.push(...modules);
        return this;
    }

    /** 声明窗口定义（可多次调用）。 */
    window(...definitions: WindowDefinition[]): this {
        this.windowDefinitions.push(...definitions);
        return this;
    }

    /**
     * 构造对象图并返回 DesktopApp 总对象（不启动，对齐 Tauri
     * `build(context)` 的 "does not start the application" 语义）。
     *
     * build 阶段只做纯声明登记与冲突校验：模块 id / 服务 token / IPC
     * channel / 窗口 id / 部署 id 的重复声明在此抛错——先于任何启动副作用
     * （不打开数据库、不启动 sidecar、不安装 transport、不执行模块 init、
     * 不创建实际窗口）。全仓库唯一的框架接线点：只应在框架演进时改动，
     * 业务变化走 `.use()` / `.window()` / 模块内部。
     */
    build(): DesktopApp {
        const { host, transport, mainDir } = this.options;

        // ---- 框架接线（固定顺序，依赖为 DAG，靠构造注入 + 接口倒置）----
        const logger = (this.options.createLogger ?? createConsoleLogger)();
        const env = resolveEnv(host, mainDir);
        const lifecycle = new Lifecycle(logger.child('lifecycle'));
        const container = new ServiceContainer(logger.child('container'));
        const windows = this.options.createWindows({
            env,
            logger: logger.child('windows'),
        });
        const events = new EventPublisherImpl(windows, logger.child('events'));
        const router = new IpcRouter({
            services: container,
            lifecycle,
            env,
            logger,
            events,
        });

        // ---- 纯声明登记与冲突校验（任何启动副作用之前）----
        const moduleIds = new Set<string>();
        for (const module of this.modules) {
            if (moduleIds.has(module.id)) {
                throw new Error(`duplicate module id: ${module.id}`);
            }
            moduleIds.add(module.id);
        }
        const deploymentIds = new Set<string>();
        for (const module of this.modules) {
            for (const spec of module.deployments ?? []) {
                if (deploymentIds.has(spec.id)) {
                    throw new Error(`duplicate deployment id: ${spec.id}`);
                }
                deploymentIds.add(spec.id);
            }
        }
        // 窗口定义（id 重复由窗口控制器抛错）。
        for (const definition of this.windowDefinitions) {
            windows.register(definition);
        }
        // 服务工厂登记（token 重复由容器抛错；只登记工厂，零实例化）。
        for (const module of this.modules) {
            for (const registration of module.services ?? []) {
                container.register(registration);
            }
        }
        // 路由声明登记（channel 重复由路由抛错）。
        for (const module of this.modules) {
            module.registerRoutes?.(router);
        }

        // ---- 核心服务登记（窄能力 token，见 api/tokens.ts）----
        container.register(defineService(envToken, () => env));
        container.register(defineService(loggerToken, () => logger));
        container.register(defineService(eventsToken, () => events));
        // 应用控制窄面：只有会进入优雅关停的 quit（完整宿主接口是内部 SPI）。
        container.register(
            defineService(appControlToken, () => ({
                quit: () => {
                    host.quit();
                },
            })),
        );
        container.register(
            defineService(processHostToken, () => this.options.processHost),
        );
        // 部署控制面：容器工厂构造（未来可经 accessor 解析其他服务依赖，
        // 如 Database 类基础设施）；模块申报的部署声明在工厂内注册给控制面，
        // spec 字段合法性在此时校验（仍先于 startAll 的进程副作用）。
        const deploymentSpecs = this.modules.flatMap(
            (module) => module.deployments ?? [],
        );
        container.register(
            defineService(deploymentControlPlaneToken, async (accessor) => {
                const manager = new DeploymentManagerImpl({
                    processHost: await accessor.get(processHostToken),
                    env,
                    logger: logger.child('deployments'),
                    profile: this.options.deploymentProfile,
                });
                for (const spec of deploymentSpecs) {
                    manager.register(spec);
                }
                return manager;
            }),
        );
        // readiness/admin 公开 token 与内部 controller 指向同一控制面对象
        // （memoize 保证单实例），按受众分发窄接口，不形成两套状态。
        container.register(
            defineService(deploymentReadinessToken, (accessor) =>
                accessor.get(deploymentControlPlaneToken),
            ),
        );
        container.register(
            defineService(deploymentAdminToken, (accessor) =>
                accessor.get(deploymentControlPlaneToken),
            ),
        );

        const app = new DesktopApp({
            host,
            env,
            logger,
            lifecycle,
            container,
            router,
            windows,
            events,
            transport,
            modules: [...this.modules],
            primaryWindowId: windows.primaryDefinitionId,
        });
        // 注意：app 本身不注册进容器——容器只装 app 的"部件"，组合根不能
        // 成为自己的服务节点（所有权方向 app → container 单向）。业务需要
        // "退出应用"等能力时走 appControlToken。
        return app;
    }
}

/**
 * 装配 DSL 入口（对齐 FastAPI `FastAPI(lifespan=...)` 的声明式入口）。
 * 生产组合根请使用 createElectronDesktopApp（electron/app-factory.ts）；
 * 本入口供测试注入 Fake runtime 或非常规宿主使用。
 *
 * ```ts
 * desktopApp({ host, transport, processHost, createWindows, mainDir })
 *     .use(systemModule, settingsModule)
 *     .window(mainWindow)
 *     .build()
 *     .run();
 * ```
 */
export function desktopApp(options: DesktopAppOptions): DesktopAppBuilder {
    return new DesktopAppBuilder(options);
}
