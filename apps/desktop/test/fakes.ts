import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { AppEnv } from '../src/main/core/ports/env';
import type {
    HostedProcess,
    ProcessExit,
    ProcessHost,
    SpawnOptions,
} from '../src/main/core';

/**
 * 部署相关测试的共享替身：假进程宿主（记录 kill/spawn）、最小 AppEnv、
 * 真实回环 HTTP 健康服务与轮询等待工具。被 deployment-manager /
 * external-client / deployment.e2e / desktop-app.integration 四组测试复用。
 */

let nextFakePid = 4200;

/** 假子进程：kill 默认即退出；ignoreKill 模拟无视 SIGTERM 的进程。 */
export class FakeHostedProcess implements HostedProcess {
    readonly pid: number | undefined = nextFakePid++;
    /** 收到的终止信号序列。 */
    readonly killSignals: string[] = [];
    /** 为 true 时忽略 SIGTERM（只响应 SIGKILL），用于验证升级逻辑。 */
    ignoreKill = false;
    readonly exited: Promise<ProcessExit>;
    private settle!: (exit: ProcessExit) => void;

    /** @param spawnError 模拟启动失败（如 ENOENT）。 */
    constructor(spawnError?: string) {
        this.exited = new Promise((resolve) => {
            this.settle = resolve;
        });
        if (spawnError !== undefined) {
            queueMicrotask(() =>
                this.settle({ code: null, signal: null, error: spawnError }),
            );
        }
    }

    kill(signal = 'SIGTERM'): void {
        this.killSignals.push(signal);
        if (this.ignoreKill && signal !== 'SIGKILL') return;
        queueMicrotask(() => this.settle({ code: null, signal }));
    }

    /** 测试辅助：主动宣告进程以给定结果退出。 */
    async emitExit(exit: ProcessExit): Promise<void> {
        this.settle(exit);
        await this.exited;
    }

    onOutput(): () => void {
        return () => {};
    }
}

/** 假进程宿主：记录 spawn 请求并产出可控的假进程。 */
export class FakeProcessHost implements ProcessHost {
    /** 全部 spawn 请求（按顺序）。 */
    readonly spawns: SpawnOptions[] = [];
    /** 全部产出的假进程（按顺序）。 */
    readonly processes: FakeHostedProcess[] = [];
    /** 下一次 spawn 的启动失败信息（一次性）。 */
    nextSpawnError: string | undefined;

    spawn(options: SpawnOptions): HostedProcess {
        this.spawns.push(options);
        const proc = new FakeHostedProcess(this.nextSpawnError);
        this.nextSpawnError = undefined;
        this.processes.push(proc);
        return proc;
    }
}

/** 构造最小可用的 AppEnv（测试默认非 dev、file 入口）。 */
export function makeEnv(isDev: boolean): AppEnv {
    return {
        isDev,
        devServerUrl: isDev ? 'http://localhost:5173' : undefined,
        appName: 'test-app',
        appVersion: '0.0.0-test',
        userDataPath: '/tmp/df-test-user-data',
        mainDir: '/tmp/df-test-main',
        preloadPath: '/tmp/df-test-main/preload.cjs',
        rendererEntry: { kind: 'file', path: '/tmp/df-test-main/index.html' },
        allowedFrameOrigins: ['file://'],
    };
}

/** 起一个回环 HTTP 服务：/health 返回 200，其余 404。 */
export async function startHealthServer(
    port = 0,
): Promise<{ port: number; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
        if (req.url?.split('?')[0] === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } else {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'not found' }));
        }
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const bound = (server.address() as AddressInfo).port;
    return {
        port: bound,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections?.();
            }),
    };
}

/** 取一个当前空闲的 TCP 端口（用于「服务不在场」的场景）。 */
export async function freePort(): Promise<number> {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
}

/** 轮询等待谓词为真（默认 3s 超时）。 */
export async function waitUntil(
    predicate: () => boolean,
    timeoutMs = 3_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('waitUntil timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
