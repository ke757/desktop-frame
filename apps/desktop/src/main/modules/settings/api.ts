import { serviceToken } from '../../core';
import type { SettingsFile, SettingsPatch } from '@desktop-frame/contracts';

/**
 * settings 模块的跨模块公开面：服务接口与 token。实现类、加载/刷新等
 * 生命周期方法与注册工厂留在 settings.service.ts（模块私有）——跨模块
 * 消费者只能拿到本文件的接口与 token。
 */

/**
 * 设置服务的**公开接口**：token 的类型参数，即模块外允许调用的全部
 * 方法。生命周期方法（load/flush/dispose）刻意不在其中——dispose 是
 * 框架钩子（DisposableService），只由容器在关停时调用。
 */
export interface SettingsService {
    /** 读取当前完整设置（schema 默认值已填充）。 */
    get(): SettingsFile;
    /** 合并补丁、广播变更事件并安排防抖落盘；返回更新后的完整设置。 */
    update(patch: SettingsPatch): SettingsFile;
}

/** 设置服务的服务 token（类型即公开接口）。 */
export const settingsToken = serviceToken<SettingsService>('modules.settings');
