/**
 * 日志 API（模块作者公共接口）：core、业务与测试只依赖此接口。
 * 实现集合（MemoryLogger/ConsoleLogger）见 core/kernel/logging.ts，
 * 应用侧由 electron/logging.ts（electron-log）实现。
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
