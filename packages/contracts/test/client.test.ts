import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { procedure } from '../src/procedure';
import { createClient, IpcError, type DesktopBridge, type RpcResult } from '../src';

/** 供测试使用的 echo procedure。 */
const echo = procedure(
    't.echo',
    z.object({ message: z.string() }),
    z.object({ message: z.string() }),
);

/** 构造记录调用、可编程返回的假桥。 */
function fakeBridge() {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const handlers = new Map<string, (payload: unknown) => Promise<RpcResult<unknown>>>();
    const bridge: DesktopBridge = {
        invoke: async (channel, payload) => {
            sent.push({ channel, payload });
            const handler = handlers.get(channel);
            if (!handler) throw new Error(`No handler registered for '${channel}'`);
            return handler(payload);
        },
        on: () => () => {},
    };
    return { bridge, sent, handlers };
}

describe('client', () => {
    it('解包 ok 信封并校验输出', async () => {
        const { bridge, handlers } = fakeBridge();
        handlers.set('t.echo', async () => ({ ok: true, data: { message: 'pong' } }));
        const client = createClient(bridge);
        await expect(client.invoke(echo, { message: 'ping' })).resolves.toEqual({
            message: 'pong',
        });
    });

    it('错误信封抛出 IpcError', async () => {
        const { bridge, handlers } = fakeBridge();
        handlers.set('t.echo', async () => ({
            ok: false,
            error: { code: 'DEMO', message: 'nope', data: { hint: 1 } },
        }));
        const client = createClient(bridge);
        const failure = await client
            .invoke(echo, { message: 'x' })
            .catch((error) => error);
        expect(failure).toBeInstanceOf(IpcError);
        expect(failure.code).toBe('DEMO');
        expect(failure.data).toEqual({ hint: 1 });
    });

    it('桥的原始 reject 包装为 BRIDGE_ERROR', async () => {
        const { bridge } = fakeBridge();
        const client = createClient(bridge);
        const failure = await client
            .invoke(echo, { message: 'x' })
            .catch((error) => error);
        expect(failure).toBeInstanceOf(IpcError);
        expect(failure.code).toBe('BRIDGE_ERROR');
    });
});
