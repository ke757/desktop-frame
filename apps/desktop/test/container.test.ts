import { describe, expect, it } from 'vitest';
import {
    ContainerDisposedError,
    CyclicDependencyError,
    ServiceContainer,
    UnknownServiceError,
} from '../src/main/core/kernel/container';
import { defineService, serviceToken } from '../src/main/core';
import type { AppHandle } from '../src/main/core';
import { MemoryLogger } from '../src/main/core/kernel/logging';
import { makeAppHandle } from './fakes';

/** 测试用示例服务接口。 */
interface Repo {
    name: string;
    disposed?: boolean;
}

describe('ServiceContainer', () => {
    it('惰性创建并 memoize 实例', async () => {
        let created = 0;
        const repoToken = serviceToken<Repo>('repo');
        const container = new ServiceContainer(makeAppHandle());
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
        const container = new ServiceContainer(makeAppHandle());
        container.register(defineService(repoToken, () => ({ name: 'repo' })));
        container.register(
            defineService(serviceToken2, async (ctx) => ({
                repo: await ctx.services.get(repoToken),
            })),
        );

        const service = await container.get(serviceToken2);
        expect(service.repo.name).toBe('repo');
    });

    it('按实例化逆序 dispose', async () => {
        const order: string[] = [];
        const aToken = serviceToken<{ dispose(): void }>('a');
        const bToken = serviceToken<{ dispose(): void }>('b');
        const container = new ServiceContainer(makeAppHandle());
        container.register(
            defineService(aToken, () => ({
                dispose: () => order.push('a'),
            })),
        );
        container.register(
            defineService(bToken, async (ctx) => {
                await ctx.services.get(aToken);
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
        const container = new ServiceContainer(makeAppHandle(), logger);
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
        const container = new ServiceContainer(makeAppHandle());
        await expect(container.get(serviceToken('nope'))).rejects.toBeInstanceOf(
            UnknownServiceError,
        );
    });

    it('重复注册抛错', () => {
        const token = serviceToken('dup');
        const container = new ServiceContainer(makeAppHandle());
        container.register(defineService(token, () => ({})));
        expect(() => container.register(defineService(token, () => ({})))).toThrow(
            /already registered/,
        );
    });

    it('检测循环依赖', async () => {
        const aToken = serviceToken('cyc-a');
        const bToken = serviceToken('cyc-b');
        const container = new ServiceContainer(makeAppHandle());
        container.register(
            defineService(aToken, async (ctx) => ctx.services.get(bToken)),
        );
        container.register(
            defineService(bToken, async (ctx) => ctx.services.get(aToken)),
        );

        await expect(container.get(aToken)).rejects.toBeInstanceOf(CyclicDependencyError);
    });

    it('失败的工厂不被 memoize（可重试）', async () => {
        let attempts = 0;
        const token = serviceToken<number>('flaky');
        const container = new ServiceContainer(makeAppHandle());
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
        const container = new ServiceContainer(makeAppHandle());
        container.register(defineService(token, () => ({})));
        await container.get(token);
        await container.dispose();
        await expect(container.get(token)).rejects.toThrow(/disposed/);
    });

    it('工厂上下文：所有工厂拿到同一 AppHandle（内核能力不经容器）', async () => {
        const seen: AppHandle[] = [];
        const aToken = serviceToken<{ app: AppHandle }>('ctx-a');
        const bToken = serviceToken<{ app: AppHandle; a: { app: AppHandle } }>('ctx-b');
        const app = makeAppHandle();
        const container = new ServiceContainer(app);
        container.register(
            defineService(aToken, (ctx) => {
                seen.push(ctx.app);
                return { app: ctx.app };
            }),
        );
        container.register(
            defineService(bToken, async (ctx) => {
                // 业务依赖仍经 ctx.services 解析（scoped accessor）。
                const a = await ctx.services.get(aToken);
                seen.push(ctx.app);
                return { app: ctx.app, a };
            }),
        );

        const b = await container.get(bToken);
        // 同一容器实例共享构造注入的同一个 AppHandle。
        expect(seen[0]).toBe(app);
        expect(seen[1]).toBe(app);
        expect(b.a.app).toBe(app);
    });

    it('内核能力不是容器服务：未注册的 core.* 形状 token 不可解析', async () => {
        const container = new ServiceContainer(makeAppHandle());
        // 容器只登记业务/应用服务——任何内核能力形状的 token（这里以
        // 'core.env' 为代表）都没有注册，经 ctx.services 也不可解析。
        await expect(container.get(serviceToken('core.env'))).rejects.toBeInstanceOf(
            UnknownServiceError,
        );
    });
});

describe('ServiceContainer（并发解析）', () => {
    /** 等待若干宏任务，让并发的工厂都有机会推进。 */
    const tick = (ms = 5): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));

    it('同 token 冷启动并发：共享同一次创建，不误报循环依赖', async () => {
        let created = 0;
        const token = serviceToken<{ n: number }>('cold');
        const container = new ServiceContainer(makeAppHandle());
        container.register(
            defineService(token, async () => {
                created += 1;
                await tick();
                return { n: created };
            }),
        );

        const [a, b, c] = await Promise.all([
            container.get(token),
            container.get(token),
            container.get(token),
        ]);
        expect(created).toBe(1);
        expect(a).toBe(b);
        expect(b).toBe(c);
    });

    it('独立服务并发：乱序完成互不干扰', async () => {
        const aToken = serviceToken<string>('ind-a');
        const bToken = serviceToken<string>('ind-b');
        const container = new ServiceContainer(makeAppHandle());
        container.register(
            defineService(aToken, async () => {
                await tick(20);
                return 'a';
            }),
        );
        container.register(
            defineService(bToken, async () => {
                await tick(1);
                return 'b';
            }),
        );

        // b 先完成、a 后完成（乱序），都应正常交付。
        const [a, b] = await Promise.all([container.get(aToken), container.get(bToken)]);
        expect(a).toBe('a');
        expect(b).toBe('b');
    });

    it('重叠子图并发：共享依赖只创建一次', async () => {
        let baseCreated = 0;
        const baseToken = serviceToken<{ n: number }>('ovl-base');
        const xToken = serviceToken<{ base: unknown }>('ovl-x');
        const yToken = serviceToken<{ base: unknown }>('ovl-y');
        const container = new ServiceContainer(makeAppHandle());
        container.register(
            defineService(baseToken, async () => {
                baseCreated += 1;
                await tick(10);
                return { n: baseCreated };
            }),
        );
        container.register(
            defineService(xToken, async (ctx) => ({
                base: await ctx.services.get(baseToken),
            })),
        );
        container.register(
            defineService(yToken, async (ctx) => ({
                base: await ctx.services.get(baseToken),
            })),
        );

        const [x, y] = await Promise.all([container.get(xToken), container.get(yToken)]);
        expect(baseCreated).toBe(1);
        expect(x.base).toBe(y.base);
    });

    it('真实循环快速报错（不挂起等待自身 promise）', async () => {
        const aToken = serviceToken('cyc-a2');
        const bToken = serviceToken('cyc-b2');
        const cToken = serviceToken('cyc-c2');
        const container = new ServiceContainer(makeAppHandle());
        container.register(
            defineService(aToken, async (ctx) => ctx.services.get(bToken)),
        );
        container.register(
            defineService(bToken, async (ctx) => ctx.services.get(cToken)),
        );
        container.register(
            defineService(cToken, async (ctx) => ctx.services.get(aToken)),
        );

        // 深度环路也必须在有限时间内以 CyclicDependencyError 失败。
        await expect(
            Promise.race([
                container.get(aToken),
                tick(200).then(() => {
                    throw new Error('cyclic detection hung');
                }),
            ]),
        ).rejects.toBeInstanceOf(CyclicDependencyError);
    });

    it('循环检测不被并发解析破坏：并发解析后新环路仍被检测', async () => {
        const okToken = serviceToken<string>('mix-ok');
        const aToken = serviceToken('mix-cyc-a');
        const bToken = serviceToken('mix-cyc-b');
        const container = new ServiceContainer(makeAppHandle());
        container.register(
            defineService(okToken, async () => {
                await tick(10);
                return 'ok';
            }),
        );
        container.register(
            defineService(aToken, async (ctx) => ctx.services.get(bToken)),
        );
        container.register(
            defineService(bToken, async (ctx) => ctx.services.get(aToken)),
        );

        const [okResult, cycResult] = await Promise.allSettled([
            container.get(okToken),
            container.get(aToken),
        ]);
        expect(okResult.status).toBe('fulfilled');
        expect(cycResult.status).toBe('rejected');

        // 并发解析结束后，后续发起的同一环路仍要被检测（不能坏栈）。
        await expect(container.get(aToken)).rejects.toBeInstanceOf(CyclicDependencyError);
    });

    it('并发失败重试：一个消费者失败不影响其他消费者取得实例', async () => {
        let attempts = 0;
        const token = serviceToken<string>('conc-flaky');
        const container = new ServiceContainer(makeAppHandle());
        container.register(
            defineService(token, async () => {
                attempts += 1;
                await tick();
                if (attempts === 1) throw new Error('first fails');
                return 'second';
            }),
        );

        const [first, second] = await Promise.allSettled([
            container.get(token),
            container.get(token),
        ]);
        expect(first.status).toBe('rejected');
        expect(second.status).toBe('rejected'); // 共享同一次失败的创建
        await expect(container.get(token)).resolves.toBe('second');
    });
});

describe('ServiceContainer（dispose 与在途创建）', () => {
    /** 等待若干宏任务。 */
    const tick = (ms = 5): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));

    it('慢工厂与 dispose 竞态：晚完成的实例仍被清理，不逃逸', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let lateDisposed = false;
        const token = serviceToken<{ dispose(): void }>('late-factory');
        const container = new ServiceContainer(makeAppHandle());
        container.register(
            defineService(token, async () => {
                await gate;
                return {
                    dispose: () => {
                        lateDisposed = true;
                    },
                };
            }),
        );

        const creating = container.get(token); // 创建在途
        const disposing = container.dispose(); // dispose 开始（等在途创建落定）
        // dispose 开始后拒绝新的 get：对象图不再扩张。
        await expect(container.get(token)).rejects.toBeInstanceOf(ContainerDisposedError);

        release();
        await creating; // 晚完成（交付或清理由容器保证其一）
        await disposing;
        expect(lateDisposed).toBe(true);
    });

    it('多个在途创建：全部落定后按实例化逆序清理', async () => {
        const order: string[] = [];
        let releaseA!: () => void;
        let releaseB!: () => void;
        const gateA = new Promise<void>((r) => {
            releaseA = r;
        });
        const gateB = new Promise<void>((r) => {
            releaseB = r;
        });
        const aToken = serviceToken('pend-a');
        const bToken = serviceToken('pend-b');
        const container = new ServiceContainer(makeAppHandle());
        container.register(
            defineService(aToken, async () => {
                await gateA;
                return {
                    dispose: () => {
                        order.push('dispose-a');
                    },
                };
            }),
        );
        container.register(
            defineService(bToken, async () => {
                await gateB;
                return {
                    dispose: () => {
                        order.push('dispose-b');
                    },
                };
            }),
        );

        void container.get(aToken);
        void container.get(bToken);
        const disposing = container.dispose();

        releaseB(); // b 先完成
        await tick();
        releaseA(); // a 后完成（完成顺序与注册顺序相反）
        await disposing;
        expect(order).toEqual(['dispose-a', 'dispose-b']); // 实例化逆序
    });

    it('创建失败的服务不参与 dispose，其余照常清理', async () => {
        const disposed: string[] = [];
        const badToken = serviceToken('dispose-bad');
        const goodToken = serviceToken('dispose-good');
        const container = new ServiceContainer(makeAppHandle());
        container.register(
            defineService(badToken, () => {
                throw new Error('creation fails');
            }),
        );
        container.register(
            defineService(goodToken, () => ({
                dispose: () => {
                    disposed.push('good');
                },
            })),
        );

        await expect(container.get(badToken)).rejects.toThrow('creation fails');
        await container.get(goodToken);
        await container.dispose();
        expect(disposed).toEqual(['good']);
    });

    it('dispose 幂等：重复/并发调用共享同一次清理', async () => {
        let disposeRuns = 0;
        const token = serviceToken('idem');
        const container = new ServiceContainer(makeAppHandle());
        container.register(
            defineService(token, () => ({
                dispose: () => {
                    disposeRuns += 1;
                },
            })),
        );
        await container.get(token);

        const [p1, p2] = [container.dispose(), container.dispose()];
        await Promise.all([p1, p2]);
        await container.dispose();
        expect(disposeRuns).toBe(1);
    });

    it('dispose 开始后拒绝新的 register', () => {
        const token = serviceToken('reg-after-dispose');
        const container = new ServiceContainer(makeAppHandle());
        void container.dispose();
        expect(() => container.register(defineService(token, () => ({})))).toThrow(
            ContainerDisposedError,
        );
    });

    it('dispose 期间工厂内再解析依赖会被拒绝', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const aToken = serviceToken('dep-a');
        const bToken = serviceToken('dep-b');
        const container = new ServiceContainer(makeAppHandle());
        container.register(defineService(bToken, () => ({})));
        container.register(
            defineService(aToken, async (ctx) => {
                await gate;
                // dispose 已开始：依赖解析被拒绝，a 的创建随之失败。
                return { b: await ctx.services.get(bToken) };
            }),
        );

        const creating = container.get(aToken);
        void container.dispose();
        release();
        await expect(creating).rejects.toBeInstanceOf(ContainerDisposedError);
        await container.dispose();
    });
});
