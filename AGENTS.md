# AGENTS.md — desktop-frame 仓库约定

面向在此仓库工作的 AI 助手与人类协作者。架构设计依据见 `docs/ARCHITECTURE.md`（必读）。

## 环境

- Node ≥ 24（`engines`），pnpm ≥ 11（corepack）。Electron 45 + electron-forge 8 + Vite 8 + TypeScript 5.9 + zod 4。
- `pnpm-workspace.yaml` 中 `nodeLinker: hoisted` 是 electron-forge 对 pnpm 的硬性要求，勿删。
- `.npmrc`（根 + apps/desktop）的 electron 镜像是本机网络需要；上游协作者可删。
- Windows 打包才需要 `electron-winstaller` 的构建脚本（`allowBuilds` 中已关闭）。

## 常用命令（仓库根）

- `pnpm dev`：并行起 web dev server（5173）与 `forge start`；主进程会等待 dev server 再开窗。
- `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm lint:fix`：全包执行，提交前应全绿。
- `pnpm --filter @desktop-frame/desktop package`：forge 打包（自动先构建 web，产物在 `apps/desktop/out/`）。
- 首次打包若 electron 缓存下载失败：加 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

## 代码结构规则

- `apps/desktop/src/app/core/**` 必须保持**零 electron import**（依赖一律走 `HostApp`/`IpcTransport`/`WindowHost`/`Logger` 接口），这是单测/集成测试可跑的前提。electron 只允许出现在：`src/main.ts`、`src/preload.ts`、`app/electron-host.ts`、`app/electron-transport.ts`、`app/logging.ts`、`app/windows/**`、业务模块里对 `dialog`/`BrowserWindow` 的直接使用。
- 启动分层（对齐 Tauri `Builder → build → run` / FastAPI lifespan 反转）：
  - `src/main.ts`：进程壳，只承载进程级策略（squirrel、单实例锁、全局异常、fatal 退出码）。
  - `app/index.ts`：装配脚本，只声明"应用由什么组成"（`.use()` 模块、`.window()` 窗口、注入 electron 适配）。
  - `core/builder.ts`：`desktopApp()` DSL + 框架接线（`build()` 内的核心对象互连是全仓库唯一接线点，只在框架演进时改动，业务变化不碰它）。
  - `core/desktop-app.ts`：`DesktopApp` 总对象，拥有从启动到退出的完整生命周期；`run()` 在 lifecycle 到 `exited` 后 resolve。注意所有权方向是 `app → container` 单向：**DesktopApp 本身不注册进容器**（组合根不是自己的服务节点），业务需要退出等应用级能力时走 `hostToken`。
- 入口只有两个：`src/main.ts`、`src/preload.ts`（forge 按文件名产出 main.cjs/preload.cjs，勿改名/移入子目录）。
- preload 处于沙箱（Electron 45 无 Buffer/events/timers shim），只能用 `electron` 模块与 Web 标准 API；桥保持通用（string channel），契约变化不改 preload。
- 跨进程通信一律走 `packages/contracts`：新增端点 = schema + procedure，channel 名必须唯一（有单测）。不要手写 ipcMain.handle/ipcRenderer.send 绕过路由。
- handler 永不 reject，业务错误用 `throw new RpcError(code, message, data)`。
- 服务定义用 `defineService(token, factory)`；factory 内需要依赖用 `accessor.get(token)`，避免并行 get 重叠子图（循环检测会误报）。
- **接口化 token（公开面与框架钩子分离）**：暴露给模块外部的服务必须 `interface XxxService`（token 的类型参数，只列外部可调方法）+ `class XxxServiceImpl implements XxxService, DisposableService`（生命周期方法如 load/flush 在实现上）。`dispose()` 刻意不进公开接口——它是框架钩子，只由容器调用。私有协作者直接 `new` 在 factory 内，不给 token。
- **模块目录即封装边界**：跨模块 import 只允许指向对方模块的 `*.service.ts` / `*.module.ts` / `*.tokens.ts`（拿接口与 token）；跨模块协作只走契约与 token 两条通道。
- 分层/边界由 `test/architecture.test.ts` 静态扫描固化（core 零 electron、core 只依赖 core、modules 不碰适配层、跨模块 import 白名单）；改 `src/app` 结构前先跑它，红了是破坏约定而不是测试问题。
- 有资源的服务的清理写在 `dispose()`，由容器逆序调用；进程级清理（如服务落盘之外的）注册为 `lifecycle.onShutdown(joiner)`，注意 joiner 顺序（窗口先、服务后）。

## 风格

- oxfmt：单引号、行宽 90、缩进为 4字符；oxlint correctness 警告需清零（`pnpm lint`）。
- 注释用中文；文档（docs/、README）用中文。
- 接口的属性、方法 and 模块的变量、函数在声明或定义时都要写注释说明主要功能。
- 命名：业务服务 = 接口 `XxxService` + 实现 `XxxServiceImpl`（token 类型一律是接口）；核心部件用角色名（Manager/Router/Publisher/Logger），不带 Service 后缀；token id 用 `core.*` / `modules.<mod>.*` 命名空间；IPC channel 用 `module.action`、事件 channel 用 `app.xxx`。
- 测试放各包 `test/` 目录，命名 `*.test.ts`；核心框架改动必须带测试。

## 边界
- git 分支的创建、提交等分支变更操作由用户负责。

## 约定的文件去向

- 新 schema/端点 → `packages/contracts/src/{schemas,contract}.ts`
- 新业务模块 → `apps/desktop/src/app/modules/<module>/<module>.{service,module}.ts`，并在 `app/index.ts` 装配脚本 `.use()` 一行接入
- 新窗口 → `app/windows/definitions.ts` 加 WindowDefinition，并在 `app/index.ts` `.window()` 一行接入
- 新核心服务/框架接线调整 → `core/builder.ts`（build() 内）+ `core/tokens.ts`；此类改动属于框架演进，必须伴随集成测试
- 全局清理逻辑 → `core/desktop-app.ts` 的 `wireHostEvents()` 生命周期接线处（shutdown joiner）
