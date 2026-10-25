import { BrowserWindow, dialog, webContents } from 'electron';
import { RpcError, contract } from '@desktop-frame/contracts';
import type { AppModule } from '../../core/module';
import { hostToken } from '../../core/tokens';

/**
 * system 模块：演示如何消费 per-call 上下文——
 * `sender` 做窗口关联、`services` 取 host、RpcError 表达类型化业务失败。
 */
export const systemModule: AppModule = {
    id: 'system',

    registerRoutes(registrar) {
        registrar.handle(contract.system.getInfo, async (ctx) => {
            const host = await ctx.services.get(hostToken);
            return {
                appName: host.getName(),
                appVersion: host.getVersion(),
                electron: process.versions.electron ?? 'unknown',
                chrome: process.versions.chrome ?? 'unknown',
                node: process.versions.node ?? 'unknown',
                platform: process.platform,
                arch: process.arch,
                locale: host.getLocale(),
                isPackaged: host.isPackaged,
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

        registrar.handle(contract.system.quit, async (ctx) => {
            // 经 hostToken 请求退出（host 即应用的"控制句柄"，对齐 Tauri
            // AppHandle::exit 的角色）：触发 before-quit -> 关停管线。
            // 响应信封大概率来不及送达，这是预期行为（应用正在退出）。
            const host = await ctx.services.get(hostToken);
            host.quit();
            return undefined;
        });
    },
};
