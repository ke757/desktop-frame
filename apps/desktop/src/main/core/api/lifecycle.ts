/**
 * 生命周期只读视图（模块作者可见的最小面）：完整的状态机
 * （迁移/关停 joiner 管线）由内核独占持有，不通过任何公开 token 暴露。
 * 本视图是 DesktopApp 对进程壳与测试暴露的只读生命周期面。
 */

/** 生命周期状态。 */
export type LifecycleState = 'initializing' | 'ready' | 'shuttingDown' | 'exited';

/** 一次状态迁移。 */
export interface LifecycleChange {
    /** 迁移前状态。 */
    from: LifecycleState;
    /** 迁移后状态。 */
    to: LifecycleState;
}

/** 生命周期的只读视图：当前状态、可等待、可订阅，不能迁移或关停。 */
export interface LifecycleView {
    /** 当前状态。 */
    get state(): LifecycleState;
    /** 等到状态到达（或越过）target 时 resolve；已到达则立即 resolve。 */
    when(target: LifecycleState): Promise<void>;
    /** 订阅状态迁移；返回取消订阅函数。 */
    onChange(listener: (change: LifecycleChange) => void): () => void;
}
