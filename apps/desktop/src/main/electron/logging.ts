import log from 'electron-log/main';
import type { LogMeta, Logger } from '../core/ports/logger';

/**
 * 基于 electron-log v5 的主进程 logger。`scope()` 只返回裸日志函数，
 * 因此子 logger 从根重新 scope 并拼接标签。文件默认写入
 * userData/logs/main.log。
 */
class ElectronLogger implements Logger {
    constructor(
        private readonly root: typeof log,
        private readonly label?: string,
    ) {}

    /** 当前实际写入的目标（带标签则从根 scope 出来）。 */
    private get target(): ReturnType<typeof log.scope> {
        return this.label ? this.root.scope(this.label) : this.root;
    }

    debug(message: string, meta?: LogMeta): void {
        this.target.debug(message, ...(meta ? [meta] : []));
    }

    info(message: string, meta?: LogMeta): void {
        this.target.info(message, ...(meta ? [meta] : []));
    }

    warn(message: string, meta?: LogMeta): void {
        this.target.warn(message, ...(meta ? [meta] : []));
    }

    error(message: string, meta?: LogMeta): void {
        this.target.error(message, ...(meta ? [meta] : []));
    }

    child(module: string): Logger {
        return new ElectronLogger(
            this.root,
            this.label ? `${this.label}:${module}` : module,
        );
    }
}

/** 创建应用根 logger 并配置 transport 级别。 */
export function createAppLogger(): Logger {
    log.transports.file.level = 'debug';
    log.transports.console.level =
        process.env.NODE_ENV === 'production' ? 'info' : 'debug';
    return new ElectronLogger(log);
}
