import {
    RpcError,
    SearchResponseSchema,
    appEvents,
    type SearchResponse,
} from '@desktop-frame/contracts';
import type { EventPublisher, Logger } from '../../core';
import { defineService } from '../../core';
import {
    ExternalServiceError,
    createExternalServiceClient,
    type DisposableService,
    type ExternalServiceClient,
} from '../../core';
import { searchToken, type SearchService } from './api';
import { SEARCH_DEPLOYMENT_ID } from './search.deployment';

/** WS 重连的基础退避（ms，按尝试次数指数增长）。 */
const RECONNECT_BASE_DELAY_MS = 500;
/** WS 重连的退避上限（ms）。 */
const MAX_RECONNECT_DELAY_MS = 10_000;

/**
 * 搜索服务实现：外部领域服务的适配层（anti-corruption 层）——
 * 经 ExternalServiceClient 与外部服务通信，把 HTTP 失败翻译为 RpcError、
 * 把 WS 推送桥接为内部事件（appEvents.searchIndexChanged）。连接断开时
 * 指数退避重连，dispose 时统一收口。公开接口与 token 在 ./api.ts。
 */
export class SearchServiceImpl implements SearchService, DisposableService {
    private socket: WebSocket | undefined;
    private reconnectTimer: NodeJS.Timeout | undefined;
    private stopped = false;

    constructor(
        private readonly client: ExternalServiceClient,
        private readonly logger: Logger,
        private readonly events: EventPublisher,
    ) {}

    /** 调用外部搜索服务的 HTTP 端点。 */
    async search(query: string): Promise<SearchResponse> {
        let response: Response;
        try {
            response = await this.client.request(
                `/api/search?q=${encodeURIComponent(query)}`,
            );
        } catch (cause) {
            throw toRpcError(cause);
        }
        if (!response.ok) {
            throw new RpcError(
                'SEARCH_UPSTREAM',
                `search service responded with ${response.status}`,
            );
        }
        const payload = await response.json().catch(() => null);
        const parsed = SearchResponseSchema.safeParse(payload);
        if (!parsed.success) {
            throw new RpcError(
                'SEARCH_UPSTREAM',
                'search service returned a malformed payload',
            );
        }
        return parsed.data;
    }

    /** 订阅外部索引更新（非阻塞：就绪后建 WS 连接，推送转发为内部事件）。 */
    startListening(): void {
        void this.connect(0);
    }

    /** 框架钩子（DisposableService）：停止重连并关闭事件连接。 */
    dispose(): void {
        this.stopped = true;
        if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.socket?.close();
        this.socket = undefined;
    }

    /** 尝试建立 WS 连接；失败或断开后指数退避重连。 */
    private async connect(attempt: number): Promise<void> {
        if (this.stopped) return;
        let socket: WebSocket;
        try {
            socket = await this.client.socket('/ws');
        } catch (cause) {
            this.logger.debug('search event socket unavailable; will retry', {
                attempt,
                error: cause instanceof Error ? cause.message : String(cause),
            });
            return this.scheduleReconnect(attempt);
        }
        if (this.stopped) {
            socket.close();
            return;
        }
        this.logger.info('search event socket connected');
        this.socket = socket;
        socket.onmessage = (event) => {
            void this.forwardIndexUpdate(event.data);
        };
        socket.onclose = () => {
            this.socket = undefined;
            if (!this.stopped) {
                this.logger.warn('search event socket closed; reconnecting');
                void this.connect(0);
            }
        };
    }

    /**
     * 解析外部推送并转发为内部事件（非法负载记日志丢弃）。Node 的原生
     * WebSocket 对文本帧可能给 Blob 而非 string，这里统一归一化。
     */
    private async forwardIndexUpdate(data: unknown): Promise<void> {
        let text: string;
        if (typeof data === 'string') {
            text = data;
        } else if (data instanceof Blob) {
            text = await data.text();
        } else {
            return;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(text) as unknown;
        } catch {
            this.logger.warn('search event payload is not JSON; dropping');
            return;
        }
        const message = parsed as { type?: unknown; at?: unknown };
        if (message.type !== 'index-updated' || typeof message.at !== 'number') return;
        this.events.publish(appEvents.searchIndexChanged, { at: message.at });
    }

    /** 安排一次退避重连。 */
    private scheduleReconnect(attempt: number): void {
        if (this.stopped) return;
        const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * 2 ** attempt,
            MAX_RECONNECT_DELAY_MS,
        );
        this.reconnectTimer = setTimeout(() => void this.connect(attempt + 1), delay);
        this.reconnectTimer.unref();
    }
}

/** 把数据面错误统一翻译为类型化 RpcError（handler 内可安全抛出）。 */
function toRpcError(cause: unknown): RpcError {
    if (cause instanceof ExternalServiceError) {
        return new RpcError('SEARCH_UNAVAILABLE', cause.message, {
            code: cause.code,
            deployment: cause.deployment,
        });
    }
    return new RpcError(
        'SEARCH_UPSTREAM',
        cause instanceof Error ? cause.message : String(cause),
    );
}

/** 搜索服务的注册定义：组装控制面依赖并构造代理客户端。 */
export const searchService = defineService(searchToken, (ctx) => {
    // 客户端只需要就绪查询受众（ctx.app.deployments 是 DeploymentReadiness，
    // 不取得部署管理权限）；内核能力经 ctx.app 获取，不经容器解析。
    const client = createExternalServiceClient({
        deployment: SEARCH_DEPLOYMENT_ID,
        manager: ctx.app.deployments,
        logger: ctx.app.logger.child('search:client'),
    });
    return new SearchServiceImpl(client, ctx.app.logger.child('search'), ctx.app.events);
});
