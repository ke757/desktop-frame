import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { procedure, RpcError } from '@desktop-frame/contracts';
import { ServiceContainer } from '../src/main/core/kernel/container';
import { EventPublisherImpl } from '../src/main/core/ipc/events';
import { IpcRouter } from '../src/main/core/ipc/router';
import type { IpcListener, IpcTransport } from '../src/main/core/spi/ipc-transport';
import { Lifecycle } from '../src/main/core/kernel/lifecycle';
import { MemoryLogger } from '../src/main/core/kernel/logging';
import { makeAppHandle, makeEnv } from './fakes';

/** 测试用 echo procedure。 */
const echo = procedure(
    't.echo',
    z.object({ message: z.string() }),
    z.object({ message: z.string() }),
);

/** 记录 listener 的假 transport，可按 channel 模拟调用。 */
class RecordingTransport implements IpcTransport {
    readonly listeners = new Map<string, IpcListener>();

    handle(channel: string, listener: IpcListener): void {
        this.listeners.set(channel, listener);
    }

    /** 以指定 frame 来源发起一次调用。 */
    call(channel: string, payload: unknown, frameUrl = 'http://localhost:5173/') {
        const listener = this.listeners.get(channel);
        if (!listener) throw new Error(`no listener for ${channel}`);
        return listener(payload, { webContentsId: 1, frameUrl });
    }
}

/** 路由测试夹具。 */
interface Fixture {
    router: IpcRouter;
    transport: RecordingTransport;
    lifecycle: Lifecycle;
    container: ServiceContainer;
    app: ReturnType<typeof makeAppHandle>;
    sink: { sent: Array<{ channel: string; payload: unknown }> };
    logger: MemoryLogger;
}

/** 组装一套路由及其依赖（AppHandle 由内存实现组装）。 */
function createFixture(): Fixture {
    const logger = new MemoryLogger();
    const lifecycle = new Lifecycle(logger.child('lifecycle'));
    const container = new ServiceContainer(makeAppHandle());
    const sink = {
        sent: [] as Array<{ channel: string; payload: unknown }>,
        send(channel: string, payload: unknown) {
            this.sent.push({ channel, payload });
        },
    };
    const events = new EventPublisherImpl(sink, logger);
    // 路由直接消费受限应用上下文（来源白名单/门禁/根 logger 都来自它）。
    const app = makeAppHandle({
        logger,
        events,
        lifecycle,
        env: {
            ...makeEnv(true),
            allowedFrameOrigins: ['http://localhost:5173'],
        },
    });
    const router = new IpcRouter({ app, services: container });
    const transport = new RecordingTransport();
    return { router, transport, lifecycle, container, app, sink, logger };
}

describe('IpcRouter', () => {
    it('完整快乐路径：校验输入、调用 handler、校验输出', async () => {
        const fx = createFixture();
        fx.router.handle(echo, (_ctx, input) => ({ message: input.message }));
        fx.router.install(fx.transport);
        fx.lifecycle.transition('ready');

        const result = await fx.transport.call('t.echo', { message: 'hi' });
        expect(result).toEqual({ ok: true, data: { message: 'hi' } });
    });

    it('拒绝白名单之外来源的调用', async () => {
        const fx = createFixture();
        fx.router.handle(echo, (_ctx, input) => ({ message: input.message }));
        fx.router.install(fx.transport);
        fx.lifecycle.transition('ready');

        const result = await fx.transport.call(
            't.echo',
            { message: 'hi' },
            'https://evil.example/',
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('FORBIDDEN');
    });

    it('后端未 ready 时拒绝调用', async () => {
        const fx = createFixture();
        fx.router.handle(echo, (_ctx, input) => ({ message: input.message }));
        fx.router.install(fx.transport);

        const result = await fx.transport.call('t.echo', { message: 'hi' });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe('UNAVAILABLE');
            expect(result.error.message).toMatch(/initializing/);
        }
    });

    it('非法输入返回 VALIDATION 及 issue 详情', async () => {
        const fx = createFixture();
        fx.router.handle(echo, (_ctx, input) => ({ message: input.message }));
        fx.router.install(fx.transport);
        fx.lifecycle.transition('ready');

        const result = await fx.transport.call('t.echo', { message: 42 });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe('VALIDATION');
            expect(result.error.data).toBeDefined();
        }
    });

    it('handler 抛出的 RpcError 错误码原样保留', async () => {
        const fx = createFixture();
        fx.router.handle(echo, () => {
            throw new RpcError('BUSINESS_RULE', 'cannot do that', { field: 'x' });
        });
        fx.router.install(fx.transport);
        fx.lifecycle.transition('ready');

        const result = await fx.transport.call('t.echo', { message: 'hi' });
        expect(result).toEqual({
            ok: false,
            error: {
                code: 'BUSINESS_RULE',
                message: 'cannot do that',
                data: { field: 'x' },
            },
        });
    });

    it('handler 的意外错误映射为 INTERNAL', async () => {
        const fx = createFixture();
        fx.router.handle(echo, () => {
            throw new Error('surprise');
        });
        fx.router.install(fx.transport);
        fx.lifecycle.transition('ready');

        const result = await fx.transport.call('t.echo', { message: 'hi' });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe('INTERNAL');
            expect(result.error.message).toBe('surprise');
        }
        expect(
            fx.logger.entries.some((entry) =>
                entry.message.includes('unhandled IPC handler failure'),
            ),
        ).toBe(true);
    });

    it('handler 输出违反 schema 映射为 INTERNAL', async () => {
        const fx = createFixture();
        fx.router.handle(echo, () => ({ wrong: 'shape' }) as never);
        fx.router.install(fx.transport);
        fx.lifecycle.transition('ready');

        const result = await fx.transport.call('t.echo', { message: 'hi' });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('INTERNAL');
    });

    it('per-call 上下文：ctx.app 是组装的 AppHandle，ctx.log 是 channel 子 logger', async () => {
        const fx = createFixture();
        const seen: string[] = [];
        fx.router.handle(echo, async (ctx, input) => {
            seen.push(ctx.sender.frameUrl);
            // 内核能力经 ctx.app（受限门面），业务服务经 ctx.services。
            expect(ctx.app).toBe(fx.app);
            expect(ctx.app.env.allowedFrameOrigins).toContain('http://localhost:5173');
            expect(ctx.app.lifecycle.state).toBe('ready');
            expect(ctx.services).toBeDefined();
            // 直接的内核能力字段已移除：事件发布只能走 ctx.app.events。
            expect('events' in ctx).toBe(false);
            // ctx.log 是本 channel 的子 logger（写入带 channel 标签）。
            ctx.log.info('handler log');
            return { message: input.message };
        });
        fx.router.install(fx.transport);
        fx.lifecycle.transition('ready');

        await fx.transport.call('t.echo', { message: 'hi' });
        expect(seen).toEqual(['http://localhost:5173/']);
        expect(
            fx.logger.entries.some(
                (entry) =>
                    entry.level === 'info' && entry.message === '[t.echo] handler log',
            ),
        ).toBe(true);
    });

    it('handler 可经 ctx.app.events 发布事件（schema 校验后广播）', async () => {
        const fx = createFixture();
        const ping = {
            kind: 'event' as const,
            channel: 't.ping',
            payload: z.object({ at: z.number() }),
        };
        fx.router.handle(echo, (ctx, input) => {
            ctx.app.events.publish(ping, { at: input.message.length });
            return { message: input.message };
        });
        fx.router.install(fx.transport);
        fx.lifecycle.transition('ready');

        await fx.transport.call('t.echo', { message: 'hi' });
        expect(fx.sink.sent).toEqual([{ channel: 't.ping', payload: { at: 2 } }]);
    });

    it('重复注册同一 channel 抛错', () => {
        const fx = createFixture();
        fx.router.handle(echo, (_ctx, input) => ({ message: input.message }));
        expect(() =>
            fx.router.handle(echo, (_ctx, input) => ({ message: input.message })),
        ).toThrow(/already handled/);
    });
});

describe('EventPublisher', () => {
    it('按事件 schema 校验负载', () => {
        const logger = new MemoryLogger();
        const sink = {
            sent: [] as Array<{ channel: string; payload: unknown }>,
            send(channel: string, payload: unknown) {
                this.sent.push({ channel, payload });
            },
        };
        const events = new EventPublisherImpl(sink, logger);

        events.publish(echoAsEvent(), { message: 'ok' });
        expect(sink.sent).toEqual([{ channel: 't.echo', payload: { message: 'ok' } }]);

        events.publish(echoAsEvent(), { message: 42 } as never);
        expect(sink.sent).toHaveLength(1);
        expect(
            logger.entries.some((entry) =>
                entry.message.includes('event payload rejected'),
            ),
        ).toBe(true);
    });
});

/** 测试用事件定义。 */
function echoAsEvent() {
    return {
        kind: 'event' as const,
        channel: 't.echo',
        payload: z.object({ message: z.string() }),
    };
}
