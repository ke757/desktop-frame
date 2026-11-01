import path from 'node:path';
import type { AppEnv, RendererEntry } from '../api/env';
import type { HostRuntime } from '../spi/host';

/** dev 模式下 web dev server 的默认地址（可用 WEB_DEV_SERVER_URL 覆盖）。 */
export const DEFAULT_DEV_SERVER_URL = 'http://localhost:5173';

/** 从 HostRuntime 解析环境信息；mainDir 通常传构建产物的 __dirname。 */
export function resolveEnv(host: HostRuntime, mainDir: string): AppEnv {
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
        isPackaged: host.isPackaged,
        devServerUrl,
        appName: host.getName(),
        appVersion: host.getVersion(),
        appLocale: host.getLocale(),
        userDataPath: host.getPath('userData'),
        mainDir,
        preloadPath: path.join(mainDir, 'preload.cjs'),
        rendererEntry,
        allowedFrameOrigins,
    };
}
