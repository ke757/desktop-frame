import { z } from 'zod';

/**
 * 类型化的 RPC 端点。`channel` 即 ipcMain.handle 的 channel 名；
 * `input`/`output` 是描述线上格式的 zod schema。
 */
export interface Procedure<
    I extends z.ZodType = z.ZodType,
    O extends z.ZodType = z.ZodType,
> {
    /** 判别字段：固定为 'procedure'。 */
    readonly kind: 'procedure';
    /** IPC channel 名。 */
    readonly channel: string;
    /** 输入参数的 zod schema。 */
    readonly input: I;
    /** 输出结果的 zod schema。 */
    readonly output: O;
}

/** 定义一个类型化 RPC 端点。 */
export function procedure<I extends z.ZodType, O extends z.ZodType>(
    channel: string,
    input: I,
    output: O,
): Procedure<I, O> {
    return { kind: 'procedure', channel, input, output };
}

/** 类型化的 main→renderer 事件。 */
export interface EventDefinition<P extends z.ZodType = z.ZodType> {
    /** 判别字段：固定为 'event'。 */
    readonly kind: 'event';
    /** IPC channel 名。 */
    readonly channel: string;
    /** 事件负载的 zod schema。 */
    readonly payload: P;
}

/** 定义一个类型化事件。 */
export function event<P extends z.ZodType>(
    channel: string,
    payload: P,
): EventDefinition<P> {
    return { kind: 'event', channel, payload };
}

/** 调用方需要为 procedure 提供的输入类型。 */
export type ProcedureInput<P> =
    P extends Procedure<infer I, z.ZodType> ? z.input<I> : never;

/** 调用方从 procedure 收到的输出类型。 */
export type ProcedureOutput<P> =
    P extends Procedure<z.ZodType, infer O> ? z.output<O> : never;

/** 事件订阅者收到的负载类型。 */
export type EventPayload<E> = E extends EventDefinition<infer P> ? z.output<P> : never;

/** 无输入 procedure 的占位 schema。 */
export const voidInput = z.undefined();
