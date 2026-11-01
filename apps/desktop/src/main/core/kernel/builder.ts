import type { DeploymentProfile } from '../api/deployment';
import type { AppEnv } from '../api/env';
import type { HostRuntime } from '../spi/host';
import type { ProcessHost } from '../spi/process-host';
import { EventPublisherImpl } from '../ipc/events';
import type { IpcTransport } from '../spi/ipc-transport';
import { Lifecycle } from './lifecycle';
import type { Logger } from '../api/logger';
import { createConsoleLogger } from './logging';
import type { AppModule } from '../api/module';
import { DesktopApp } from './desktop-app';
import { DeploymentManagerImpl } from '../deployment/manager';
import { resolveEnv } from './env';
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
        readonly env: Readonly<AppEnv>;
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
 *
 * 职责分界（能力调用权归 DesktopApp）：本 builder 是组合根——收集声明、
 * 做声明级冲突校验、调 providers 构造**叶子能力**（logger/env/lifecycle/
 * windows/events/deployment 控制面），随后移交 DesktopApp。它刻意不组装
 * AppHandle、不构造 Container/Router、不登记服务/路由/窗口——依赖句柄的
 * 部件必须由句柄签发者（DesktopApp 构造函数）接线。
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
     * build 阶段只做纯声明校验与叶子构造：模块 id / 部署 id 的重复声明、
     * 部署 spec 字段合法性（登记给控制面时校验）在此同步抛错——先于任何
     * 启动副作用（不打开数据库、不启动 sidecar、不安装 transport、不执行
     * 模块 init、不创建实际窗口）。句柄签发、Container/Router 接线与服务/
     * 路由/窗口登记由 DesktopApp 构造函数完成（build 同步路径内，行为不变）。
     */
    build(): DesktopApp {
        const { host, transport, mainDir } = this.options;

        // ---- 纯声明冲突校验（最先做，构造对象图之前）----
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

        // ---- 叶子能力构造（固定顺序，依赖为 DAG；所有权移交 DesktopApp）----
        const logger = (this.options.createLogger ?? createConsoleLogger)();
        const env = resolveEnv(host, mainDir);
        const lifecycle = new Lifecycle(logger.child('lifecycle'));
        const windows = this.options.createWindows({
            env,
            logger: logger.child('windows'),
        });
        const events = new EventPublisherImpl(windows, logger.child('events'));
        // 部署控制面：spec 在此登记，字段合法性立即校验——build 同步失败，
        // 任何 run 副作用之前暴露（重复 id 已在上面先行校验）。
        const deployments = new DeploymentManagerImpl({
            processHost: this.options.processHost,
            env,
            logger: logger.child('deployments'),
            profile: this.options.deploymentProfile,
        });
        for (const spec of this.modules.flatMap((module) => module.deployments ?? [])) {
            deployments.register(spec);
        }

        return new DesktopApp({
            host,
            transport,
            logger,
            env,
            lifecycle,
            windows,
            events,
            deployments,
            modules: [...this.modules],
            windowDefinitions: [...this.windowDefinitions],
        });
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
