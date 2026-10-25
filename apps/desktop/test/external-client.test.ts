import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { DeploymentManagerImpl } from '../src/main/core/deployment/manager';
import { MemoryLogger } from '../src/main/core/logging';
import {
    ExternalServiceError,
    createExternalServiceClient,
    type ExternalServiceClient,
} from '../src/main/core';
import { FakeProcessHost, freePort, makeEnv } from './fakes';

/**
 * 数据面测试：ExternalServiceClient 走真实回环 HTTP/WS（node:http + ws），
 * 控制面用真实 DeploymentManagerImpl（external 模式，不涉及进程）。
 */

/** 起一个演示外部服务：/health、POST /api/echo、GET /api/slow、WS /ws 回显。 */
async function startDemoService(): Promise<{
    port: number;
    close: () => Promise<void>;
}> {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/health') {
            res.writeHead(200).end('{"ok":true}');
            return;
        }
        if (url.pathname === '/api/echo' && req.method === 'POST') {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                const received = JSON.parse(
                    Buffer.concat(chunks).toString('utf8'),
                ) as unknown;
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ received }));
            });
            return;
        }
        if (url.pathname === '/api/slow') {
            setTimeout(() => res.writeHead(200).end('{"ok":true}'), 500);
            return;
        }
        res.writeHead(404).end();
    });
    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (ws) => {
        ws.on('message', (data) => ws.send(data));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return {
        port,
        close: () =>
            new Promise<void>((resolve) => {
                // 先终止残余客户端：wss.close 的回调要等客户端全部断开才触发。
                for (const client of wss.clients) client.terminate();
                wss.close(() => {
                    server.close(() => resolve());
                    server.closeAllConnections?.();
                });
            }),
    };
}

/** 构造 external 模式的 manager + client（服务需已在线才 ready）。 */
async function makeClient(options?: {
    readyTimeoutMs?: number;
    fetchTimeoutMs?: number;
}): Promise<{
    client: ExternalServiceClient;
    manager: DeploymentManagerImpl;
    service: { port: number; close: () => Promise<void> };
}> {
    const service = await startDemoService();
    const manager = new DeploymentManagerImpl({
        processHost: new FakeProcessHost(),
        env: makeEnv(false),
        logger: new MemoryLogger(),
    });
    manager.register({
        id: 'demo',
        mode: 'external',
        baseUrl: `http://127.0.0.1:${service.port}`,
        health: { intervalMs: 20 },
    });
    await manager.startAll();
    const client = createExternalServiceClient({
        deployment: 'demo',
        manager,
        readyTimeoutMs: options?.readyTimeoutMs,
        fetchTimeoutMs: options?.fetchTimeoutMs,
    });
    return { client, manager, service };
}

let cleanup: Array<() => Promise<void>> = [];

/** 有限等待的清理护栏（单个清理卡住不拖垮整个套件）。 */
function withDeadline(promise: Promise<unknown>, ms = 2_000): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref();
        void promise.finally(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}

afterEach(async () => {
    const pending = cleanup;
    cleanup = [];
    await Promise.all(pending.map((close) => withDeadline(close())));
});

/** 把 WS 消息归一化为文本（Node 原生 WebSocket 的文本帧会给 Blob）。 */
async function messageText(data: unknown): Promise<string> {
    if (typeof data === 'string') return data;
    if (data instanceof Blob) return data.text();
    return String(data);
}

describe('ExternalServiceClient', () => {
    it('request：等就绪后完成 HTTP 往返（json echo）', async () => {
        const { client, manager, service } = await makeClient();
        cleanup.push(() => manager.stopAll(), service.close);

        const response = await client.request('/api/echo', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hello: 'world' }),
        });
        expect(response.ok).toBe(true);
        await expect(response.json()).resolves.toEqual({ received: { hello: 'world' } });
    });

    it('socket：建立 WS 连接并完成回显往返', async () => {
        const { client, manager, service } = await makeClient();
        cleanup.push(() => manager.stopAll(), service.close);

        const ws = await client.socket('/ws');
        try {
            const message = await new Promise<unknown>((resolve) => {
                ws.onmessage = (event) => resolve(event.data);
                ws.send('ping');
            });
            expect(await messageText(message)).toBe('ping');
        } finally {
            ws.close();
        }
    });

    it('未就绪：请求在就绪上限后以 NOT_READY 失败', async () => {
        const port = await freePort();
        const manager = new DeploymentManagerImpl({
            processHost: new FakeProcessHost(),
            env: makeEnv(false),
            logger: new MemoryLogger(),
        });
        manager.register({
            id: 'absent',
            mode: 'external',
            baseUrl: `http://127.0.0.1:${port}`,
            health: { intervalMs: 50 },
        });
        const client = createExternalServiceClient({
            deployment: 'absent',
            manager,
            readyTimeoutMs: 120,
        });
        cleanup.push(() => manager.stopAll());

        await expect(client.request('/api/echo')).rejects.toMatchObject({
            name: 'ExternalServiceError',
            code: 'NOT_READY',
            deployment: 'absent',
        });
        await expect(client.socket('/ws')).rejects.toBeInstanceOf(ExternalServiceError);
    });

    it('请求超时：慢端点触发 REQUEST_TIMEOUT', async () => {
        const { client, manager, service } = await makeClient({ fetchTimeoutMs: 80 });
        cleanup.push(() => manager.stopAll(), service.close);

        await expect(client.request('/api/slow')).rejects.toMatchObject({
            name: 'ExternalServiceError',
            code: 'REQUEST_TIMEOUT',
        });
    });

    it('目标部署未注册时构造即失败（防字符串漂移）', () => {
        const manager = new DeploymentManagerImpl({
            processHost: new FakeProcessHost(),
            env: makeEnv(false),
            logger: new MemoryLogger(),
        });
        expect(() =>
            createExternalServiceClient({ deployment: 'ghost', manager }),
        ).toThrow(/unknown deployment/);
    });
});
