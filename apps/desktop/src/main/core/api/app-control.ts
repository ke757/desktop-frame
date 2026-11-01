/**
 * 应用控制的窄公开面（模块作者 API）：完整宿主接口（宿主事件订阅、
 * `exit()`、单实例锁等）只是内核 SPI（core/spi/host.ts），不向业务公开。
 * 业务需要"退出应用"时只拿得到这个窄接口——quit 会进入优雅关停管线。
 */
export interface AppControl {
    /** 请求退出应用：触发 before-quit → 关停管线（对齐 Tauri AppHandle::exit 的角色）。 */
    quit(): void;
}
