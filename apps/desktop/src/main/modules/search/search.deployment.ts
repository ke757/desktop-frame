import type { DeploymentSpec } from '../../core';

/** 搜索域服务的部署 id（spec 与适配层服务共用，避免字符串漂移）。 */
export const SEARCH_DEPLOYMENT_ID = 'search';

/**
 * 搜索域服务的部署声明（当前版本按约定硬编码为模块变量）。
 *
 * - 打包形态：外部可执行程序应随安装包分发（forge extraResources），
 *   `command` 指向其绝对路径；此处用 PATH 占位名，dev 由装配脚本的
 *   profile 覆盖（见 main/index.ts）。
 * - dev 形态：profile 把它切到 external 模式——开发者手动启动
 *   `apps/desktop/test/fixtures/echo-service.mjs`，框架只探测等待。
 */
export const searchDeployment: DeploymentSpec = {
    id: SEARCH_DEPLOYMENT_ID,
    mode: 'managed',
    command: 'search-server',
    baseUrl: 'http://127.0.0.1:7801',
    health: { path: '/health' },
};
