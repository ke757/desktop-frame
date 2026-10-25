/**
 * 日志端口：core 与业务只依赖此接口；`electron/logging.ts` 用
 * electron-log 实现它，测试用 core/logging.ts 的 MemoryLogger。
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
