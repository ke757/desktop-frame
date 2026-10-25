import { describe, expect, it } from 'vitest';
import { DeploymentStatusSchema } from '@desktop-frame/contracts';
import { DeploymentManagerImpl } from '../src/main/core/deployment/manager';
import { MemoryLogger } from '../src/main/core/logging';
import type { DeploymentChange, DeploymentProfile } from '../src/main/core';
import {
    DeploymentManagerClosedError,
    DeploymentNotReadyError,
    InvalidDeploymentError,
    UnknownDeploymentError,
} from '../src/main/core';
import { FakeProcessHost, freePort, makeEnv, startHealthServer } from './fakes';

/** 构造待测 manager（独立容器，互不影响）。 */
function makeManager(options: { isDev?: boolean; profile?: DeploymentProfile }) {
    const processHost = new FakeProcessHost();
    const logger = new MemoryLogger();
    const manager = new DeploymentManagerImpl({
        processHost,
        env: makeEnv(options.isDev ?? false),
        logger,
        profile: options.profile,
    });
    return { manager, processHost, logger };
}

describe('DeploymentManager (managed 模式)', () => {
    it('startAll 拉起进程并等待健康转 running；stopAll 优雅终止', async () => {
        const { manager, processHost } = makeManager({});
        const health = await startHealthServer();
        manager.register({
            id: 'demo',
            command: 'demo-server',
            baseUrl: `http://127.0.0.1:${health.port}`,
        });

        await manager.startAll();
        expect(manager.getStatus('demo')).toMatchObject({
            state: 'running',
            mode: 'managed',
            pid: expect.any(Number),
        });

        const proc = processHost.processes[0]!;
        await manager.stopAll();
        expect(proc.killSignals).toEqual(['SIGTERM']);
        expect(manager.getStatus('demo')?.state).toBe('stopped');
        await health.close();
    });

    it('健康探测超时置 failed 并终止残留进程', async () => {
        const { manager, processHost } = makeManager({});
        const port = await freePort();
        manager.register({
            id: 'demo',
            command: 'demo-server',
            baseUrl: `http://127.0.0.1:${port}`,
            readyTimeoutMs: 250,
            health: { intervalMs: 40, timeoutMs: 150 },
        });

        await manager.startAll();
        const status = manager.getStatus('demo');
        expect(status?.state).toBe('failed');
        expect(status?.detail).toContain('health check not passing');
        expect(processHost.processes[0]!.killSignals.length).toBeGreaterThan(0);
    });

    it('spawn 失败置 failed（保留启动错误详情）', async () => {
        const { manager, processHost } = makeManager({});
        processHost.nextSpawnError = 'spawn demo-server ENOENT';
        manager.register({
            id: 'demo',
            command: 'missing-binary',
            baseUrl: 'http://127.0.0.1:1',
            readyTimeoutMs: 5_000,
            health: { intervalMs: 20 },
        });

        await manager.startAll();
        const status = manager.getStatus('demo');
        expect(status?.state).toBe('failed');
        expect(status?.detail).toContain('ENOENT');
    });

    it('运行中意外退出置 crashed 并广播状态迁移', async () => {
        const { manager, processHost } = makeManager({});
        const health = await startHealthServer();
        manager.register({
            id: 'demo',
            command: 'demo-server',
            baseUrl: `http://127.0.0.1:${health.port}`,
        });
        const changes: DeploymentChange[] = [];
        manager.onChange((change) => changes.push(change));

        await manager.startAll();
        await processHost.processes[0]!.emitExit({ code: 1, signal: null });

        expect(manager.getStatus('demo')?.state).toBe('crashed');
        expect(manager.getStatus('demo')?.detail).toContain('code=1');
        expect(changes.map((change) => change.to)).toContain('crashed');
        await health.close();
    });

    it('无视 SIGTERM 的进程在宽限期后升级 SIGKILL', async () => {
        const { manager, processHost } = makeManager({});
        manager.register({
            id: 'demo',
            command: 'demo-server',
            baseUrl: 'http://127.0.0.1:1',
            health: false,
            stopTimeoutMs: 80,
        });
        await manager.startAll();
        const proc = processHost.processes[0]!;
        proc.ignoreKill = true;

        const stopping = manager.stop('demo');
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise<void>((resolve) => {
            const poll = setInterval(() => {
                if (proc.killSignals.includes('SIGKILL')) {
                    clearInterval(poll);
                    resolve();
                }
            }, 5);
        });
        await proc.emitExit({ code: null, signal: 'SIGKILL' });
        await stopping;

        expect(proc.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
        expect(manager.getStatus('demo')?.state).toBe('stopped');
    });

    it('restart 停止后重新拉起（新进程实例）', async () => {
        const { manager, processHost } = makeManager({});
        manager.register({
            id: 'demo',
            command: 'demo-server',
            baseUrl: 'http://127.0.0.1:1',
            health: false,
        });
        await manager.startAll();
        expect(manager.getStatus('demo')?.state).toBe('running');

        await manager.restart('demo');
        expect(manager.getStatus('demo')?.state).toBe('running');
        expect(processHost.processes).toHaveLength(2);
        await manager.stopAll();
    });

    it('状态快照与 contracts 的 DeploymentStatusSchema 结构一致', async () => {
        const { manager } = makeManager({});
        manager.register({
            id: 'demo',
            command: 'demo-server',
            baseUrl: 'http://127.0.0.1:1',
            health: false,
        });
        await manager.startAll();
        const parsed = DeploymentStatusSchema.safeParse(manager.list()[0]);
        expect(parsed.success).toBe(true);
        await manager.stopAll();
    });
});

describe('DeploymentManager (external 模式)', () => {
    it('startAll 立即返回 waiting；服务上线后自动转 running；stop 撤销探测', async () => {
        const { manager } = makeManager({});
        const port = await freePort();
        manager.register({
            id: 'svc',
            mode: 'external',
            baseUrl: `http://127.0.0.1:${port}`,
            health: { intervalMs: 30 },
        });

        await manager.startAll();
        expect(manager.getStatus('svc')).toMatchObject({
            state: 'waiting',
            mode: 'external',
            pid: null,
        });

        // 开发者「手动启动」外部服务后，探测循环发现其就绪。
        const health = await startHealthServer(port);
        await manager.whenReady('svc', 3_000);
        expect(manager.getStatus('svc')?.state).toBe('running');

        await manager.stopAll();
        expect(manager.getStatus('svc')?.state).toBe('stopped');
        await health.close();
    });
});

describe('DeploymentManager (profile 与校验)', () => {
    it('profile 覆盖仅在 dev 模式生效', () => {
        const profile: DeploymentProfile = {
            demo: { mode: 'external', baseUrl: 'http://127.0.0.1:9999' },
        };
        const dev = makeManager({ isDev: true, profile });
        dev.manager.register({
            id: 'demo',
            command: 'demo-server',
            baseUrl: 'http://127.0.0.1:1',
        });
        expect(dev.manager.getStatus('demo')).toMatchObject({
            mode: 'external',
            baseUrl: 'http://127.0.0.1:9999',
        });

        const prod = makeManager({ isDev: false, profile });
        prod.manager.register({
            id: 'demo',
            command: 'demo-server',
            baseUrl: 'http://127.0.0.1:1',
        });
        expect(prod.manager.getStatus('demo')).toMatchObject({
            mode: 'managed',
            baseUrl: 'http://127.0.0.1:1',
        });
    });

    it('whenReady：running 立即 resolve；等待超时 reject；未知 id 抛错', async () => {
        const running = makeManager({});
        running.manager.register({
            id: 'demo',
            command: 'demo-server',
            baseUrl: 'http://127.0.0.1:1',
            health: false,
        });
        await running.manager.startAll();
        await expect(running.manager.whenReady('demo', 50)).resolves.toBeUndefined();
        await running.manager.stopAll();

        const waiting = makeManager({});
        const port = await freePort();
        waiting.manager.register({
            id: 'svc',
            mode: 'external',
            baseUrl: `http://127.0.0.1:${port}`,
            health: { intervalMs: 200 },
        });
        await waiting.manager.startAll();
        await expect(waiting.manager.whenReady('svc', 120)).rejects.toBeInstanceOf(
            DeploymentNotReadyError,
        );
        await waiting.manager.stopAll();

        expect(() => waiting.manager.whenReady('nope')).toThrow(UnknownDeploymentError);
    });

    it('声明校验：重复 id / managed 缺 command / 非法 baseUrl', () => {
        const { manager } = makeManager({});
        manager.register({
            id: 'demo',
            command: 'demo-server',
            baseUrl: 'http://127.0.0.1:1',
        });
        expect(() =>
            manager.register({
                id: 'demo',
                command: 'demo-server',
                baseUrl: 'http://127.0.0.1:1',
            }),
        ).toThrow(InvalidDeploymentError);
        expect(() =>
            manager.register({ id: 'no-command', baseUrl: 'http://127.0.0.1:1' }),
        ).toThrow(InvalidDeploymentError);
        expect(() =>
            manager.register({ id: 'bad-url', command: 'x', baseUrl: 'not-a-url' }),
        ).toThrow(InvalidDeploymentError);
        expect(() =>
            manager.register({
                id: 'url-with-path',
                command: 'x',
                baseUrl: 'http://127.0.0.1:1/prefix',
            }),
        ).toThrow(InvalidDeploymentError);
    });

    it('stopAll 关闭控制面：后续 start 拒绝', async () => {
        const { manager } = makeManager({});
        manager.register({
            id: 'demo',
            command: 'demo-server',
            baseUrl: 'http://127.0.0.1:1',
            health: false,
        });
        await manager.startAll();
        await manager.stopAll();
        await expect(manager.start('demo')).rejects.toBeInstanceOf(
            DeploymentManagerClosedError,
        );
    });
});
