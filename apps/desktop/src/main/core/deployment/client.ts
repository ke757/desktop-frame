import type { DeploymentManager } from '../ports/deployment';
import type { Logger } from '../ports/logger';

/** 外部服务访问错误码。 */
export type ExternalErrorCode =
    | 'NOT_READY'
    | 'REQUEST_TIMEOUT'
    | 'REQUEST_FAILED'
    | 'SOCKET_ERROR';

/**
 * 外部服务访问错误：适配层把 RpcError 之外的失败统一到该类型，由调用方
 * （handler/服务）决定如何翻译为业务错误。
 */
export class ExternalServiceError extends Error {
    /** 机器可读错误码。 */
    readonly code: ExternalErrorCode;
    /** 目标部署 id。 */
    readonly deployment: string;

    constructor(deployment: string, code: ExternalErrorCode, message: string) {
        super(message);
        this.name = 'ExternalServiceError';
        this.code = code;
        this.deployment = deployment;
    }
}

/** 代理外部领域服务的通用客户端（HTTP + WebSocket）。 */
export interface ExternalServiceClient {
    /** 目标部署 id。 */
    readonly deployment: string;
    /** 服务根地址（生效 spec 的 baseUrl，仅 origin）。 */
    readonly baseUrl: string;
    /** 等待部署就绪（转发到 DeploymentManager.whenReady）。 */
    whenReady(timeoutMs?: number): Promise<void>;
    /**
     * 发起 HTTP 请求：等待部署就绪后 fetch 指定路径；未就绪/超时/网络
     * 失败抛 ExternalServiceError。返回原始 Response，状态码处理由调用方决定。
     */
    request(path: string, init?: RequestInit): Promise<Response>;
    /** 建立 WebSocket 连接（等待就绪后握手；超时抛 ExternalServiceError）。 */
    socket(path: string, timeoutMs?: number): Promise<WebSocket>;
}

/** 客户端构造选项。 */
export interface ExternalClientOptions {
    /** 目标部署 id（须已注册给 DeploymentManager）。 */
    readonly deployment: string;
    /** 部署控制面（就绪等待与 baseUrl 解析）。 */
    readonly manager: DeploymentManager;
    /** 可选 logger（连接失败诊断用）。 */
    readonly logger?: Logger;
    /** 就绪等待上限（ms；缺省用部署 spec 的 readyTimeoutMs）。 */
    readonly readyTimeoutMs?: number;
    /** 单次 HTTP 请求超时（ms，缺省 10000）。 */
    readonly fetchTimeoutMs?: number;
    /** WS 握手超时（ms，缺省 10000）。 */
    readonly socketTimeoutMs?: number;
}

/** 缺省单次 HTTP 请求超时（ms）。 */
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
/** 缺省 WS 握手超时（ms）。 */
const DEFAULT_SOCKET_TIMEOUT_MS = 10_000;

/** 把 http(s) URL 转为对应的 ws(s) URL。 */
function toWebSocketUrl(baseUrl: string, path: string): string {
    const url = new URL(path, baseUrl);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    else if (url.protocol === 'http:') url.protocol = 'ws:';
    return url.toString();
}

/**
 * 创建外部领域服务的代理客户端。适配层服务（如 modules/search）在工厂内
 * 构造它并持有，业务方法经 `request`/`socket` 与外部服务通信——控制面
 * （DeploymentManager）负责拉起与就绪，数据面（本客户端）只做转发。
 */
export function createExternalServiceClient(
    options: ExternalClientOptions,
): ExternalServiceClient {
    const { deployment, manager } = options;
    const fetchTimeout = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const socketTimeout = options.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS;
    const status = manager.getStatus(deployment);
    if (!status) {
        throw new Error(
            `external client targets unknown deployment: ${deployment}` +
                ' (register the DeploymentSpec before creating adapters)',
        );
    }
    const baseUrl = status.baseUrl;

    const whenReady = (timeoutMs?: number): Promise<void> =>
        manager.whenReady(deployment, timeoutMs ?? options.readyTimeoutMs);

    return {
        deployment,
        baseUrl,
        whenReady,

        async request(path: string, init?: RequestInit): Promise<Response> {
            try {
                await whenReady();
            } catch (cause) {
                throw new ExternalServiceError(
                    deployment,
                    'NOT_READY',
                    cause instanceof Error ? cause.message : String(cause),
                );
            }
            const signal = init?.signal ?? AbortSignal.timeout(fetchTimeout);
            try {
                return await fetch(new URL(path, baseUrl).toString(), {
                    ...init,
                    signal,
                });
            } catch (cause) {
                if (cause instanceof Error && /timeout|abort/i.test(cause.name)) {
                    throw new ExternalServiceError(
                        deployment,
                        'REQUEST_TIMEOUT',
                        `request to ${path} timed out after ${fetchTimeout}ms`,
                    );
                }
                throw new ExternalServiceError(
                    deployment,
                    'REQUEST_FAILED',
                    `request to ${path} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                );
            }
        },

        async socket(path: string, timeoutMs?: number): Promise<WebSocket> {
            try {
                await whenReady();
            } catch (cause) {
                throw new ExternalServiceError(
                    deployment,
                    'NOT_READY',
                    cause instanceof Error ? cause.message : String(cause),
                );
            }
            const url = toWebSocketUrl(baseUrl, path);
            const limit = timeoutMs ?? socketTimeout;
            return new Promise<WebSocket>((resolve, reject) => {
                const ws = new WebSocket(url);
                const finish = (settle: () => void): void => {
                    clearTimeout(timer);
                    settle();
                };
                const timer = setTimeout(() => {
                    finish(() => {
                        ws.close();
                        reject(
                            new ExternalServiceError(
                                deployment,
                                'SOCKET_ERROR',
                                `websocket handshake to ${url} timed out after ${limit}ms`,
                            ),
                        );
                    });
                }, limit);
                ws.onopen = () => {
                    finish(() => resolve(ws));
                };
                ws.onerror = () => {
                    finish(() => {
                        reject(
                            new ExternalServiceError(
                                deployment,
                                'SOCKET_ERROR',
                                `websocket connection to ${url} failed`,
                            ),
                        );
                    });
                };
            });
        },
    };
}
