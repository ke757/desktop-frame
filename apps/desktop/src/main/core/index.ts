/**
 * core 的公共面（barrel）：模块层与装配脚本只允许从这里 import core
 * （守护测试强制）。只显式导出模块作者确实需要的符号（模块协议、受限
 * 上下文、DI 词汇、公开能力接口与 token、部署受众接口、外部服务客户端），
 * 内核实现（ServiceContainer/Lifecycle/IpcRouter/DeploymentManagerImpl/
 * DesktopApp/builder）、内部 controller token 与 Electron SPI 一律不导出。
 */
export * from './api';
