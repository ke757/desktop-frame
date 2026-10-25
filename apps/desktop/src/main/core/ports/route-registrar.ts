import type {
    Procedure,
    ProcedureInput,
    ProcedureOutput,
} from '@desktop-frame/contracts';
import type { ServiceAccessor } from './di';
import type { Logger } from './logger';
import type { EventPublisher } from './event-publisher';
import type { IpcCallInfo } from './ipc-transport';

/**
 * 路由注册端口：业务模块在 registerRoutes 中消费它声明端点；
 * 实现见 core/ipc/router.ts（IpcRouter）。
 */

/** 每次 IPC 调用构造的上下文（请求级依赖注入，FastAPI Depends 的对应物）。 */
export interface HandlerContext {
    /** 本 channel 的子 logger。 */
    readonly log: Logger;
    /** 服务访问器（按 token 解析 app 级服务）。 */
    readonly services: ServiceAccessor;
    /** 事件发布器。 */
    readonly events: EventPublisher;
    /** 调用方信息（窗口关联、来源校验已由路由完成）。 */
    readonly sender: IpcCallInfo;
}

/** 端点处理器：输入/输出类型由 procedure 契约推导。 */
export type RouteHandler<P extends Procedure> = (
    ctx: HandlerContext,
    input: ProcedureInput<P>,
) => Promise<ProcedureOutput<P>> | ProcedureOutput<P>;

/** 路由注册器（模块的 registerRoutes 收到它）。 */
export interface RouteRegistrar {
    /** 声明一个端点的处理器（channel 重复抛错）。 */
    handle<P extends Procedure>(proc: P, handler: RouteHandler<P>): void;
}
