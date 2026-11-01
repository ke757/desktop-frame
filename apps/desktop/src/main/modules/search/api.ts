import { serviceToken } from '../../core';
import type { SearchResponse } from '@desktop-frame/contracts';

/**
 * search 模块的跨模块公开面：服务接口与 token。适配层实现、代理客户端
 * 与注册工厂留在 search.service.ts（模块私有）；部署声明见
 * search.deployment.ts（经 AppModule.deployments 申报，非公开服务）。
 */

/**
 * 搜索服务的**公开接口**：内部消费方看到的一切。它代理外部的搜索领域
 * 服务（独立可执行程序，HTTP + WebSocket）——外部服务的细节（URL、就绪
 * 等待、重连）被封装在实现里，消费方只面对普通的服务方法。
 */
export interface SearchService {
    /** 调用外部搜索服务的 HTTP 端点。 */
    search(query: string): Promise<SearchResponse>;
    /** 订阅外部索引更新（非阻塞：就绪后建 WS 连接，推送转发为内部事件）。 */
    startListening(): void;
}

/** 搜索服务的服务 token（类型即公开接口）。 */
export const searchToken = serviceToken<SearchService>('modules.search');
