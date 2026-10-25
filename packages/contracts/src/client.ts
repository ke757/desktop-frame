import type {
    EventDefinition,
    EventPayload,
    Procedure,
    ProcedureInput,
    ProcedureOutput,
} from './procedure';
import type { RpcResult } from './rpc';

/**
 * preload 脚本通过 contextBridge 暴露的最小面。刻意保持通用
 * （string channel + unknown payload），使 preload 产物不随契约演进而变化。
 */
export interface DesktopBridge {
    /** 发起一次 RPC 调用，永不 reject，返回 RpcResult 信封。 */
    invoke(channel: string, payload: unknown): Promise<RpcResult<unknown>>;
    /** 订阅事件，返回取消订阅函数。 */
    on(channel: string, listener: (payload: unknown) => void): () => void;
}

/** 读取 preload 注入的桥（若存在）。 */
export function getDesktopBridge(): DesktopBridge | undefined {
    const scope = globalThis as { desktop?: DesktopBridge };
    return scope.desktop;
}

/** client 侧对 `ok:false` 信封或桥故障抛出的错误。 */
export class IpcError extends Error {
    /** 机器可读错误码。 */
    readonly code: string;
    /** 结构化附加信息。 */
    readonly data: unknown;

    constructor(code: string, message: string, data?: unknown) {
        super(message);
        this.name = 'IpcError';
        this.code = code;
        this.data = data;
    }
}

/** 参数元组：仅无输入（void）procedure 的入参可省略。 */
type InvokeArgs<I> = undefined extends I ? [input?: I] : [input: I];

/** 类型化的桌面调用 client。 */
export interface DesktopClient {
    /** 调用 procedure：校验输出并解包信封，失败抛 IpcError。 */
    invoke<P extends Procedure>(
        proc: P,
        ...input: InvokeArgs<ProcedureInput<P>>
    ): Promise<ProcedureOutput<P>>;
    /** 订阅事件（负载经 schema 校验），返回取消订阅函数。 */
    on<E extends EventDefinition>(
        evt: E,
        listener: (payload: EventPayload<E>) => void,
    ): () => void;
}

/**
 * 把原始桥包装为类型化、带校验的 client。输出在这里重新校验一次，
 * 作为独立部署的 main 与 web 产物之间廉价的契约漂移防线。
 */
export function createClient(bridge: DesktopBridge): DesktopClient {
    const invoke = async <P extends Procedure>(
        proc: P,
        ...args: InvokeArgs<ProcedureInput<P>>
    ): Promise<ProcedureOutput<P>> => {
        const input = args[0];
        let result: RpcResult<unknown>;
        try {
            result = await bridge.invoke(proc.channel, input);
        } catch (cause) {
            // 例如后端尚未安装路由时 ipcRenderer.invoke 直接 reject。
            const message = cause instanceof Error ? cause.message : String(cause);
            throw new IpcError('BRIDGE_ERROR', message);
        }
        if (!result.ok) {
            throw new IpcError(
                result.error.code,
                result.error.message,
                result.error.data,
            );
        }
        return proc.output.parse(result.data) as ProcedureOutput<P>;
    };

    const on = <E extends EventDefinition>(
        evt: E,
        listener: (payload: EventPayload<E>) => void,
    ): (() => void) =>
        bridge.on(evt.channel, (raw) => {
            listener(evt.payload.parse(raw) as EventPayload<E>);
        });

    return { invoke, on };
}
