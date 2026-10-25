import { describe, expect, it, vi } from 'vitest';
import { Lifecycle } from '../src/app/core/lifecycle';
import { MemoryLogger } from '../src/app/core/logging';

describe('Lifecycle', () => {
    it('初始状态为 initializing', () => {
        expect(new Lifecycle().state).toBe('initializing');
    });

    it('只进迁移并通知监听器', () => {
        const lifecycle = new Lifecycle();
        const changes: string[] = [];
        lifecycle.onChange((change) => changes.push(`${change.from}->${change.to}`));

        lifecycle.transition('ready');
        expect(lifecycle.state).toBe('ready');
        expect(changes).toEqual(['initializing->ready']);
    });

    it('拒绝回退迁移', () => {
        const lifecycle = new Lifecycle();
        lifecycle.transition('ready');
        expect(() => lifecycle.transition('initializing')).toThrow(/backwards/);
    });

    it('置同态为 no-op', () => {
        const lifecycle = new Lifecycle();
        const listener = vi.fn();
        lifecycle.onChange(listener);
        lifecycle.transition('ready');
        lifecycle.transition('ready');
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('when() 对已达状态立即 resolve、未达状态延后 resolve', async () => {
        const lifecycle = new Lifecycle();
        await expect(lifecycle.when('initializing')).resolves.toBeUndefined();

        let resolved = false;
        void lifecycle.when('exited').then(() => {
            resolved = true;
        });
        lifecycle.transition('ready');
        expect(resolved).toBe(false);
        await lifecycle.shutdown();
        expect(resolved).toBe(true);
    });

    it('shutdown joiner 按注册顺序串行执行', async () => {
        const lifecycle = new Lifecycle();
        const order: string[] = [];
        lifecycle.onShutdown(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            order.push('first');
        });
        lifecycle.onShutdown(() => {
            order.push('second');
        });

        await lifecycle.shutdown();
        expect(order).toEqual(['first', 'second']);
        expect(lifecycle.state).toBe('exited');
    });

    it('单个 joiner 失败不中断管线', async () => {
        const logger = new MemoryLogger();
        const lifecycle = new Lifecycle(logger);
        lifecycle.onShutdown(() => {
            throw new Error('joiner boom');
        });
        let secondRan = false;
        lifecycle.onShutdown(() => {
            secondRan = true;
        });

        await lifecycle.shutdown();
        expect(secondRan).toBe(true);
        expect(lifecycle.state).toBe('exited');
        expect(
            logger.entries.some((entry) => entry.message === 'shutdown joiner failed'),
        ).toBe(true);
    });

    it('shutdown 幂等且忽略迟到的 joiner', async () => {
        const lifecycle = new Lifecycle();
        const first = vi.fn();
        lifecycle.onShutdown(first);
        await lifecycle.shutdown();
        await lifecycle.shutdown();

        const logger = new MemoryLogger();
        const late = new Lifecycle(logger);
        await late.shutdown();
        late.onShutdown(() => {
            throw new Error('should never run');
        });
        expect(late.state).toBe('exited');
        expect(first).toHaveBeenCalledTimes(1);
    });
});
