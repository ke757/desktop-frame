import { BrowserWindow } from 'electron';
import type { AppEnv } from '../core/env';
import type { WindowDefinition } from './manager';

/** 主窗口定义 id。 */
export const MAIN_WINDOW_ID = 'main';

/**
 * 所有应用窗口的标准安全基线：沙箱 preload、禁用 node 集成、
 * 开启 context 隔离（Electron 20+ 的默认值，这里显式声明）。
 */
function secureWebPreferences(env: AppEnv): Electron.WebPreferences {
    return {
        preload: env.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
    };
}

/** 主窗口定义：1080x720，ready-to-show 后显示。 */
export function createMainWindowDefinition(): WindowDefinition {
    return {
        id: MAIN_WINDOW_ID,
        isPrimary: true,
        create(env) {
            return new BrowserWindow({
                width: 1080,
                height: 720,
                show: false,
                autoHideMenuBar: true,
                title: env.appName,
                webPreferences: secureWebPreferences(env),
            });
        },
    };
}
