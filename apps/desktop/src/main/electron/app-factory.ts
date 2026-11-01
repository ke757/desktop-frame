import type { DeploymentProfile } from '../core/api/deployment';
import { desktopApp } from '../core/kernel/builder';
import { createElectronHost } from './host';
import { createElectronIpcTransport } from './ipc-transport';
import { createAppLogger } from './logging';
import { createNodeProcessHost } from './process-host';
import { WindowManager } from './windows-manager';

/** Electron 默认装配的选项（生产组合根唯一需要声明的细节）。 */
export interface ElectronDesktopAppOptions {
    /** 主进程 bundle 目录（运行时 `__dirname`），用于解析资源路径。 */
    readonly mainDir: string;
    /**
     * dev 模式的部署覆盖 profile（仅未打包时生效；典型用途：把 managed
     * 覆盖为 external，等待开发者手动启动外部服务）。
     */
    readonly deploymentProfile?: DeploymentProfile;
}

/**
 * Electron 默认装配工厂（生产组合根入口）：负责 Host、IPC transport、
 * ProcessHost、WindowManager 与默认 logger 的适配器组合，隐藏生产装配的
 * 适配器噪音——组合根只声明"应用由什么组成"（模块、窗口、dev profile）。
 * 底层 `desktopApp(...)` builder 仍允许测试注入 Fake runtime 直用。
 *
 * 返回声明式 builder；组合根继续 `.use().window().build()` 完成装配。
 * 本文件是装配工厂而非适配器：允许 import core/kernel/builder（架构
 * 测试对 electron/** 的唯一豁免）。
 */
export function createElectronDesktopApp(options: ElectronDesktopAppOptions) {
    return desktopApp({
        host: createElectronHost(),
        transport: createElectronIpcTransport(),
        processHost: createNodeProcessHost(),
        mainDir: options.mainDir,
        createLogger: createAppLogger,
        createWindows: ({ env, logger }) => new WindowManager(env, logger),
        deploymentProfile: options.deploymentProfile,
    });
}
