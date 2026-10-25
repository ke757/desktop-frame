import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SearchResponseSchema } from '@desktop-frame/contracts';
import { DeploymentManagerImpl } from '../src/main/core/deployment/manager';
import { createExternalServiceClient } from '../src/main/core/deployment/client';
import { MemoryLogger } from '../src/main/core/logging';
import { createNodeProcessHost } from '../src/main/electron/process-host';
import { freePort, makeEnv, waitUntil } from './fakes';

/**
 * 端到端：用真实的 node:child_process 托管拉起 fixture 外部服务
 * （test/fixtures/echo-service.mjs），跑通「拉起 -> 健康就绪 -> HTTP/WS
 * 数据面 -> 优雅终止 -> 端口释放」的完整控制面/数据面回路。
 */

/** fixture 可执行脚本路径。 */
const fixturePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'echo-service.mjs',
);

/** 等待 WS 的下一条消息并归一化为文本（Node 原生 WS 文本帧会给 Blob）。 */
async function nextMessage(ws: WebSocket): Promise<string> {
    const data = await new Promise<unknown>((resolve) => {
        ws.onmessage = (event) => resolve(event.data);
    });
    if (typeof data === 'string') return data;
    if (data instanceof Blob) return data.text();
    return String(data);
}

describe('DeploymentManager e2e（真实进程）', () => {
    it('托管拉起外部服务：就绪、HTTP/WS 数据面、stdout 接入日志、优雅终止', async () => {
        const port = await freePort();
        const logger = new MemoryLogger();
        const manager = new DeploymentManagerImpl({
            processHost: createNodeProcessHost(),
            env: makeEnv(false),
            logger,
        });
        manager.register({
            id: 'search',
            command: process.execPath,
            args: [fixturePath, '--port', String(port)],
            baseUrl: `http://127.0.0.1:${port}`,
            health: { path: '/health', intervalMs: 100 },
            readyTimeoutMs: 10_000,
            stopTimeoutMs: 5_000,
        });

        await manager.startAll();
        expect(manager.getStatus('search')).toMatchObject({
            state: 'running',
            mode: 'managed',
        });
        expect(manager.getStatus('search')?.pid).toBeGreaterThan(0);

        // 外部服务的 stdout 已按行接入应用日志（行文本在 meta.line 里）。
        await waitUntil(() =>
            logger.entries.some(
                (entry) =>
                    entry.message.includes('external service output') &&
                    JSON.stringify(entry.meta ?? {}).includes('echo-service listening'),
            ),
        );

        const client = createExternalServiceClient({
            deployment: 'search',
            manager,
            logger: logger.child('client'),
        });

        // HTTP 数据面：搜索端点返回契约可解析的负载。
        const response = await client.request('/api/search?q=hello world');
        expect(response.ok).toBe(true);
        const payload = SearchResponseSchema.parse(await response.json());
        expect(payload.hits.map((hit) => hit.id)).toEqual(['hello-0', 'world-1']);

        // WS 数据面：连接即收到 index-updated 推送；消息被回显。
        const ws = await client.socket('/ws');
        expect(JSON.parse(await nextMessage(ws))).toMatchObject({
            type: 'index-updated',
        });
        ws.send('ping');
        expect(JSON.parse(await nextMessage(ws))).toMatchObject({
            type: 'echo',
            received: 'ping',
        });
        ws.close();

        // 重启：停止旧进程后重新拉起并再次就绪。
        await manager.restart('search');
        expect(manager.getStatus('search')?.state).toBe('running');

        // 优雅终止：SIGTERM 后进程退出、端口释放。
        await manager.stopAll();
        expect(manager.getStatus('search')?.state).toBe('stopped');
        await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    }, 30_000);
});
