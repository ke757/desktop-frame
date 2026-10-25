/**
 * Logger 接口：应用侧由 electron-log 实现，测试侧由 MemoryLogger 实现。
 * 核心框架代码只依赖此接口。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogMeta = Record<string, unknown>;

export interface Logger {
    /** 记录 debug 级日志。 */
    debug(message: string, meta?: LogMeta): void;
    /** 记录 info 级日志。 */
    info(message: string, meta?: LogMeta): void;
    /** 记录 warn 级日志。 */
    warn(message: string, meta?: LogMeta): void;
    /** 记录 error 级日志。 */
    error(message: string, meta?: LogMeta): void;
    /** 派生子 logger，每条日志带上模块名标签。 */
    child(module: string): Logger;
}

/** 一条日志记录。 */
export interface LogEntry {
    /** 记录时间戳（ms）。 */
    time: number;
    /** 日志级别。 */
    level: LogLevel;
    /** 产生日志的模块标签（子 logger 填充）。 */
    module?: string;
    /** 日志消息。 */
    message: string;
    /** 结构化附加信息。 */
    meta?: LogMeta;
}

/** 测试用内存 logger：子 logger 共享同一 entry 缓冲。 */
export class MemoryLogger implements Logger {
    /** 记录缓冲（所有子 logger 共享）。 */
    readonly entries: LogEntry[];

    constructor(entries: LogEntry[] = []) {
        this.entries = entries;
    }

    debug(message: string, meta?: LogMeta): void {
        this.record('debug', message, meta);
    }

    info(message: string, meta?: LogMeta): void {
        this.record('info', message, meta);
    }

    warn(message: string, meta?: LogMeta): void {
        this.record('warn', message, meta);
    }

    error(message: string, meta?: LogMeta): void {
        this.record('error', message, meta);
    }

    child(module: string): Logger {
        return new TaggedLogger(this, module);
    }

    /** 写入一条记录。 */
    private record(
        level: LogLevel,
        message: string,
        meta: LogMeta | undefined,
        module?: string,
    ): void {
        this.entries.push({ time: Date.now(), level, module, message, meta });
    }
}

/** 子 logger：写入时带上 `parent:module` 形式的标签。 */
class TaggedLogger implements Logger {
    constructor(
        private readonly parent: MemoryLogger,
        private readonly label: string,
    ) {}

    debug(message: string, meta?: LogMeta): void {
        this.parent.debug(`[${this.label}] ${message}`, meta);
    }

    info(message: string, meta?: LogMeta): void {
        this.parent.info(`[${this.label}] ${message}`, meta);
    }

    warn(message: string, meta?: LogMeta): void {
        this.parent.warn(`[${this.label}] ${message}`, meta);
    }

    error(message: string, meta?: LogMeta): void {
        this.parent.error(`[${this.label}] ${message}`, meta);
    }

    child(module: string): Logger {
        return new TaggedLogger(this.parent, `${this.label}:${module}`);
    }
}

/** 控制台 logger：builder 在未显式提供 logger 时的默认实现。 */
class ConsoleLogger implements Logger {
    /** 日志前缀链（子 logger 逐级拼接）。 */
    private readonly prefix: string;

    constructor(prefix = '') {
        this.prefix = prefix;
    }

    debug(message: string, meta?: LogMeta): void {
        this.emit('debug', message, meta);
    }

    info(message: string, meta?: LogMeta): void {
        this.emit('info', message, meta);
    }

    warn(message: string, meta?: LogMeta): void {
        this.emit('warn', message, meta);
    }

    error(message: string, meta?: LogMeta): void {
        this.emit('error', message, meta);
    }

    child(module: string): Logger {
        return new ConsoleLogger(this.prefix ? `${this.prefix}:${module}` : module);
    }

    private emit(level: string, message: string, meta?: LogMeta): void {
        const line = this.prefix ? `[${this.prefix}] ${message}` : message;
        const args = meta ? [line, meta] : [line];
        const sink = console as unknown as Record<string, (...items: unknown[]) => void>;
        sink[level](...args);
    }
}

/** 创建默认控制台 logger（应用侧应传入 electron-log 实现）。 */
export function createConsoleLogger(): Logger {
    return new ConsoleLogger();
}
