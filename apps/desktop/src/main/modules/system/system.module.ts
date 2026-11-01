import { BrowserWindow, dialog, webContents } from 'electron';
import { RpcError, contract } from '@desktop-frame/contracts';
import type { AppModule } from '../../core';

/**
 * system 模块：演示如何消费 per-call 上下文——`sender` 做窗口关联、
 * `ctx.services` 取业务服务、`ctx.app` 用内核能力（应用信息走 env、退出
 * 走 quit， RpcError 表达类型化业务失败）。完整宿主接口（exit/宿主事件）
 * 是内核 SPI，不对业务公开。
 */
export const systemModule: AppModule = {
    id: 'system',

    registerRoutes(registrar) {
        registrar.handle(contract.system.getInfo, async (ctx) => {
            // 应用信息来自受限应用上下文的只读环境（不再经容器解析）。
            const env = ctx.app.env;
            return {
                appName: env.appName,
                appVersion: env.appVersion,
                electron: process.versions.electron ?? 'unknown',
                chrome: process.versions.chrome ?? 'unknown',
                node: process.versions.node ?? 'unknown',
                platform: process.platform,
                arch: process.arch,
                locale: env.appLocale,
                isPackaged: env.isPackaged,
            };
        });

        registrar.handle(contract.system.openFilePicker, async (ctx, input) => {
            // 用 sender 关联调用方窗口，使对话框成为其模态。
            const caller = webContents.fromId(ctx.sender.webContentsId);
            const parent = caller ? BrowserWindow.fromWebContents(caller) : undefined;
            const options = {
                title: input.title,
                defaultPath: input.defaultPath,
                filters: input.filters,
                properties: [input.multiple ? 'multiSelections' : 'openFile'],
            } satisfies Electron.OpenDialogOptions;
            const result = parent
                ? await dialog.showOpenDialog(parent, options)
                : await dialog.showOpenDialog(options);
            return { canceled: result.canceled, filePaths: result.filePaths };
        });

        registrar.handle(contract.system.echo, (_ctx, input) => ({
            message: input.message,
        }));

        registrar.handle(contract.system.failWith, (_ctx, input) => {
            // 演示错误信封：RpcError 的 code/message/data 原样到达 renderer。
            throw new RpcError(input.code ?? 'DEMO_ERROR', 'intentional demo failure', {
                hint: 'errors travel inside the RpcResult envelope',
            });
        });

        registrar.handle(contract.system.quit, (ctx) => {
            // 经 ctx.app.quit() 请求退出（受限应用上下文的窄面，对齐 Tauri
            // AppHandle::exit 的角色）：quit 进入 before-quit -> 关停管线。
            // 响应信封大概率来不及送达，这是预期行为（应用正在退出）。
            ctx.app.quit();
            return undefined;
        });
    },
};
