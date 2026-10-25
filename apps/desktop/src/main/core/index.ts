/**
 * core 的公共面（barrel）：模块层与装配脚本只允许从这里 import core
 * （守护测试强制）；core 内部实现文件（builder/desktop-app/container 等）
 * 不对业务开放。
 */
export * from './ports/host';
export * from './ports/window-host';
export * from './ports/event-sink';
export * from './ports/event-publisher';
export * from './ports/ipc-transport';
export * from './ports/route-registrar';
export * from './ports/logger';
export * from './ports/env';
export * from './ports/di';
export * from './ports/module';
export * from './ports/process-host';
export * from './ports/deployment';
export * from './container';
export * from './lifecycle';
export * from './env';
export * from './logging';
export * from './ipc/router';
export * from './ipc/events';
export * from './deployment/manager';
export * from './deployment/client';
export * from './tokens';
export * from './desktop-app';
export * from './builder';
