import path from 'node:path';
import type { HostApp } from './host';

/** renderer 入口：dev 为 dev server URL，打包后为本地文件。 */
export type RendererEntry = { kind: 'url'; url: string } | { kind: 'file'; path: string };

/** 环境信息：路径、入口与安全白名单的单一来源。 */
export interface AppEnv {
    /** 是否为开发模式（未打包）。 */
    readonly isDev: boolean;
    /** web dev server 地址（仅 dev 模式存在）。 */
    readonly devServerUrl: string | undefined;
    /** 应用名。 */
    readonly appName: string;
    /** 应用版本。 */
    readonly appVersion: string;
    /** userData 目录（设置、日志等落盘位置）。 */
    readonly userDataPath: string;
    /** 构建产物 main bundle 所在目录（运行时为 .vite/build）。 */
    readonly mainDir: string;
    /** preload 脚本绝对路径。 */
    readonly preloadPath: string;
    /** renderer 加载入口。 */
    rendererEntry: RendererEntry;
    /**
     * 允许调用特权 IPC handler 的 frame 来源。dev 放行 web dev server，
     * 打包后只放行 file:// 页面。
     */
    allowedFrameOrigins: readonly string[];
}

/** dev 模式下 web dev server 的默认地址（可用 WEB_DEV_SERVER_URL 覆盖）。 */
export const DEFAULT_DEV_SERVER_URL = 'http://localhost:5173';

/** 从 HostApp 解析环境信息；mainDir 通常传构建产物的 __dirname。 */
export function resolveEnv(host: HostApp, mainDir: string): AppEnv {
    const isDev = !host.isPackaged;
    const devServerUrl = isDev
        ? (process.env.WEB_DEV_SERVER_URL ?? DEFAULT_DEV_SERVER_URL)
        : undefined;

    let rendererEntry: RendererEntry;
    if (devServerUrl) {
        rendererEntry = { kind: 'url', url: devServerUrl };
    } else {
        // mainDir 位于 `<app>/.vite/build`；web 预构建产物在 `<app>/web`
        // （由 forge prePackage 钩子放入）。
        rendererEntry = {
            kind: 'file',
            path: path.join(mainDir, '../../web/index.html'),
        };
    }

    const allowedFrameOrigins = devServerUrl
        ? [new URL(devServerUrl).origin]
        : ['file://'];

    return {
        isDev,
        devServerUrl,
        appName: host.getName(),
        appVersion: host.getVersion(),
        userDataPath: host.getPath('userData'),
        mainDir,
        preloadPath: path.join(mainDir, 'preload.cjs'),
        rendererEntry,
        allowedFrameOrigins,
    };
}
