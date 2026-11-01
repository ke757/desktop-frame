import type { Procedure, RpcResult } from '@desktop-frame/contracts';
import { RpcError, err, ok } from '@desktop-frame/contracts';
import type { z } from 'zod';
import type { AppHandle } from '../api/app-handle';
import type { ServiceAccessor } from '../api/di';
import type {
    HandlerContext,
    RouteHandler,
    RouteRegistrar,
} from '../api/route-registrar';
import type { IpcCallInfo, IpcTransport } from '../spi/ipc-transport';

/** 路由构造选项。 */
export interface RouterOptions {
    /** 受限应用句柄（来源白名单、生命周期门禁、根 logger、per-call app）。 */
    readonly app: AppHandle;
    /** 服务获取器（构造 per-call ctx 用；业务/应用服务的唯一通道）。 */
    readonly services: ServiceAccessor;
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
 * 声明登记（handle）发生在 build 阶段，channel 冲突先于任何启动副作用暴露；
 * install（绑定 transport）发生在 run 阶段、lifecycle ready 之前。
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
        return this.options.app.env.allowedFrameOrigins.some((origin) =>
            frameUrl.startsWith(origin),
        );
    }

    /** 单次调用的完整处理管线；任何失败都转为错误信封。 */
    private async dispatch(
        route: RouteEntry,
        payload: unknown,
        info: IpcCallInfo,
    ): Promise<RpcResult<unknown>> {
        const { app } = this.options;
        const logger = app.logger;
        try {
            if (!this.isAllowedFrame(info.frameUrl)) {
                logger.warn('rejected IPC call from untrusted frame', {
                    channel: route.channel,
                    frameUrl: info.frameUrl,
                });
                return err('FORBIDDEN', 'calling frame is not allowed to invoke IPC');
            }

            // 门禁保证 handler 执行时恒为 ready（HandlerContext 因此无需携带 state）。
            if (app.lifecycle.state !== 'ready') {
                return err(
                    'UNAVAILABLE',
                    `backend is not ready (state: ${app.lifecycle.state})`,
                );
            }

            const parsedInput = route.proc.input.safeParse(payload);
            if (!parsedInput.success) {
                return err('VALIDATION', `invalid input for ${route.channel}`, {
                    issues: issueSummary(parsedInput.error),
                });
            }

            const ctx: HandlerContext = {
                app,
                services: this.options.services,
                log: logger.child(route.channel),
                sender: info,
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
