# AGENTS.md — desktop-frame 仓库约定

面向在此仓库工作的 AI 助手与人类协作者。架构设计依据见 `docs/ARCHITECTURE.md`（必读）；本轮能力边界调整的规格与实施记录见 `docs/CAPABILITY_KERNEL_REFACTOR_PLAN.md`。

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
- dev 下外部服务是 external 模式（等手动启动）：`node apps/desktop/test/fixtures/echo-service.mjs`（演示 fixture，默认 7801 端口）。

## 代码结构规则

- 主进程代码在 `src/main/`，core 内部按受众分目录（完整结构与依赖规则见 ARCHITECTURE.md §2.2）：
  - `main/core/api/**`：**模块作者公共 API**——模块协议（AppModule/ModuleInitContext/ModuleDisposeContext，`ctx.app + ctx.services`）、HandlerContext（`ctx.app + ctx.services + log + sender`）、DI 词汇（token/ServiceFactoryContext/ServiceAccessor）、**AppHandle（DesktopApp 签发的受限能力句柄）**、Logger/AppEnv/EventPublisher/RouteRegistrar、LifecycleView（只读）、部署数据契约与就绪受众（DeploymentReadiness）、`createExternalServiceClient`；不依赖 kernel/ipc/deployment 实现侧。**本目录没有 token 定义**——内核能力不是容器服务。
  - `main/core/spi/**`：**宿主适配接缝（SPI）**——只有真实由 Electron/Node/OS 适配器实现的接缝（HostRuntime、IpcTransport、ProcessHost、WindowController/WindowDefinition/EventSink）；框架专用能力（宿主事件订阅、`exit()`、`closeAll`）只在此层，不对业务公开。
  - `main/core/kernel/**`：**内核实现**——builder（desktopApp() DSL）、container、desktop-app、lifecycle、logging、env；零 electron import。
  - `main/core/ipc/**`、`main/core/deployment/**`：路由/事件/部署控制面实现。deployment 目录持有 DeploymentManagerImpl、内部 Controller/Admin 类型与 **deployments 管理 RPC 的内置路由接线（admin-routes.ts）**；core 整体零 electron import，相对 import 不逃出 core。
  - `main/core/index.ts`：core 唯一公共 barrel，**只显式导出模块作者 API**（从 api/ 再导出），不导出 ServiceContainer/Lifecycle/IpcRouter/DeploymentManagerImpl/DesktopApp/builder/DeploymentAdmin/SPI。
  - `main/electron/**`：**适配层**——每个文件对应一个 SPI 的实现（host/ipc-transport/logging/windows-manager/process-host）+ 默认装配工厂 `app-factory.ts`；对 core 的 import 只允许 `core/api/**`、`core/spi/**`（唯一豁免：`app-factory.ts` 可 import `core/kernel/builder`）；OS 级适配（node:child_process）也住这里。
  - `main/index.ts`：装配脚本（组合根）；`main/windows.ts`：窗口定义（应用声明）。
  - 业务模块是 Electron-aware 的：只允许按约定直接使用窗口关联类 electron API（`dialog`/`BrowserWindow`/`webContents`），且对 core 的 import 只走 barrel `'../../core'`。
- 能力边界（能力内核 + 业务容器 + 受限句柄，详见 ARCHITECTURE.md §2.3）：**DesktopApp 直接持有 Logger、AppEnv、EventPublisher、DeploymentController、WindowController 等内核能力，不注册进业务 Container；Container 只管理业务与应用服务；内核能力统一经受限 `AppHandle`（`ctx.app`，DesktopApp 签发的冻结委托 facade）分发给模块 init/dispose、服务工厂与 IPC handler**。不新增 Kernel 总控类，不引入第三方 DI。DesktopApp 是唯一的应用生命周期所有者。
- 启动分层（对齐 Tauri `Builder → build → run` / FastAPI lifespan 反转）：
  - `src/main.ts`：进程壳，只承载进程级策略（squirrel、单实例锁、全局异常、fatal 退出码）。
  - `main/index.ts`：装配脚本，只声明"应用由什么组成"（`createElectronDesktopApp({ mainDir, deploymentProfile })` + `.use()` 模块 + `.window()` 窗口）；它是唯一同时接触具体模块、Electron 默认装配与窗口声明的位置。
  - `core/kernel/builder.ts`：`desktopApp()` DSL + **组合根**——收集声明、做声明级冲突校验（模块 id、部署 id 重复、部署 spec 字段合法性）、调 providers 构造**叶子能力**（logger/env/lifecycle/windows/events/deployment 控制面）后移交 DesktopApp。它刻意不签发 AppHandle、不构造 Container/Router、不登记服务/路由/窗口——依赖句柄的部件由句柄签发者（DesktopApp）接线。build 不装 transport、不开窗、不执行模块 init，冲突先于任何启动副作用同步抛错。
  - `core/kernel/desktop-app.ts`：`DesktopApp` 总对象，拥有从启动到退出的完整生命周期，也是**唯一的 AppHandle 签发点**——构造函数内 `createHandle()`（冻结委托 facade：env 只读快照、logger/events 转发、lifecycle/deployments 运行时窄面、quit 走受控入口 `requestQuit()`）→ 构造 Container/Router → 登记服务/路由/窗口/内置管理路由。`run()` 在 lifecycle 到 `exited` 后 resolve，启动失败先走统一回滚（复用关停管线）再 reject，绝不以 `host.exit(0)` 收尾。对进程壳只暴露 `run()`/`quit()`/`logger`/只读 `lifecycle` 视图。所有权方向是 `app → container` 单向：**DesktopApp 本身不注册进容器**。
  - `run()` 时序：接线宿主事件 → 启动部署（required 失败整体 reject）→ 模块 init → 安装 IPC transport → ready → 等 dev server（如适用）→ 开主窗口 → 挂起。
- 入口只有两个：`src/main.ts`、`src/preload.ts`（forge 按文件名产出 main.cjs/preload.cjs，勿改名/移入子目录）。
- preload 处于沙箱（Electron 45 无 Buffer/events/timers shim），只能用 `electron` 模块与 Web 标准 API；桥保持通用（string channel），契约变化不改 preload。
- 跨进程通信一律走 `packages/contracts`：新增端点 = schema + procedure，channel 名必须唯一（有单测）。不要手写 ipcMain.handle/ipcRenderer.send 绕过路由。
- handler 永不 reject，业务错误用 `throw new RpcError(code, message, data)`。
- **两条依赖通道（所有业务接触点一致）**：`ctx.app` 回答"我正在与哪个应用宿主协作"（env/logger/events/lifecycle/deployments/quit），`ctx.services` 回答"我需要哪个业务服务对象"。服务定义用 `defineService(token, factory)`，factory 签名是 `(ctx: ServiceFactoryContext)`；业务依赖用 `ctx.services.get(token)`，内核能力直接读 `ctx.app.*`。容器并发解析安全（冷启动并发共享创建、真实循环快速报错），但串行声明依赖更易读。
- **接口化 token（公开面与框架钩子分离）**：暴露给模块外部的服务必须 `interface XxxService`（token 的类型参数，只列外部可调方法）+ `class XxxServiceImpl implements XxxService, DisposableService`（生命周期方法如 load/flush 在实现上）。`dispose()` 刻意不进公开接口——它是框架钩子，只由容器调用。私有协作者直接 `new` 在 factory 内，不给 token。
- **模块目录即封装边界**：跨模块 import 只允许指向对方模块的 **`api.ts`**（接口与 token）；`*.module.ts` 只允许组合根导入，实现文件不跨模块公开。跨模块协作只走契约与 token 两条通道。
- **token 只属于业务与应用服务**：不存在任何内核能力 token（env/logger/events/appControl/deployment 等均无）；`hostToken`/`lifecycleToken`/`windowsToken`/完整部署控制面同样不存在——宿主事件、`exit()`、`transition()`、`shutdown()`、`closeAll()` 是内核/SPI 专用。
- **deployments 管理 RPC 是框架内置路由**（`core/deployment/admin-routes.ts`，DesktopApp 构造期接线、消费内部 DeploymentAdmin）：`deployments.list/start/stop/restart` 的 channel、输入输出与错误翻译保持稳定；不要为它建业务模块，也不要把 Admin/Controller 暴露进 AppHandle 或任何 token。
- **外部服务接入（控制平面/数据平面，详见 ARCHITECTURE.md §8）**：
  - 部署声明是模块变量（`DeploymentSpec`），经 `AppModule.deployments` 申报；builder 在 build 期登记并校验（字段非法/重复 id 在 build 抛错），框架在模块 init 前 `startAll()`（managed 等待健康就绪，external 只挂探测）。`required: true` 表示应用启动的硬依赖（启动失败触发统一回滚），缺省 false（可选 sidecar 可缺席）。
  - dev 覆盖走 `createElectronDesktopApp({ deploymentProfile })`，仅 `env.isDev` 生效（典型：切 external 等手动启动）；打包产物恒用原始 spec。
  - 内部服务依赖外部领域服务时写**适配层服务**（范例 `modules/search`）：`createExternalServiceClient`（只依赖 DeploymentReadiness 受众，经 `ctx.app.deployments` 取得；等就绪 + HTTP/WS），HTTP 失败翻译 RpcError、WS 推送桥接内部事件；不要在业务代码里直连外部 URL。
  - 业务不要直接 spawn 进程——一律经 `ProcessHost` SPI/部署控制面。
- 分层/边界由 `test/architecture.test.ts` 静态扫描固化（core 零 electron、core 不逃逸、api 不依赖实现侧、electron 只 import api/spi、modules 只走 barrel、跨模块只认 api.ts、`*.module.ts` 只允许组合根导入、**无内核能力 token 残留、api 公共面无 token 注册、DeploymentAdmin 不经 api 导出**）；改 `src/main` 结构前先跑它，红了是破坏约定而不是测试问题。
- 有资源的服务的清理写在 `dispose()`，由容器逆序调用；模块 init 直接持有的非服务资源写 `AppModule.dispose(ctx)`（关停时按模块逆序、在 container dispose 前调用，此刻 ctx.services 仍可解析未释放服务）；进程级清理（如服务落盘之外的）注册为 `lifecycle.onShutdown(joiner)`（内核内部接线），注意 joiner 顺序（窗口先、模块与服务后、外部进程最后——部署 stopAll 由 DesktopApp 直接调用，不经容器）。

## 风格

- oxfmt：单引号、行宽 90、缩进为 4字符；oxlint correctness 警告需清零（`pnpm lint`）。
- 注释用中文；文档（docs/、README）用中文。
- 接口的属性、方法 and 模块的变量、函数在声明或定义时都要写注释说明主要功能。
- 命名：业务服务 = 接口 `XxxService` + 实现 `XxxServiceImpl`（token 类型一律是接口）；核心部件用角色名（Manager/Router/Publisher/Logger），不带 Service 后缀；业务 token id 用 `modules.<mod>.*` 命名空间（`core.*` 不再用于 token）；IPC channel 用 `module.action`、事件 channel 用 `app.xxx`。
- 测试放各包 `test/` 目录，命名 `*.test.ts`；核心框架改动必须带测试。

## 边界
- git 分支的创建、提交等分支变更操作由用户负责。

## 约定的文件去向

- 新 schema/端点 → `packages/contracts/src/{schemas,contract}.ts`
- 新业务模块 → `apps/desktop/src/main/modules/<module>/`：`api.ts`（公开接口 + token）+ `<module>.service.ts`（实现与注册工厂）+ `<module>.module.ts`（申报单元），并在 `main/index.ts` 装配脚本 `.use()` 一行接入
- 新窗口 → `main/windows.ts` 加 WindowDefinition，并在 `main/index.ts` `.window()` 一行接入
- 新宿主适配接缝（core 需要新的外部能力接缝时）→ `main/core/spi/<name>.ts` + 对应适配器 `main/electron/<name>.ts`；SPI 必须先于适配器存在（依赖倒置）
- 新模块作者公共 API（业务需要新的框架公开能力时）→ `main/core/api/<name>.ts` + `main/core/api/index.ts` 再导出；只加窄接口（类型/函数），**不新增 token、不往 Container 注册内核能力**——面向模块外的能力经 AppHandle 分发
- 新核心服务/框架接线调整 → 叶子能力构造在 `core/kernel/builder.ts`（build() 内），AppHandle/Container/Router 接线与声明登记在 `core/kernel/desktop-app.ts`（构造函数内）；此类改动属于框架演进，必须伴随集成测试
- 新的部署管理/查询端点 → 扩展 `core/deployment/admin-routes.ts`（内置路由接线）与对应受众接口（`core/deployment/controller.ts` / `core/api/deployment.ts`）；不建业务模块
- 全局清理逻辑 → `core/kernel/desktop-app.ts` 的 `registerShutdownPipeline()`（shutdown joiner 顺序：窗口 → 模块逆序 dispose → 容器 dispose → 部署 stopAll）
- 新外部领域服务 → `modules/<module>/<module>.deployment.ts`（DeploymentSpec 模块变量）+ `<module>.service.ts` 里用 `createExternalServiceClient`（manager 取 `ctx.app.deployments`）写适配层实现；dev 覆盖在 `main/index.ts` 的 `deploymentProfile` 里加一条
