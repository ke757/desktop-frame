import { describe, expect, it } from 'vitest';
import {
    defineService,
    serviceToken,
    ServiceContainer,
    UnknownServiceError,
    CyclicDependencyError,
} from '../src/main/core/container';
import { MemoryLogger } from '../src/main/core/logging';

/** 测试用示例服务接口。 */
interface Repo {
    name: string;
    disposed?: boolean;
}

describe('ServiceContainer', () => {
    it('惰性创建并 memoize 实例', async () => {
        let created = 0;
        const repoToken = serviceToken<Repo>('repo');
        const container = new ServiceContainer();
        container.register(
            defineService(repoToken, () => {
                created += 1;
                return { name: 'repo' };
            }),
        );

        expect(created).toBe(0);
        const a = await container.get(repoToken);
        const b = await container.get(repoToken);
        expect(created).toBe(1);
        expect(a).toBe(b);
    });

    it('通过 accessor 注入依赖', async () => {
        const repoToken = serviceToken<Repo>('repo');
        const serviceToken2 = serviceToken<{ repo: Repo }>('service');
        const container = new ServiceContainer();
        container.register(defineService(repoToken, () => ({ name: 'repo' })));
        container.register(
            defineService(serviceToken2, async (accessor) => ({
                repo: await accessor.get(repoToken),
            })),
        );

        const service = await container.get(serviceToken2);
        expect(service.repo.name).toBe('repo');
    });

    it('按实例化逆序 dispose', async () => {
        const order: string[] = [];
        const aToken = serviceToken<{ dispose(): void }>('a');
        const bToken = serviceToken<{ dispose(): void }>('b');
        const container = new ServiceContainer();
        container.register(
            defineService(aToken, () => ({
                dispose: () => order.push('a'),
            })),
        );
        container.register(
            defineService(bToken, async (accessor) => {
                await accessor.get(aToken);
                return { dispose: () => order.push('b') };
            }),
        );

        await container.get(bToken);
        await container.dispose();
        expect(order).toEqual(['b', 'a']);
    });

    it('单个服务 dispose 抛错不阻断其余清理', async () => {
        const logger = new MemoryLogger();
        const badToken = serviceToken<{ dispose(): void }>('bad');
        const goodToken = serviceToken<{ disposed: boolean }>('good');
        const container = new ServiceContainer(logger);
        container.register(
            defineService(badToken, () => ({
                dispose: () => {
                    throw new Error('boom');
                },
            })),
        );
        container.register(defineService(goodToken, () => ({ disposed: false })));

        await container.get(badToken);
        await container.get(goodToken);
        await container.dispose();

        expect(
            logger.entries.some(
                (entry) =>
                    entry.level === 'error' && entry.message === 'service dispose failed',
            ),
        ).toBe(true);
    });

    it('未注册的 token 报错且信息可读', async () => {
        const container = new ServiceContainer();
        await expect(container.get(serviceToken('nope'))).rejects.toBeInstanceOf(
            UnknownServiceError,
        );
    });

    it('重复注册抛错', () => {
        const token = serviceToken('dup');
        const container = new ServiceContainer();
        container.register(defineService(token, () => ({})));
        expect(() => container.register(defineService(token, () => ({})))).toThrow(
            /already registered/,
        );
    });

    it('检测循环依赖', async () => {
        const aToken = serviceToken('cyc-a');
        const bToken = serviceToken('cyc-b');
        const container = new ServiceContainer();
        container.register(
            defineService(aToken, async (accessor) => accessor.get(bToken)),
        );
        container.register(
            defineService(bToken, async (accessor) => accessor.get(aToken)),
        );

        await expect(container.get(aToken)).rejects.toBeInstanceOf(CyclicDependencyError);
    });

    it('失败的工厂不被 memoize（可重试）', async () => {
        let attempts = 0;
        const token = serviceToken<number>('flaky');
        const container = new ServiceContainer();
        container.register(
            defineService(token, () => {
                attempts += 1;
                if (attempts === 1) throw new Error('first try fails');
                return attempts;
            }),
        );

        await expect(container.get(token)).rejects.toThrow('first try fails');
        await expect(container.get(token)).resolves.toBe(2);
    });

    it('dispose 之后拒绝 get', async () => {
        const token = serviceToken('late');
        const container = new ServiceContainer();
        container.register(defineService(token, () => ({})));
        await container.get(token);
        await container.dispose();
        await expect(container.get(token)).rejects.toThrow(/disposed/);
    });
});
