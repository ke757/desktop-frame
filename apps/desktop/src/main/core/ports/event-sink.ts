/**
 * 事件出口端口：事件投递的最小面。core 不关心事件去了哪里——
 * Electron 下由 WindowHost（webContents.send）实现，测试用内存 sink。
 */
export interface EventSink {
    /** 把一个事件负载投递出去（channel + structured-clone 安全的负载）。 */
    send(channel: string, payload: unknown): void;
}
