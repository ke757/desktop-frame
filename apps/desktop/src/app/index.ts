import { ServiceContainer } from './core/container';
import { resolveEnv } from './core/env';
import { EventPublisher } from './core/ipc/events';
import { IpcRouter } from './core/ipc/router';
import { LifecycleService } from './core/lifecycle';
import type { HostApp } from './core/host';
import type { Logger } from './core/logging';
import { createElectronHost } from './electron-host';
import { createElectronIpcTransport } from './electron-transport';
import { createAppLogger } from './logging';
import { settingsModule } from './modules/settings/settings.module';
import { systemModule } from './modules/system/system.module';
import { AppRuntime } from './runtime';
import { MAIN_WINDOW_ID, createMainWindowDefinition } from './windows/definitions';
import { WindowManager } from './windows/manager';

/**
 * 组合根（composition root）：显式构造所有核心对象并交给 runtime。
 * 全仓库只有这里知道应用是如何装配的。
 */
export function runDesktopApp(host: HostApp = createElectronHost()): void {
    void (async () => {
        // 单实例锁：已有实例持锁时当前进程立即退出。
        if (!host.requestSingleInstanceLock()) {
            host.quit();
            return;
        }

        // 基础核心服务
        const logger = createAppLogger();
        const env = resolveEnv(host, __dirname);
        const lifecycle = new LifecycleService(logger.child('lifecycle'));
        const container = new ServiceContainer(logger.child('container'));
        const windows = new WindowManager(env, logger.child('windows'));
        windows.register(createMainWindowDefinition());
        const events = new EventPublisher(windows, logger.child('events'));
        const router = new IpcRouter({
            services: container,
            lifecycle,
            env,
            logger,
            events,
        });

        installGlobalErrorHandlers(logger);

        const runtime = new AppRuntime({
            host,
            env,
            logger,
            lifecycle,
            container,
            router,
            windows,
            events,
            transport: createElectronIpcTransport(),
            modules: [systemModule, settingsModule],
            primaryWindowId: MAIN_WINDOW_ID,
        });

        try {
            await runtime.start();
        } catch (cause) {
            logger.error('fatal startup failure', { error: cause });
            host.exit(1);
        }
    })();
}

/** 注册进程级兜底错误处理：记日志但不让进程退出。 */
function installGlobalErrorHandlers(logger: Logger): void {
    process.on('uncaughtException', (cause) => {
        logger.error('uncaught exception', { error: cause });
    });
    process.on('unhandledRejection', (reason) => {
        logger.error('unhandled rejection', { reason });
    });
}
