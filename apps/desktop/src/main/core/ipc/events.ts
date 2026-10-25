import type { EventDefinition, EventPayload } from '@desktop-frame/contracts';
import type { EventPublisher } from '../ports/event-publisher';
import type { EventSink } from '../ports/event-sink';
import type { Logger } from '../ports/logger';

/**
 * 事件发布器的实现（接口见 ports/event-publisher.ts）：
 * 校验负载后经 EventSink 扇出；校验失败记日志并丢弃。
 */
export class EventPublisherImpl implements EventPublisher {
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
