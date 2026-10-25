import { ipcMain } from 'electron';
import type { IpcListener, IpcTransport } from './core/ipc/router';

/**
 * 把路由绑定到 electron 的 ipcMain。listener 恒以信封 resolve；
 * 这里若出现原始 reject，只可能是路由自身抛错（路由内部已防护）。
 */
export function createElectronIpcTransport(): IpcTransport {
    return {
        handle(channel, listener: IpcListener) {
            ipcMain.handle(channel, (event, payload) =>
                listener(payload, {
                    webContentsId: event.sender.id,
                    frameUrl: event.senderFrame?.url ?? '',
                }),
            );
        },
    };
}
