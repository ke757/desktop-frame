import { spawn, type ChildProcess } from 'node:child_process';
import type {
    HostedProcess,
    ProcessExit,
    ProcessHost,
    SpawnOptions,
} from '../core/ports/process-host';

/**
 * ProcessHost 端口的 Node 适配（node:child_process）。Electron 主进程本身
 * 就是 Node 进程，OS 级适配器与 electron 适配器同居适配层（依赖方向同构：
 * 只 import core/ports）。
 */

/** 把流 chunk 切分为完整行（残留尾部在流结束时冲掉）。 */
class LineSplitter {
    private pending = '';

    constructor(private readonly emit: (line: string) => void) {}

    /** 喂入一个 chunk，尽可能切出完整行。 */
    push(chunk: string): void {
        this.pending += chunk;
        let newline = this.pending.indexOf('\n');
        while (newline >= 0) {
            const line = this.pending.slice(0, newline).replace(/\r$/, '');
            this.pending = this.pending.slice(newline + 1);
            if (line) this.emit(line);
            newline = this.pending.indexOf('\n');
        }
    }

    /** 流结束时冲掉残留尾部。 */
    flush(): void {
        const rest = this.pending.trim();
        this.pending = '';
        if (rest) this.emit(rest);
    }
}

/** 等待子进程退出或启动失败；两者先到者生效，只 resolve 一次。 */
function waitExit(child: ChildProcess): Promise<ProcessExit> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (exit: ProcessExit): void => {
            if (!settled) {
                settled = true;
                resolve(exit);
            }
        };
        child.once('exit', (code, signal) => {
            finish({ code: code ?? null, signal: signal ?? null });
        });
        child.once('error', (cause) => {
            finish({ code: null, signal: null, error: cause.message });
        });
    });
}

/** 创建基于 node:child_process 的进程宿主。 */
export function createNodeProcessHost(): ProcessHost {
    return {
        spawn(options: SpawnOptions): HostedProcess {
            const child = spawn(options.command, [...(options.args ?? [])], {
                cwd: options.cwd,
                // 继承主进程环境再覆盖（注意 ELECTRON_* 变量会随之传入子进程，
                // 对 Electron 系外部程序有干扰时应由 spec 的 env 显式清除）。
                env: options.env
                    ? ({ ...process.env, ...options.env } as NodeJS.ProcessEnv)
                    : process.env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const exited = waitExit(child);
            const outputListeners = new Set<
                (stream: 'stdout' | 'stderr', line: string) => void
            >();
            const emit =
                (stream: 'stdout' | 'stderr') =>
                (line: string): void => {
                    for (const listener of outputListeners) listener(stream, line);
                };
            const stdout = new LineSplitter(emit('stdout'));
            const stderr = new LineSplitter(emit('stderr'));
            if (child.stdout) {
                child.stdout.setEncoding('utf8');
                child.stdout.on('data', (chunk: string) => stdout.push(chunk));
                child.stdout.on('close', () => stdout.flush());
            }
            if (child.stderr) {
                child.stderr.setEncoding('utf8');
                child.stderr.on('data', (chunk: string) => stderr.push(chunk));
                child.stderr.on('close', () => stderr.flush());
            }
            return {
                pid: child.pid,
                kill: (signal = 'SIGTERM') => {
                    child.kill(signal as NodeJS.Signals);
                },
                exited,
                onOutput(listener) {
                    outputListeners.add(listener);
                    return () => {
                        outputListeners.delete(listener);
                    };
                },
            };
        },
    };
}
