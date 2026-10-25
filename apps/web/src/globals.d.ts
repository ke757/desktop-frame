import type { DesktopBridge } from '@desktop-frame/contracts';

// preload 通过 contextBridge 注入的桥（无 Electron 环境时不存在）。
declare global {
    interface Window {
        desktop?: DesktopBridge;
    }
}

export {};
