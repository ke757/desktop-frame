import { contract } from '@desktop-frame/contracts';
import type { AppModule } from '../../core';
import { searchDeployment } from './search.deployment';
import { searchService, searchToken } from './search.service';

/**
 * search 模块：接入一个外部领域服务的完整范例——
 * 声明部署（deployments）+ 适配层服务（services）+ 代理路由（routes）。
 * 其他外部服务接入时照此三件套复制即可。
 */
export const searchModule: AppModule = {
    id: 'search',
    deployments: [searchDeployment],
    services: [searchService],

    registerRoutes(registrar) {
        registrar.handle(contract.search.query, async (ctx, input) => {
            const search = await ctx.services.get(searchToken);
            return search.search(input.query);
        });
    },

    async init(ctx) {
        // 只做订阅 kickoff（非阻塞）：dev 的 external 模式下外部服务可能
        // 尚未启动，实现内部会在就绪后自动连接，不阻塞应用启动。
        const search = await ctx.services.get(searchToken);
        search.startListening();
        ctx.logger.info('search adapter initialized');
    },
};
