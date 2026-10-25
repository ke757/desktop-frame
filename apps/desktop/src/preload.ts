import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, RpcResult } from '@desktop-frame/contracts';

/**
 * 沙箱 preload 桥（Electron 45 没有 Buffer/events/timers shim——
 * 本文件只能使用 `electron` 模块与标准 Web API）。
 *
 * 桥刻意保持通用（string channel + unknown payload），全部类型与校验都在
 * @desktop-frame/contracts 中；契约演进不需要改动 preload。绝不暴露
 * `ipcRenderer` 本体（安全检查表 #20），且每个订阅都返回取消订阅函数。
 */
const listeners = new Map<string, Set<(payload: unknown) => void>>();

/** 订阅指定 channel（同一 channel 内多路复用），返回取消订阅函数。 */
function subscribe(channel: string, listener: (payload: unknown) => void): () => void {
    let channelListeners = listeners.get(channel);
    if (!channelListeners) {
        // 首个订阅者负责挂接 ipcRenderer 监听，向 channel 内所有订阅者分发。
        const subscribers = new Set<(payload: unknown) => void>();
        listeners.set(channel, subscribers);
        ipcRenderer.on(channel, (_event, payload) => {
            for (const entry of subscribers) entry(payload);
        });
        channelListeners = subscribers;
    }
    channelListeners.add(listener);

    return () => {
        const current = listeners.get(channel);
        if (!current) return;
        current.delete(listener);
        // 最后一个订阅者移除时才真正卸载 ipcRenderer 监听，避免泄漏。
        if (current.size === 0) {
            listeners.delete(channel);
            ipcRenderer.removeAllListeners(channel);
        }
    };
}

/** 暴露给 renderer 的桥实现：通用 invoke + 订阅。 */
const bridge: DesktopBridge = {
    invoke: (channel, payload) =>
        ipcRenderer.invoke(channel, payload) as Promise<RpcResult<unknown>>,
    on: subscribe,
};

contextBridge.exposeInMainWorld('desktop', bridge);
