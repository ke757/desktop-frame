import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { procedure, RpcError } from '@desktop-frame/contracts';
import { ServiceContainer } from '../src/app/core/container';
import type { AppEnv } from '../src/app/core/env';
import { EventPublisher } from '../src/app/core/ipc/events';
import { IpcRouter } from '../src/app/core/ipc/router';
import type { IpcListener, IpcTransport } from '../src/app/core/ipc/router';
import { Lifecycle } from '../src/app/core/lifecycle';
import { MemoryLogger } from '../src/app/core/logging';

/** 测试用 echo procedure。 */
const echo = procedure(
    't.echo',
    z.object({ message: z.string() }),
    z.object({ message: z.string() }),
);

/** 构造测试用环境（可按需覆盖字段）。 */
function fakeEnv(overrides: Partial<AppEnv> = {}): AppEnv {
    return {
        isDev: true,
        devServerUrl: 'http://localhost:5173',
        appName: 'test',
        appVersion: '0.0.0',
        userDataPath: '/tmp',
        mainDir: '/tmp',
        preloadPath: '/tmp/preload.cjs',
        rendererEntry: { kind: 'url', url: 'http://localhost:5173' },
        allowedFrameOrigins: ['http://localhost:5173'],
        ...overrides,
    };
}

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
    sink: { sent: Array<{ channel: string; payload: unknown }> };
    logger: MemoryLogger;
}

/** 组装一套路由及其依赖。 */
function createFixture(): Fixture {
    const logger = new MemoryLogger();
    const lifecycle = new Lifecycle();
    const container = new ServiceContainer();
    const sink = {
        sent: [] as Array<{ channel: string; payload: unknown }>,
        send(channel: string, payload: unknown) {
            this.sent.push({ channel, payload });
        },
    };
    const events = new EventPublisher(sink, logger);
    const router = new IpcRouter({
        services: container,
        lifecycle,
        env: fakeEnv(),
        logger,
        events,
    });
    const transport = new RecordingTransport();
    return { router, transport, lifecycle, container, sink, logger };
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

    it('per-call 上下文已接好容器', async () => {
        const fx = createFixture();
        const seen: string[] = [];
        fx.router.handle(echo, async (ctx, input) => {
            seen.push(ctx.sender.frameUrl);
            expect(ctx.services).toBeDefined();
            expect(ctx.events).toBeDefined();
            expect(ctx.state).toBe('ready');
            return { message: input.message };
        });
        fx.router.install(fx.transport);
        fx.lifecycle.transition('ready');

        await fx.transport.call('t.echo', { message: 'hi' });
        expect(seen).toEqual(['http://localhost:5173/']);
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
        const events = new EventPublisher(sink, logger);

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
