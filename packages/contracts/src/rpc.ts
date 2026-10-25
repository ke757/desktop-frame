/**
 * 主进程、preload 桥与 web client 共享的 RPC 信封协议。
 *
 * Electron 的 `ipcMain.handle` 跨 IPC 只保留 `error.message`（V8 结构化克隆
 * 会丢弃自定义属性，见 electron#24427），contextBridge 还会再剥离一次。因此
 * handler 永不 reject：所有调用都 resolve 一个 `RpcResult` 信封，结构化错误
 * 随信封传递。
 */

/** 框架自身会发出的错误码。 */
export const RPC_FRAMEWORK_ERROR_CODES = [
    'VALIDATION',
    'FORBIDDEN',
    'UNAVAILABLE',
    'INTERNAL',
    'BRIDGE_ERROR',
] as const;

export type RpcFrameworkErrorCode = (typeof RPC_FRAMEWORK_ERROR_CODES)[number];

/**
 * 错误码是开放集合：业务代码可以用 `RpcError` 抛出任意自定义错误码，
 * 上面的字面量联合仅用于编辑器补全。
 */
export type RpcErrorCode = RpcFrameworkErrorCode | (string & {});

/** 随信封传递的错误负载。 */
export interface RpcErrorPayload {
    /** 稳定的机器可读错误码。 */
    code: RpcErrorCode;
    /** 人类可读的错误描述。 */
    message: string;
    /** 可选的结构化附加信息（必须可被结构化克隆）。 */
    data?: unknown;
}

/** RPC 调用的统一返回信封：成功携带 data，失败携带 error。 */
export type RpcResult<T> = { ok: true; data: T } | { ok: false; error: RpcErrorPayload };

/** 主进程 handler 抛出的可序列化业务错误。 */
export class RpcError extends Error {
    /** 机器可读错误码。 */
    readonly code: RpcErrorCode;
    /** 结构化附加信息。 */
    readonly data: unknown;

    constructor(code: RpcErrorCode, message: string, data?: unknown) {
        super(message);
        this.name = 'RpcError';
        this.code = code;
        this.data = data;
    }

    /** 转换为可随信封传递的负载。 */
    toPayload(): RpcErrorPayload {
        return { code: this.code, message: this.message, data: this.data };
    }

    /** 从信封负载重建 RpcError（client 侧使用）。 */
    static from(payload: RpcErrorPayload): RpcError {
        return new RpcError(payload.code, payload.message, payload.data);
    }
}

/** 构造成功信封。 */
export function ok<T>(data: T): RpcResult<T> {
    return { ok: true, data };
}

/** 构造失败信封。 */
export function err(
    code: RpcErrorCode,
    message: string,
    data?: unknown,
): RpcResult<never> {
    return { ok: false, error: { code, message, data } };
}
