import type { EventDefinition, EventPayload } from '@desktop-frame/contracts';
import type { Logger } from '../logging';

/**
 * 事件出口：把事件投递给 renderer（由 WindowManager 通过
 * `webContents.send` 实现）。抽象出接口使事件发布可脱离窗口单测。
 */
export interface EventSink {
    /** 向所有（或指定的）存活 renderer 发送一条事件。 */
    send(channel: string, payload: unknown): void;
}

/** 类型化的 main→renderer 事件发布器（带负载校验）。 */
export class EventPublisher {
    constructor(
        private readonly sink: EventSink,
        private readonly logger: Logger,
    ) {}

    /** 校验负载后经 sink 广播；校验失败记日志并丢弃。 */
    publish<E extends EventDefinition>(evt: E, payload: EventPayload<E>): void {
        const parsed = evt.payload.safeParse(payload);
        if (!parsed.success) {
            this.logger.error('event payload rejected by schema; dropping', {
                channel: evt.channel,
                issues: parsed.error.issues.map((issue) => ({
                    path: issue.path.map(String).join('.'),
                    message: issue.message,
                })),
            });
            return;
        }
        this.sink.send(evt.channel, parsed.data);
    }
}
