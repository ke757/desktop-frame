import { desktopApp } from './core/builder';
import type { DesktopApp } from './core/desktop-app';
import { createElectronHost } from './electron-host';
import { createElectronIpcTransport } from './electron-transport';
import { createAppLogger } from './logging';
import { settingsModule } from './modules/settings/settings.module';
import { systemModule } from './modules/system/system.module';
import { WindowManager } from './windows/manager';
import { createMainWindowDefinition } from './windows/definitions';

/**
 * 装配脚本（composition script）：全仓库唯一声明"这个应用由什么组成"的
 * 地方。只做声明（哪些模块、哪个窗口、electron 适配注入），框架接线
 * 全部在 core/builder.ts 的 build() 内完成——业务增删只改这里的
 * `.use()` / `.window()`，不碰任何接线代码。
 */
export function buildDesktopApp(): DesktopApp {
    return desktopApp({
        host: createElectronHost(),
        transport: createElectronIpcTransport(),
        mainDir: __dirname,
        createLogger: createAppLogger,
        createWindows: ({ env, logger }) => new WindowManager(env, logger),
    })
        .use(systemModule, settingsModule)
        .window(createMainWindowDefinition())
        .build();
}
