import type { EventDefinition, EventPayload } from '@desktop-frame/contracts';

/**
 * 事件发布端口：业务与框架经它向 renderer 发布类型化事件。
 * 实现见 core/ipc/events.ts（EventPublisherImpl，做 schema 校验后扇出）。
 */
export interface EventPublisher {
    /** 发布事件：payload 先经事件 schema 校验（不合法则丢弃并记日志）。 */
    publish<E extends EventDefinition>(evt: E, payload: EventPayload<E>): void;
}
