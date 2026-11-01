import type {
    DeploymentChange,
    DeploymentHealthConfig,
    DeploymentProfile,
    DeploymentSpec,
    DeploymentState,
    DeploymentStatus,
} from '../api/deployment';
import {
    DeploymentManagerClosedError,
    DeploymentNotReadyError,
    DeploymentStartFailedError,
    InvalidDeploymentError,
    UnknownDeploymentError,
} from '../api/deployment';
import type { DeploymentControlPlane } from './controller';
import type { AppEnv } from '../api/env';
import type { Logger } from '../api/logger';
import type { HostedProcess, ProcessHost } from '../spi/process-host';

/** 缺省健康探测路径。 */
const DEFAULT_HEALTH_PATH = '/health';
/** 缺省探测轮询间隔（ms）。 */
const DEFAULT_HEALTH_INTERVAL_MS = 500;
/** 缺省单次探测超时（ms）。 */
const DEFAULT_PROBE_TIMEOUT_MS = 2000;
/** 缺省 managed 就绪等待上限（ms）。 */
const DEFAULT_READY_TIMEOUT_MS = 15_000;
/** 缺省优雅停止等待上限（ms）。 */
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

/** DeploymentManagerImpl 的构造选项。 */
export interface DeploymentManagerOptions {
    /** 进程宿主 SPI（拉起外部可执行程序的实际通道）。 */
    readonly processHost: ProcessHost;
    /** 环境信息（profile 仅在 isDev 时应用）。 */
    readonly env: AppEnv;
    /** 根 logger（manager 会派生 `deployments` / `deploy:<id>` 子标签）。 */
    readonly logger: Logger;
    /** dev 模式的部署覆盖 profile。 */
    readonly profile?: DeploymentProfile;
}

/** 单个部署的运行时记录（生效 spec + 状态 + 托管进程句柄）。 */
interface DeploymentRuntime {
    /** 生效 spec（已应用 profile 覆盖）。 */
    readonly spec: DeploymentSpec;
    /** 当前运行状态。 */
    state: DeploymentState;
    /** 托管进程 pid（external 模式恒为 null）。 */
    pid: number | null;
    /** 状态补充说明。 */
    detail: string | undefined;
    /** 快照更新时间戳（ms）。 */
    updatedAt: number;
    /** 托管进程句柄（拉起后存在，退出后清除）。 */
    proc: HostedProcess | undefined;
    /** external 模式的就绪探测定时器。 */
    probeTimer: NodeJS.Timeout | undefined;
    /** 托管进程输出订阅的退订函数（进程退出/重启订阅时清理）。 */
    unsubscribeOutput: (() => void) | undefined;
    /** 停止意图标志（区分「主动停止」与「意外崩溃」）。 */
    stopInitiated: boolean;
    /** 该部署的子 logger。 */
    readonly log: Logger;
}

/** unref 的 sleep（探测循环不阻止进程退出）。 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref();
    });
}

/**
 * 部署控制面实现：外部领域服务（独立可执行程序）的启动/停止编排与状态
 * 跟踪。controller/readiness/admin 三个受众接口实现于同一对象（接口见
 * api/deployment.ts 与 controller.ts），状态只有一份。
 *
 * - managed 模式：经 ProcessHost 拉起进程，轮询健康端点直到就绪（超时置
 *   failed 并清理残留进程）；进程意外退出置 crashed；停止走
 *   SIGTERM -> 等待 -> SIGKILL 的优雅终止。
 * - external 模式：进程由外部运行（dev 下由用户手动启动），控制面只做
 *   就绪探测（无超时上限，直到服务上线或被停止）。
 * - profile 覆盖仅在 env.isDev 时应用（打包产物恒用模块申报的原始 spec）。
 * - required 策略：required 部署启动失败使 startAll reject（硬依赖）；
 *   可选部署失败只记录状态（保持 sidecar 可缺席的既有行为）。
 */
export class DeploymentManagerImpl implements DeploymentControlPlane {
    private readonly processHost: ProcessHost;
    private readonly env: AppEnv;
    private readonly logger: Logger;
    private readonly profile: DeploymentProfile | undefined;
    private readonly runtimes = new Map<string, DeploymentRuntime>();
    private readonly changeListeners: Array<(change: DeploymentChange) => void> = [];
    private closed = false;

    constructor(options: DeploymentManagerOptions) {
        this.processHost = options.processHost;
        this.env = options.env;
        this.logger = options.logger;
        this.profile = options.profile;
    }

    // ---- 框架内部面（DeploymentController：内核在启动/关停时序中调用）----

    /** 注册一个部署声明（应用 profile 覆盖并校验）；重复 id 抛错。 */
    register(spec: DeploymentSpec): void {
        if (this.runtimes.has(spec.id)) {
            throw new InvalidDeploymentError(`duplicate deployment id: ${spec.id}`);
        }
        const effective = this.applyProfile(spec);
        let origin: URL;
        try {
            origin = new URL(effective.baseUrl);
        } catch {
            throw new InvalidDeploymentError(
                `deployment "${spec.id}" has invalid baseUrl: ${effective.baseUrl}`,
            );
        }
        if (origin.pathname !== '/' || origin.search || origin.hash) {
            throw new InvalidDeploymentError(
                `deployment "${spec.id}" baseUrl must be an origin only: ${effective.baseUrl}`,
            );
        }
        if (this.modeOf(effective) === 'managed' && !effective.command) {
            throw new InvalidDeploymentError(
                `managed deployment "${spec.id}" requires a command`,
            );
        }
        this.runtimes.set(spec.id, {
            spec: effective,
            state: 'registered',
            pid: null,
            detail: undefined,
            updatedAt: Date.now(),
            proc: undefined,
            probeTimer: undefined,
            unsubscribeOutput: undefined,
            stopInitiated: false,
            log: this.logger.child(`deploy:${spec.id}`),
        });
        this.logger.info('deployment registered', {
            id: effective.id,
            mode: this.modeOf(effective),
            baseUrl: effective.baseUrl,
            required: effective.required ?? false,
        });
    }

    /**
     * 启动全部已注册部署：managed 并行拉起并等待就绪（或 failed）；
     * external 只挂上探测循环立即返回（dev 语义：等用户手动启动）。
     * 可选部署失败不阻断其余部署；required 部署失败在全部落定后整体
     * reject（不无条件吞掉异常，框架据此区分硬依赖失败并回滚启动）。
     */
    async startAll(): Promise<void> {
        const requiredFailures: string[] = [];
        await Promise.all(
            [...this.runtimes.values()].map(async (rt) => {
                try {
                    await this.start(rt.spec.id);
                    if (rt.spec.required && this.dead(rt)) {
                        // start 已解析但状态仍坏（如 health:false 的启动秒退）。
                        requiredFailures.push(rt.spec.id);
                        rt.log.error('required deployment failed to start', {
                            detail: rt.detail,
                        });
                    }
                } catch (cause) {
                    rt.log.error('deployment failed to start', { error: cause });
                    if (rt.spec.required) {
                        requiredFailures.push(rt.spec.id);
                    }
                }
            }),
        );
        if (requiredFailures.length > 0) {
            throw new DeploymentStartFailedError(
                `required deployment(s) failed to start: ${requiredFailures.join(', ')}`,
                requiredFailures,
            );
        }
    }

    /**
     * 停止全部部署并关闭控制面（应用关停 joiner 的最后一段：窗口先销毁、
     * 服务后 dispose、外部进程最后终止）。幂等。
     */
    async stopAll(): Promise<void> {
        this.closed = true;
        await Promise.all(
            [...this.runtimes.keys()].map(async (id) => {
                try {
                    await this.stop(id);
                } catch (cause) {
                    this.logger.error('deployment failed to stop', { id, error: cause });
                }
            }),
        );
    }

    // ---- 就绪查询受众（DeploymentReadiness：外部服务客户端用）----

    /** 单个部署的状态快照；未知 id 返回 undefined。 */
    getStatus(id: string): DeploymentStatus | undefined {
        const rt = this.runtimes.get(id);
        return rt ? this.snapshot(rt) : undefined;
    }

    /** 等待部署就绪（running）；终态或超时 reject DeploymentNotReadyError。 */
    whenReady(id: string, timeoutMs?: number): Promise<void> {
        const rt = this.runtimeOf(id);
        const limit = timeoutMs ?? rt.spec.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
        if (rt.state === 'running') return Promise.resolve();
        if (rt.state === 'failed' || rt.state === 'crashed' || rt.state === 'stopped') {
            return Promise.reject(
                new DeploymentNotReadyError(`deployment "${id}" is ${rt.state}`),
            );
        }
        return new Promise<void>((resolve, reject) => {
            const settle = (finish: () => void): void => {
                clearTimeout(timer);
                off();
                finish();
            };
            const timer = setTimeout(() => {
                settle(() =>
                    reject(
                        new DeploymentNotReadyError(
                            `deployment "${id}" not ready within ${limit}ms (state: ${rt.state})`,
                        ),
                    ),
                );
            }, limit);
            timer.unref();
            const off = this.onChange((change) => {
                if (change.status.id !== id) return;
                if (change.to === 'running') {
                    settle(() => resolve());
                } else if (
                    change.to === 'failed' ||
                    change.to === 'crashed' ||
                    change.to === 'stopped'
                ) {
                    settle(() =>
                        reject(
                            new DeploymentNotReadyError(
                                `deployment "${id}" is ${change.to}`,
                            ),
                        ),
                    );
                }
            });
        });
    }

    /** 订阅状态迁移；返回取消订阅函数。 */
    onChange(listener: (change: DeploymentChange) => void): () => void {
        this.changeListeners.push(listener);
        return () => {
            const index = this.changeListeners.indexOf(listener);
            if (index >= 0) this.changeListeners.splice(index, 1);
        };
    }

    // ---- 管理受众（DeploymentAdmin：deployments 管理模块用）----

    /** 全部部署的状态快照（按注册顺序）。 */
    list(): DeploymentStatus[] {
        return [...this.runtimes.values()].map((rt) => this.snapshot(rt));
    }

    /** 启动部署并返回快照（managed 等待就绪或失败；external 立即返回 waiting）。 */
    async start(id: string): Promise<DeploymentStatus> {
        const rt = this.runtimeOf(id);
        this.assertOpen();
        rt.stopInitiated = false;
        this.clearProbe(rt);
        if (this.modeOf(rt.spec) === 'external') {
            await this.startExternal(rt);
        } else {
            await this.startManaged(rt);
        }
        if (this.dead(rt)) {
            // 托管启动序列结束仍未就绪（spawn 失败/就绪超时）：以错误表达
            // 失败结果，调用方（startAll/管理端点）能区分成功与失败。
            throw new DeploymentStartFailedError(
                `deployment "${id}" failed to start` +
                    (rt.detail ? `: ${rt.detail}` : ''),
                [id],
            );
        }
        return this.snapshot(rt);
    }

    /** 停止部署并返回快照（managed 优雅终止；external 撤销探测）。 */
    async stop(id: string): Promise<DeploymentStatus> {
        const rt = this.runtimeOf(id);
        if (rt.state === 'registered' || rt.state === 'stopped') {
            return this.snapshot(rt);
        }
        this.clearProbe(rt);
        rt.stopInitiated = true;
        if (!rt.proc) {
            // external 模式或进程已退出：直接落 stopped。
            this.setState(rt, 'stopped');
            return this.snapshot(rt);
        }
        this.setState(rt, 'stopping');
        await this.terminate(rt);
        this.setState(rt, 'stopped');
        return this.snapshot(rt);
    }

    /** 重启部署（停止后重新启动）并返回快照。 */
    async restart(id: string): Promise<DeploymentStatus> {
        const rt = this.runtimeOf(id);
        this.assertOpen();
        await this.stop(id);
        rt.stopInitiated = false;
        return this.start(id);
    }

    // ---- 内部实现 ----

    /** 托管启动：拉起进程 + 健康探测（或 health:false 直接视为就绪）。 */
    private async startManaged(rt: DeploymentRuntime): Promise<void> {
        if (rt.state === 'running' || rt.state === 'starting') {
            rt.log.warn('start requested but deployment is already active', {
                state: rt.state,
            });
            return;
        }
        const { spec } = rt;
        if (!spec.command) {
            throw new InvalidDeploymentError(
                `managed deployment "${spec.id}" requires a command`,
            );
        }
        this.setState(rt, 'starting');
        const proc = this.processHost.spawn({
            command: spec.command,
            args: spec.args,
            cwd: spec.cwd,
            env: spec.env,
        });
        rt.proc = proc;
        rt.pid = proc.pid ?? null;
        rt.unsubscribeOutput?.();
        rt.unsubscribeOutput = proc.onOutput((stream, line) => {
            if (stream === 'stderr') rt.log.warn('external service output', { line });
            else rt.log.debug('external service output', { line });
        });
        // 意外退出检测（crash）与启动失败检测（spawn error）。
        void proc.exited.then((exit) => this.handleExit(rt, exit));
        if (spec.health === false) {
            // health:false 也给启动失败一个确定性的暴露窗口：等进程立即
            // 退出（spawn 失败/秒退）或一个事件循环 tick，二者先到。
            await Promise.race([proc.exited.then(() => undefined), sleep(0)]);
            if (rt.stopInitiated) return;
            if (this.dead(rt)) return; // start() 统一抛错。
            this.setState(rt, 'running');
            return;
        }
        await this.probeUntilReady(rt, spec.health ?? {});
    }

    /** external 启动：挂上无上限的就绪探测循环并立即返回。 */
    private async startExternal(rt: DeploymentRuntime): Promise<void> {
        if (rt.state === 'running' || rt.state === 'waiting') {
            rt.log.warn('start requested but deployment is already active', {
                state: rt.state,
            });
            return;
        }
        this.setState(rt, 'waiting', 'waiting for externally managed service');
        if (rt.spec.health === false) {
            // 无健康端点的 external 部署：信任 baseUrl 直接视为就绪。
            this.setState(rt, 'running');
            return;
        }
        const health = rt.spec.health ?? {};
        const interval = health.intervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
        const tick = async (): Promise<void> => {
            if (rt.state !== 'waiting' || rt.stopInitiated) return;
            if (await this.probeOnce(rt, health)) {
                if (rt.state !== 'waiting' || rt.stopInitiated) return;
                this.setState(rt, 'running');
                return;
            }
            if (rt.state !== 'waiting' || rt.stopInitiated) return;
            rt.probeTimer = setTimeout(() => void tick(), interval);
            rt.probeTimer.unref();
        };
        void tick();
    }

    /** managed 就绪探测：轮询健康端点直到通过或超时（超时置 failed 并清理）。 */
    private async probeUntilReady(
        rt: DeploymentRuntime,
        health: DeploymentHealthConfig,
    ): Promise<void> {
        const limit = rt.spec.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
        const interval = health.intervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
        const deadline = Date.now() + limit;
        while (!rt.stopInitiated && !this.dead(rt) && Date.now() < deadline) {
            if (await this.probeOnce(rt, health)) {
                if (rt.stopInitiated || this.dead(rt)) return;
                this.setState(rt, 'running');
                return;
            }
            await sleep(interval);
        }
        if (rt.stopInitiated || this.dead(rt)) return;
        this.setState(rt, 'failed', `health check not passing within ${limit}ms`);
        // 就绪超时：尽力终止残留进程，避免孤儿进程。
        await this.terminate(rt);
    }

    /** 单次健康探测：2xx 视为健康，网络错误/超时视为未就绪。 */
    private async probeOnce(
        rt: DeploymentRuntime,
        health: DeploymentHealthConfig,
    ): Promise<boolean> {
        const path = health.path ?? DEFAULT_HEALTH_PATH;
        try {
            const response = await fetch(new URL(path, rt.spec.baseUrl).toString(), {
                signal: AbortSignal.timeout(health.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    /** 进程退出回调：区分主动停止、启动失败与意外崩溃。 */
    private handleExit(
        rt: DeploymentRuntime,
        exit: { code: number | null; signal: string | null; error?: string },
    ): void {
        rt.proc = undefined;
        rt.pid = null;
        rt.unsubscribeOutput?.();
        rt.unsubscribeOutput = undefined;
        if (rt.stopInitiated) return; // stop() 流程会落 stopped
        if (exit.error !== undefined) {
            this.setState(rt, 'failed', `failed to start: ${exit.error}`);
            return;
        }
        if (rt.state === 'running' || rt.state === 'starting') {
            this.setState(
                rt,
                'crashed',
                `process exited unexpectedly (code=${exit.code}, signal=${exit.signal})`,
            );
        }
    }

    /** 优雅终止托管进程：SIGTERM -> 等待 grace -> SIGKILL。 */
    private async terminate(rt: DeploymentRuntime): Promise<void> {
        const proc = rt.proc;
        if (!proc) return;
        const grace = rt.spec.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
        proc.kill('SIGTERM');
        const settled = await Promise.race([
            proc.exited.then(() => true),
            sleep(grace).then(() => false),
        ]);
        if (!settled) {
            proc.kill('SIGKILL');
            await proc.exited;
        }
    }

    /** 清除挂起的探测定时器。 */
    private clearProbe(rt: DeploymentRuntime): void {
        if (rt.probeTimer !== undefined) {
            clearTimeout(rt.probeTimer);
            rt.probeTimer = undefined;
        }
    }

    /** 应用 profile 覆盖（仅 dev 生效；浅合并，id 不可变）。 */
    private applyProfile(spec: DeploymentSpec): DeploymentSpec {
        if (!this.env.isDev || !this.profile) return spec;
        const override = this.profile[spec.id];
        return override ? { ...spec, ...override } : spec;
    }

    /** 生效模式（spec.mode 缺省 managed）。 */
    private modeOf(spec: DeploymentSpec): 'managed' | 'external' {
        return spec.mode ?? 'managed';
    }

    /** 部署是否已进入不可恢复的坏终态（启动失败/崩溃）。 */
    private dead(rt: DeploymentRuntime): boolean {
        return rt.state === 'failed' || rt.state === 'crashed';
    }

    /** 取运行时记录；未知 id 抛 UnknownDeploymentError。 */
    private runtimeOf(id: string): DeploymentRuntime {
        const rt = this.runtimes.get(id);
        if (!rt) {
            throw new UnknownDeploymentError(`unknown deployment: ${id}`);
        }
        return rt;
    }

    /** 控制面已关闭时拒绝启动类操作。 */
    private assertOpen(): void {
        if (this.closed) {
            throw new DeploymentManagerClosedError(
                'deployment manager is closed (app is shutting down)',
            );
        }
    }

    /** 状态迁移：更新快照、记日志并通知监听器（单个失败不中断其余）。 */
    private setState(
        rt: DeploymentRuntime,
        next: DeploymentState,
        detail?: string,
    ): void {
        const from = rt.state;
        rt.state = next;
        rt.detail = detail;
        rt.updatedAt = Date.now();
        if (from === next) return; // 同态迁移视为 no-op（不重复广播）
        rt.log.info(`deployment ${from} -> ${next}`, detail ? { detail } : undefined);
        const change: DeploymentChange = {
            from,
            to: next,
            status: this.snapshot(rt),
        };
        for (const listener of Array.from(this.changeListeners)) {
            try {
                listener(change);
            } catch (cause) {
                this.logger.error('deployment change listener failed', { error: cause });
            }
        }
    }

    /** 生成不可变快照。 */
    private snapshot(rt: DeploymentRuntime): DeploymentStatus {
        return {
            id: rt.spec.id,
            state: rt.state,
            mode: this.modeOf(rt.spec),
            baseUrl: rt.spec.baseUrl,
            pid: rt.pid,
            detail: rt.detail,
            updatedAt: rt.updatedAt,
        };
    }
}
