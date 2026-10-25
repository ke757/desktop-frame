/**
 * 进程宿主端口：把「启动/终止操作系统子进程」这一外部能力抽象为 core
 * 拥有的接缝。DeploymentManager 只依赖该抽象（不触碰 node:child_process），
 * 测试注入假实现即可覆盖进程编排逻辑。
 *
 * 实现方为 `electron/process-host.ts`（node:child_process 适配）。Electron
 * 主进程本身就是 Node 进程，OS 级适配器与 electron 适配器同居适配层。
 */

/** 一次子进程启动请求。 */
export interface SpawnOptions {
    /** 可执行文件（推荐绝对路径；相对名走 PATH 查找，行为依赖平台）。 */
    readonly command: string;
    /** 命令行参数。 */
    readonly args?: ReadonlyArray<string>;
    /** 工作目录。 */
    readonly cwd?: string;
    /** 附加环境变量（在继承主进程环境之上覆盖同名项）。 */
    readonly env?: Readonly<Record<string, string>>;
}

/** 子进程退出结果；error 非空表示根本没启动成功（如 ENOENT）。 */
export interface ProcessExit {
    /** 退出码（被信号杀死或启动失败时为 null）。 */
    readonly code: number | null;
    /** 致命信号名。 */
    readonly signal: string | null;
    /** 启动失败的错误描述（仅 spawn error 时存在）。 */
    readonly error?: string;
}

/** 由宿主管理的子进程句柄。 */
export interface HostedProcess {
    /** 子进程 pid（异步启动失败时可能为 undefined）。 */
    readonly pid: number | undefined;
    /** 终止进程；升级到 SIGKILL 的策略由调用方（DeploymentManager）决定。 */
    kill(signal?: string): void;
    /** 进程退出（或启动失败）后 resolve 一次；永不 reject。 */
    readonly exited: Promise<ProcessExit>;
    /** 订阅标准输出/错误输出（已按行切分）；返回取消订阅函数。 */
    onOutput(listener: (stream: 'stdout' | 'stderr', line: string) => void): () => void;
}

/** 进程宿主端口：控制面拉起外部可执行程序的唯一通道。 */
export interface ProcessHost {
    /** 启动一个子进程；同步返回句柄，启动失败经 `exited` 的 error 表达。 */
    spawn(options: SpawnOptions): HostedProcess;
}
