import { desktopApp } from './core/builder';
import type { DeploymentProfile } from './core';
import type { DesktopApp } from './core/desktop-app';
import { createElectronHost } from './electron/host';
import { createElectronIpcTransport } from './electron/ipc-transport';
import { createAppLogger } from './electron/logging';
import { createNodeProcessHost } from './electron/process-host';
import { WindowManager } from './electron/windows-manager';
import { createMainWindowDefinition } from './windows';
import { deploymentsModule } from './modules/deployments/deployments.module';
import { searchModule } from './modules/search/search.module';
import { settingsModule } from './modules/settings/settings.module';
import { systemModule } from './modules/system/system.module';

/**
 * dev 模式的部署 profile（框架仅在未打包时应用，见 DeploymentManager）：
 * 外部搜索服务切到 external 模式，由开发者手动启动——
 *   node apps/desktop/test/fixtures/echo-service.mjs
 * 框架只做就绪探测等待。想在 dev 里演示托管拉起（自动 spawn fixture），
 * 把 search 覆盖换成：
 *   { mode: 'managed', command: process.execPath,
 *     args: [path.join(__dirname, '../../test/fixtures/echo-service.mjs')] }
 */
const devDeploymentProfile: DeploymentProfile = {
    search: {
        mode: 'external',
        baseUrl: 'http://127.0.0.1:7801',
    },
};

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
        processHost: createNodeProcessHost(),
        mainDir: __dirname,
        createLogger: createAppLogger,
        createWindows: ({ env, logger }) => new WindowManager(env, logger),
        deploymentProfile: devDeploymentProfile,
    })
        .use(systemModule, settingsModule, deploymentsModule, searchModule)
        .window(createMainWindowDefinition())
        .build();
}
