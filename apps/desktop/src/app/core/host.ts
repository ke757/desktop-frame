/**
 * 对 Electron `app` 模块的窄接口抽象。runtime 与生命周期编排只依赖
 * 该抽象（不直接依赖 electron），从而可以在单测中用假 host 替换。
 */

/** before-quit 事件的最小面。 */
export interface BeforeQuitEvent {
    /** 阻止默认退出（交由关停管线接管）。 */
    preventDefault(): void;
}

/** Electron app 的窄接口。 */
export interface HostApp {
    /** 应用是否已打包。 */
    readonly isPackaged: boolean;
    /** 应用名。 */
    getName(): string;
    /** 应用版本。 */
    getVersion(): string;
    /** 应用 locale。 */
    getLocale(): string;
    /** 取系统路径（当前只用 userData）。 */
    getPath(name: 'userData'): string;
    /** 等待 Electron 完成基础初始化（app.whenReady）。 */
    whenReady(): Promise<void>;
    /** 请求退出（会走 before-quit 链）。 */
    quit(): void;
    /** 立即退出进程，不再触发 before-quit/will-quit。 */
    exit(code?: number): void;
    /** 请求单实例锁；false 表示已有实例持锁。 */
    requestSingleInstanceLock(): boolean;
    /** 订阅 before-quit（可 preventDefault）。 */
    onBeforeQuit(listener: (event: BeforeQuitEvent) => void): void;
    /** 订阅 window-all-closed。 */
    onWindowAllClosed(listener: () => void): void;
    /** 订阅 macOS 的 activate（Dock 图标点击且无窗口）。 */
    onActivate(listener: () => void): void;
    /** 订阅 second-instance（已有实例收到新启动参数）。 */
    onSecondInstance(listener: (argv: string[]) => void): void;
}
