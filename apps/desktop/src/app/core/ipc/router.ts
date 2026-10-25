import type {
    Procedure,
    ProcedureInput,
    ProcedureOutput,
    RpcResult,
} from '@desktop-frame/contracts';
import { RpcError, err, ok } from '@desktop-frame/contracts';
import type { z } from 'zod';
import type { AppEnv } from '../env';
import type { ServiceAccessor } from '../container';
import type { LifecycleState, Lifecycle } from '../lifecycle';
import type { Logger } from '../logging';
import type { EventPublisher } from './events';

/** 一次调用中关于调用方 renderer 的信息。 */
export interface IpcCallInfo {
    /** 调用方 webContents 的 id。 */
    webContentsId: number;
    /** 调用方 frame 的 URL（来源白名单校验依据）。 */
    frameUrl: string;
}

/** transport 调用的 listener；必须以信封 resolve、永不 reject。 */
export type IpcListener = (
    payload: unknown,
    info: IpcCallInfo,
) => Promise<RpcResult<unknown>>;

/** 与 electron ipcMain 解耦的传输接口（单测可替换）。 */
export interface IpcTransport {
    /** 为 channel 注册 listener。 */
    handle(channel: string, listener: IpcListener): void;
}

/** 每次 IPC 调用构造的 handler 上下文（Depends 的对应物）。 */
export interface HandlerContext {
    /** 带 channel 标签的子 logger。 */
    readonly log: Logger;
    /** 服务获取器。 */
    readonly services: ServiceAccessor;
    /** 事件发布器。 */
    readonly events: EventPublisher;
    /** 调用方信息。 */
    readonly sender: IpcCallInfo;
    /** 调用时刻的生命周期状态。 */
    readonly state: LifecycleState;
}

/** procedure 的 handler：接收上下文与已校验的输入。 */
export type RouteHandler<P extends Procedure> = (
    ctx: HandlerContext,
    input: ProcedureInput<P>,
) => Promise<ProcedureOutput<P>> | ProcedureOutput<P>;

/** 路由注册器（模块通过它注册端点）。 */
export interface RouteRegistrar {
    /** 注册一个 procedure 的 handler；channel 重复会抛错。 */
    handle<P extends Procedure>(proc: P, handler: RouteHandler<P>): void;
}

/** 路由构造选项。 */
export interface RouterOptions {
    /** 服务获取器（构造 per-call ctx 用）。 */
    readonly services: ServiceAccessor;
    /** 生命周期状态机（调用门禁）。 */
    readonly lifecycle: Lifecycle;
    /** 环境信息（frame 来源白名单）。 */
    readonly env: AppEnv;
    /** 根 logger。 */
    readonly logger: Logger;
    /** 事件发布器（注入 per-call ctx）。 */
    readonly events: EventPublisher;
}

/** 一条已注册的路由。 */
interface RouteEntry {
    readonly channel: string;
    readonly proc: Procedure;
    readonly handler: RouteHandler<Procedure>;
}

/** 把 zod 校验错误压缩为可序列化的 issue 摘要。 */
function issueSummary(error: z.ZodError): unknown {
    return error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
        code: issue.code,
    }));
}

/**
 * 契约优先的 IPC 路由。每次调用依次经过：
 * 来源白名单 -> 生命周期门禁 -> 输入校验 -> handler -> 输出校验，
 * 恒以 RpcResult 信封 resolve（错误为何不走 reject 见 contracts/rpc）。
 */
export class IpcRouter implements RouteRegistrar {
    private readonly routes = new Map<string, RouteEntry>();

    constructor(private readonly options: RouterOptions) {}

    handle<P extends Procedure>(proc: P, handler: RouteHandler<P>): void {
        if (this.routes.has(proc.channel)) {
            throw new Error(`IPC channel already handled: ${proc.channel}`);
        }
        this.routes.set(proc.channel, {
            channel: proc.channel,
            proc,
            handler: handler as RouteHandler<Procedure>,
        });
    }

    /** 已注册的全部 channel（装配日志与调试用）。 */
    get channels(): string[] {
        return [...this.routes.keys()];
    }

    /** 把全部路由绑定到 transport。 */
    install(transport: IpcTransport): void {
        for (const route of this.routes.values()) {
            transport.handle(route.channel, (payload, info) =>
                this.dispatch(route, payload, info),
            );
        }
    }

    /** 判断 frame 来源是否在白名单内。 */
    private isAllowedFrame(frameUrl: string): boolean {
        if (frameUrl === '') return false;
        return this.options.env.allowedFrameOrigins.some((origin) =>
            frameUrl.startsWith(origin),
        );
    }

    /** 单次调用的完整处理管线；任何失败都转为错误信封。 */
    private async dispatch(
        route: RouteEntry,
        payload: unknown,
        info: IpcCallInfo,
    ): Promise<RpcResult<unknown>> {
        const { logger } = this.options;
        try {
            if (!this.isAllowedFrame(info.frameUrl)) {
                logger.warn('rejected IPC call from untrusted frame', {
                    channel: route.channel,
                    frameUrl: info.frameUrl,
                });
                return err('FORBIDDEN', 'calling frame is not allowed to invoke IPC');
            }

            const state = this.options.lifecycle.state;
            if (state !== 'ready') {
                return err('UNAVAILABLE', `backend is not ready (state: ${state})`);
            }

            const parsedInput = route.proc.input.safeParse(payload);
            if (!parsedInput.success) {
                return err('VALIDATION', `invalid input for ${route.channel}`, {
                    issues: issueSummary(parsedInput.error),
                });
            }

            const ctx: HandlerContext = {
                log: logger.child(route.channel),
                services: this.options.services,
                events: this.options.events,
                sender: info,
                state,
            };
            const rawOutput = await route.handler(ctx, parsedInput.data as never);

            const parsedOutput = route.proc.output.safeParse(rawOutput);
            if (!parsedOutput.success) {
                logger.error('handler output rejected by schema', {
                    channel: route.channel,
                    issues: issueSummary(parsedOutput.error),
                });
                return err('INTERNAL', `handler output invalid for ${route.channel}`);
            }
            return ok(parsedOutput.data);
        } catch (cause) {
            if (cause instanceof RpcError) {
                return { ok: false, error: cause.toPayload() };
            }
            logger.error('unhandled IPC handler failure', {
                channel: route.channel,
                error: cause,
            });
            const message =
                cause instanceof Error ? cause.message : 'unknown handler failure';
            return err('INTERNAL', message);
        }
    }
}
