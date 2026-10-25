import { app } from 'electron';
import type { BeforeQuitEvent, HostApp } from '../core/ports/host';

/** 把 electron 的 `app` 模块适配为接口 HostApp。 */
export function createElectronHost(): HostApp {
    return {
        isPackaged: app.isPackaged,
        getName: () => app.getName(),
        getVersion: () => app.getVersion(),
        getLocale: () => app.getLocale(),
        getPath: (name) => app.getPath(name),
        whenReady: () => app.whenReady(),
        quit: () => app.quit(),
        exit: (code) => app.exit(code),
        requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
        onBeforeQuit: (listener) => {
            app.on('before-quit', (event) => listener(event as BeforeQuitEvent));
        },
        onWindowAllClosed: (listener) => {
            app.on('window-all-closed', listener);
        },
        onActivate: (listener) => {
            app.on('activate', listener);
        },
        onSecondInstance: (listener) => {
            app.on('second-instance', (_event, argv) => listener(argv));
        },
    };
}
