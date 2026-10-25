import type { RpcResult } from '@desktop-frame/contracts';

/** 每次调用中关于调用方 renderer 的信息。 */
export interface IpcCallInfo {
    /** 调用方 webContents id（窗口关联、定向回复用）。 */
    webContentsId: number;
    /** 调用方 frame 的 URL（来源白名单校验用）。 */
    frameUrl: string;
}

/** 传输层 listener：必须以 RpcResult 信封 resolve，永不 reject。 */
export type IpcListener = (
    payload: unknown,
    info: IpcCallInfo,
) => Promise<RpcResult<unknown>>;

/**
 * IPC 传输端口：路由与 electron ipcMain 之间的接缝，
 * 由 `electron/ipc-transport.ts` 实现；集成测试用 FakeTransport。
 */
export interface IpcTransport {
    /** 登记一个 channel 的处理 listener（由 Router.install 调用）。 */
    handle(channel: string, listener: IpcListener): void;
}
