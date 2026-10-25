/**
 * 环境端口：描述运行环境的数据契约（共享内核类型）。
 * 由 core/env.ts 的 resolveEnv 从 HostApp 解析产出；适配器（窗口管理器）
 * 与业务（envToken）共同消费。
 */

export type RendererEntry = { kind: 'url'; url: string } | { kind: 'file'; path: string };

export interface AppEnv {
    /** 是否开发模式（未打包）。 */
    readonly isDev: boolean;
    /** web dev server 地址（仅 dev）。 */
    readonly devServerUrl: string | undefined;
    /** 应用名。 */
    readonly appName: string;
    /** 应用版本。 */
    readonly appVersion: string;
    /** 用户数据目录。 */
    readonly userDataPath: string;
    /** 主进程 bundle 目录（运行时 `__dirname`）。 */
    readonly mainDir: string;
    /** preload 脚本路径。 */
    readonly preloadPath: string;
    /** renderer 加载入口（dev URL / 打包文件）。 */
    rendererEntry: RendererEntry;
    /**
     * 允许调用特权 IPC 的 frame 来源白名单：
     * dev 为 web dev server origin，打包后仅 file://。
     */
    allowedFrameOrigins: readonly string[];
}
