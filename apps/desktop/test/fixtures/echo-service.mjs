#!/usr/bin/env node
/**
 * 演示用外部领域服务可执行程序（fixture）：HTTP JSON API + WebSocket 推送。
 * 双重身份：
 * - dev 手动启动的目标（external profile 指向它）：
 *     node apps/desktop/test/fixtures/echo-service.mjs [--port 7801]
 * - e2e 测试里被 DeploymentManager 托管拉起（managed 模式）。
 *
 * 契约与 modules/search 的适配层对应：
 * - GET  /health            -> { ok, uptimeMs }
 * - GET  /api/search?q=xxx  -> { hits: [{ id, title, score }] }
 * - WS   /ws                -> 周期推送 { type: 'index-updated', at }；回显消息
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';

const argIndex = process.argv.indexOf('--port');
const port = argIndex >= 0 ? Number(process.argv[argIndex + 1]) : 7801;

let servedRequests = 0;

/** 以 JSON 应答。 */
function reply(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/health') {
        reply(res, 200, { ok: true, uptimeMs: Math.round(process.uptime() * 1000) });
        return;
    }
    if (url.pathname === '/api/search') {
        servedRequests += 1;
        const query = url.searchParams.get('q') ?? '';
        const hits = query
            .split(/\s+/)
            .filter(Boolean)
            .map((token, index) => ({
                id: `${token}-${index}`,
                title: `${token} result #${index + 1} (served ${servedRequests})`,
                score: 1 / (index + 1),
            }));
        reply(res, 200, { hits });
        return;
    }
    reply(res, 404, { error: `no route: ${url.pathname}` });
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'index-updated', at: Date.now() }));
    const push = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'index-updated', at: Date.now() }));
        }
    }, 3000);
    push.unref();
    ws.on('message', (data) => {
        ws.send(JSON.stringify({ type: 'echo', received: data.toString() }));
    });
    ws.on('close', () => clearInterval(push));
});

// 优雅停止：SIGTERM 后关闭连接与服务器再退出（配合控制面的优雅终止演示）。
process.on('SIGTERM', () => {
    console.log('echo-service: SIGTERM received, shutting down');
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
});

server.listen(port, '127.0.0.1', () => {
    console.log(`echo-service listening on http://127.0.0.1:${port}`);
});
