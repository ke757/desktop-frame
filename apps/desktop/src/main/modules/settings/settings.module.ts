import { contract } from '@desktop-frame/contracts';
import type { AppModule } from '../../core';
import { settingsService, settingsToken } from './settings.service';

/**
 * settings 模块：一个暴露于类型化路由之上的 app 级服务
 * （类型化 JSON 存取），并用 init 钩子演示启动期工作。
 */
export const settingsModule: AppModule = {
    id: 'settings',
    services: [settingsService],

    registerRoutes(registrar) {
        registrar.handle(contract.settings.getAll, async (ctx) => {
            const settings = await ctx.services.get(settingsToken);
            return settings.get();
        });

        registrar.handle(contract.settings.update, async (ctx, patch) => {
            const settings = await ctx.services.get(settingsToken);
            return settings.update(patch);
        });
    },

    async init(ctx) {
        // 每次启动自增 launchCount，演示 init 钩子 + 持久化。
        const settings = await ctx.services.get(settingsToken);
        settings.update({ launchCount: settings.get().launchCount + 1 });
        ctx.logger.info('settings initialized', {
            launchCount: settings.get().launchCount,
        });
    },
};
