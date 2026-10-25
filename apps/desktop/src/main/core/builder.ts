import { defineService } from './container';
import { ServiceContainer } from './container';
import { resolveEnv } from './env';
import type { AppEnv } from './ports/env';
import type { HostApp } from './ports/host';
import { EventPublisherImpl } from './ipc/events';
import { IpcRouter } from './ipc/router';
import type { IpcTransport } from './ports/ipc-transport';
import { Lifecycle } from './lifecycle';
import type { Logger } from './ports/logger';
import { createConsoleLogger } from './logging';
import type { AppModule } from './ports/module';
import { DesktopApp } from './desktop-app';
import {
    envToken,
    eventsToken,
    hostToken,
    lifecycleToken,
    loggerToken,
    windowsToken,
} from './tokens';
import type { WindowDefinition, WindowHost } from './ports/window-host';

/** desktopApp() 的注入点：全部为接口/工厂，保证 builder 零 electron 依赖。 */
export interface DesktopAppOptions {
    /** Electron app 的窄接口适配（app/electron-host.ts 提供）。 */
    readonly host: HostApp;
    /** IPC 传输适配（app/electron-transport.ts 提供）。 */
    readonly transport: IpcTransport;
    /** 主进程 bundle 目录（运行时 `__dirname`），用于解析资源路径。 */
    readonly mainDir: string;
    /** 窗口宿主工厂：由 app 层注入 WindowManager，测试注入 Fake。 */
    readonly createWindows: (context: {
        readonly env: AppEnv;
        readonly logger: Logger;
    }) => WindowHost;
    /** 根 logger 工厂（缺省为控制台实现；app 层应传 electron-log 实现）。 */
    readonly createLogger?: () => Logger;
}

/**
 * 声明式装配 builder（对齐 Tauri `Builder::default().plugin().manage()`）：
 * 只收集声明，不产生副作用；`.build()` 才构造对象图。
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
     * 全仓库唯一的框架接线点：只应在框架演进时改动，业务变化走
     * `.use()` / `.window()` / 模块内部。
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
        for (const definition of this.windowDefinitions) {
            windows.register(definition);
        }
        const events = new EventPublisherImpl(windows, logger.child('events'));
        const router = new IpcRouter({
            services: container,
            lifecycle,
            env,
            logger,
            events,
        });

        // ---- 核心对象注册为容器服务（实例注册，业务模块经 token 取用）----
        container.register(defineService(hostToken, () => host));
        container.register(defineService(envToken, () => env));
        container.register(defineService(loggerToken, () => logger));
        container.register(defineService(lifecycleToken, () => lifecycle));
        container.register(defineService(eventsToken, () => events));
        container.register(defineService(windowsToken, () => windows));

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
        // 注意：app 本身不注册进容器——容器只装 app 的"部件"（host/env/...
        // 都是部件），组合根不能成为自己的服务节点（所有权方向 app →
        // container 单向）。业务需要"退出应用"等能力时走 hostToken。
        return app;
    }
}

/**
 * 装配 DSL 入口（对齐 FastAPI `FastAPI(lifespan=...)` 的声明式入口）：
 *
 * ```ts
 * desktopApp({ host, transport, createWindows, mainDir })
 *     .use(systemModule, settingsModule)
 *     .window(mainWindow)
 *     .build()
 *     .run();
 * ```
 */
export function desktopApp(options: DesktopAppOptions): DesktopAppBuilder {
    return new DesktopAppBuilder(options);
}
