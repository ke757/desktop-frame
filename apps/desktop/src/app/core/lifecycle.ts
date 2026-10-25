import type { Logger } from './logging';

/**
 * 后端的显式生命周期状态机。
 *
 * Electron 只提供裸 app 事件；大型应用（参照 VS Code）在其上叠加一层
 * 只进不退的 phase 机器，以便：
 * - 启动任务可以等待某个阶段（`when`）；
 * - 关停是一条受监督的管线（joiner 按序执行，单项失败只记日志、绝不中断后续清理）；
 * - 子系统（如 IPC 路由）可以基于当前状态做门禁。
 *
 * 状态迁移：initializing -> ready -> shuttingDown -> exited。
 */

/** 生命周期状态。 */
export type LifecycleState = 'initializing' | 'ready' | 'shuttingDown' | 'exited';

/** 状态次序表（只进不退）。 */
const ORDER: Record<LifecycleState, number> = {
    initializing: 0,
    ready: 1,
    shuttingDown: 2,
    exited: 3,
};

/** 一次状态迁移。 */
export interface LifecycleChange {
    /** 迁移前状态。 */
    from: LifecycleState;
    /** 迁移后状态。 */
    to: LifecycleState;
}

/** 关停管线中的清理钩子。 */
export type ShutdownJoiner = () => void | Promise<void>;

/** 生命周期相关错误（非法迁移等）。 */
export class LifecycleError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LifecycleError';
    }
}

/** 生命周期状态机：状态迁移、变更订阅、关停 joiner 管线。 */
export class LifecycleService {
    private currentState: LifecycleState = 'initializing';
    private readonly waiters: Array<{ target: LifecycleState; resolve: () => void }> = [];
    private readonly shutdownJoiners: ShutdownJoiner[] = [];
    private readonly changeListeners: Array<(change: LifecycleChange) => void> = [];

    constructor(private readonly logger?: Logger) {}

    /** 当前状态。 */
    get state(): LifecycleState {
        return this.currentState;
    }

    /**
     * 迁移到下一状态：拒绝回退，置同态为 no-op；
     * 触发变更监听器并唤醒已满足条件的等待者。
     */
    transition(next: LifecycleState): void {
        if (ORDER[next] < ORDER[this.currentState]) {
            throw new LifecycleError(
                `lifecycle cannot move backwards: ${this.currentState} -> ${next}`,
            );
        }
        if (next === this.currentState) return;

        const change: LifecycleChange = { from: this.currentState, to: next };
        this.currentState = next;
        this.logger?.debug('lifecycle transition', {
            from: change.from,
            to: change.to,
        });
        // 拷贝快照：监听器可能在迭代中退订（修改数组）。
        for (const listener of Array.from(this.changeListeners)) {
            try {
                listener(change);
            } catch (cause) {
                this.logger?.error('lifecycle change listener failed', {
                    error: cause,
                });
            }
        }
        for (const waiter of this.waiters.splice(0)) {
            if (ORDER[waiter.target] <= ORDER[next]) waiter.resolve();
            else this.waiters.push(waiter);
        }
    }

    /** 等到状态到达（或越过）target 时 resolve；已到达则立即 resolve。 */
    when(target: LifecycleState): Promise<void> {
        if (ORDER[target] <= ORDER[this.currentState]) return Promise.resolve();
        return new Promise((resolve) => {
            this.waiters.push({ target, resolve });
        });
    }

    /** 订阅状态迁移；返回取消订阅函数。 */
    onChange(listener: (change: LifecycleChange) => void): () => void {
        this.changeListeners.push(listener);
        return () => {
            const index = this.changeListeners.indexOf(listener);
            if (index >= 0) this.changeListeners.splice(index, 1);
        };
    }

    /**
     * 向关停管线注册清理钩子：按注册顺序串行执行，单项错误记日志后继续。
     * 关停已开始后注册会被拒绝（静默丢弃清理是隐患，故记警告）。
     */
    onShutdown(joiner: ShutdownJoiner): void {
        if (ORDER[this.currentState] >= ORDER.shuttingDown) {
            this.logger?.warn('ignoring shutdown joiner registered during shutdown');
            return;
        }
        this.shutdownJoiners.push(joiner);
    }

    /** 执行关停管线并落至 exited；幂等。 */
    async shutdown(): Promise<void> {
        if (ORDER[this.currentState] >= ORDER.shuttingDown) return;
        this.transition('shuttingDown');
        for (const joiner of this.shutdownJoiners.splice(0)) {
            try {
                await joiner();
            } catch (cause) {
                this.logger?.error('shutdown joiner failed', { error: cause });
            }
        }
        this.transition('exited');
    }
}
