import type { AppEnv } from './env';
import type { EventSink } from './ipc/events';

/**
 * 窗口配方（core 侧纯接口）。`create` 返回宿主窗口对象（Electron 下为
 * BrowserWindow）；具体类型由 app 层的窗口管理器收窄。
 */
export interface WindowDefinition<W = unknown> {
    /** 窗口定义的唯一 id。 */
    readonly id: string;
    /** 主窗口：second-instance / activate 时聚焦或重开。 */
    readonly isPrimary?: boolean;
    /** 按环境构造宿主窗口（安全偏好等在此设置）。 */
    create(env: AppEnv): W;
}

/**
 * 窗口宿主抽象：DesktopApp 依赖此接口而非具体窗口管理器，使组合根
 * （builder.build）保持零 electron 依赖、可用 FakeWindowHost 做集成测试。
 * app/windows/manager.ts 的 WindowManager 是它的 Electron 实现。
 */
export interface WindowHost extends EventSink {
    /** 注册一个窗口定义（id 重复抛错）。 */
    register(definition: WindowDefinition): void;
    /** 主窗口定义 id（无注册定义时为 undefined）。 */
    readonly primaryDefinitionId: string | undefined;
    /** 打开（或聚焦）指定定义的窗口；实现可返回被管理窗口的信息。 */
    openWindow(definitionId: string): Promise<unknown>;
    /** 聚焦主窗口（second-instance 激活路径）。 */
    focusPrimary(): void;
    /** 无存活窗口时重开主窗口（macOS activate 路径）。 */
    openPrimaryIfNone(): Promise<void>;
    /** 立即销毁全部窗口（关停管线第一步）。 */
    closeAll(): void;
}
