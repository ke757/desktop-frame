import { app } from 'electron';
import started from 'electron-squirrel-startup';
import { buildDesktopApp } from './main/index';
import type { Logger } from './main/core/ports/logger';

// 进程壳：所有进程级策略集中于此（对齐 Tauri main.rs 的 .expect 位置）。
// ① Windows Squirrel 安装/卸载引导：立即退出，不启动应用。
// ② 单实例锁：已有实例持锁时当前进程退出。
// ③ 全局异常兜底 + 致命启动错误的退出码。
// 应用生命周期（whenReady→ready→exited）由 DesktopApp.run() 拥有。
if (started) {
    app.quit();
} else if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    const desktopApp = buildDesktopApp();
    installProcessErrorHandlers(desktopApp.logger);
    desktopApp.run().catch((cause) => {
        desktopApp.logger.error('fatal: application run failed', { error: cause });
        process.exit(1);
    });
}

/** 安装进程级异常兜底：只记录日志，不中断进程。 */
function installProcessErrorHandlers(logger: Logger): void {
    process.on('uncaughtException', (error) => {
        logger.error('uncaught exception', { error });
    });
    process.on('unhandledRejection', (reason) => {
        logger.error('unhandled rejection', { reason });
    });
}
