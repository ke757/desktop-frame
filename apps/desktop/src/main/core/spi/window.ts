import type { AppEnv } from '../api/env';

/**
 * 窗口 SPI（core 侧纯接口）。`create` 返回宿主窗口对象（Electron 下为
 * BrowserWindow）；具体类型由适配层（electron/windows-manager.ts）收窄。
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
 * 事件出口 SPI：事件投递的最小面。core 不关心事件去了哪里——
 * Electron 下由 WindowController（webContents.send）实现，测试用内存 sink。
 */
export interface EventSink {
    /** 把一个事件负载投递出去（channel + structured-clone 安全的负载）。 */
    send(channel: string, payload: unknown): void;
}

/**
 * 窗口控制器 SPI：DesktopApp 依赖此抽象而非具体窗口管理器，使框架核心
 * 保持零 electron 依赖、可用 Fake 替换做集成测试。
 * Electron 实现见 electron/windows-manager.ts（WindowManager）。
 * 完整控制器仅供内核与适配器使用，不作为业务 token 公开。
 */
export interface WindowController extends EventSink {
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
