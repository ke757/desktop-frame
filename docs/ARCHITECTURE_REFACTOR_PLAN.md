# 主进程依赖结构与能力边界重构

- 日期：2026-11-01
- 状态：已实施（同日完成，验收标准见 §9）；**部分决策已被后续变更取代**
- 范围：`apps/desktop/src/main.ts`、`apps/desktop/src/main/**`、相关测试与架构文档
- 不包含：renderer 契约协议重设计、窗口级子容器、自动注入、支持非 Electron 宿主

> **⚠️ 后续变更指引（2026-11-01）**：本文档 §2.3「不增加 `ctx.app`」、§5.2「部署控制面由容器工厂构造」以及「公开能力 token」相关决策已被 [`docs/CAPABILITY_KERNEL_REFACTOR_PLAN.md`](./CAPABILITY_KERNEL_REFACTOR_PLAN.md) 取代。当前约定以该文档与 `docs/ARCHITECTURE.md` §2.3 为准：内核能力（Logger/AppEnv/EventPublisher/Deployment）由 DesktopApp 直接持有，经受限 `AppHandle`（`ctx.app`）分发，不存在任何内核能力 token；deployments 管理 RPC 是框架内置路由（`core/deployment/admin-routes.ts`），不再是业务模块。本文档其余成果（api/kernel/spi 边界、容器并发与 dispose 正确性、启动失败回滚、模块 api.ts、Electron 默认装配、`AppModule.dispose`）仍然有效。

## 1. 背景

当前框架已经具备组合根、显式生命周期、应用级服务容器、类型化 IPC 和 Electron 适配层，不需要推倒重建。主要问题是：

1. `core/index.ts` 名义上是模块公共面，实际导出了容器、生命周期、路由、部署实现、DesktopApp 和 Builder，内部实现没有形成真实封装。
2. `hostToken`、`lifecycleToken`、`windowsToken` 让业务模块能够取得完整框架控制权，包括 `exit()`、`transition()`、`shutdown()`、`closeAll()`。
3. “框架构件”“共享服务”“宿主适配”“应用基础设施”与“是否参与 App 启动流程”被混为一条分类轴。
4. DeploymentManager 同时面向框架 supervisor、管理面板和客户端就绪查询三种受众，Search 只需要就绪查询却取得完整管理权限。
5. Builder 的生产装配暴露了过多适配器细节；纯声明登记和冲突校验位于 `run()`，可能在外部进程启动后才失败。
6. 容器存在并发解析和在途 dispose 正确性问题，启动失败没有经过统一资源清理。

本变更以“先保证行为正确，再收窄公共面，最后整理目录”为实施顺序。

## 2. 已确认的架构决策

### 2.1 保留 Electron 隔离，但不追求全应用六边形化

保留 core 零 Electron import。其价值是让内核、IPC、部署与关停流程可以脱离 Electron 测试，并让宿主事件集中管理，而不是为了支持其他桌面宿主。

只有真实由 Electron/Node/OS 适配器实现的接缝称为 SPI。AppModule、HandlerContext、DI 词汇、AppEnv、Logger、EventPublisher、DeploymentSpec 等不再笼统归入 ports。

业务模块可以明确是 Electron-aware，例如按约定使用 `dialog`/`BrowserWindow`；不为所有 Electron 能力增加接口。

### 2.2 只引入逻辑 kernel，不新增 Kernel 总控对象

逻辑内核由以下现有机制组成：

- DesktopApp；
- Lifecycle；
- ServiceContainer；
- 模块注册与激活；
- IpcRouter 及核心启动、关停编排。

可以在目录上使用 `core/kernel/`，但不增加 `AppKernel`/`Kernel` 运行时总控类，不增加 `kernelToken`，也不把内核注入模块。DesktopApp 仍是唯一的应用生命周期所有者。

### 2.3 不增加 `ctx.app`

不注入 `ctx.app: DesktopApp`，也不为了统一字段再增加一个宽泛的 AppHandle。

`ModuleInitContext` 和 `HandlerContext` 本身就是面向不同受众的受限上下文。通过收窄 token、接口和 DesktopApp 公开面控制权限，而不是改变字段嵌套。

### 2.4 保留薄 Builder

Builder 继续负责声明收集与对象图组合，进程壳继续只负责 Squirrel、单实例锁、全局异常和致命退出码。

增加 Electron 默认装配工厂，隐藏生产组合根中的 Host、Transport、ProcessHost、WindowManager 等适配器噪音。底层 Builder 继续允许测试注入 Fake。

### 2.5 container 是应用级服务对象图，不是 App 部件清单

对象是否进入 container、是否参与 App 启动流程、是否向业务公开，是三个独立决策。

推荐规则：

- 需要跨模块共享、替换实现，或由容器统一管理异步构造与回收的应用级对象，进入 container。
- 固定且业务不可替换的框架机制由 Builder/DesktopApp 直接构造注入。
- 模块私有协作者由所属服务工厂直接 `new`，不因为持有资源就自动增加公开 token。
- Module、Route、WindowDefinition、DeploymentSpec 是声明，不是服务。

服务默认 lazy。必须在 ready 前就绪的服务，由所属模块在 `init` 中显式解析；本次不增加通用 eager/start 生命周期框架。

## 3. 目标结构与依赖方向

推荐目标结构：

```text
apps/desktop/src/main/
  core/
    api/                 # 模块作者公共 API：模块协议、上下文、公开能力、token
    kernel/              # DesktopApp、Builder、Lifecycle、Container、模块激活
    spi/                 # HostRuntime、IpcTransport、ProcessHost、WindowController 等
    ipc/                 # Router、EventPublisher 实现
    deployment/          # 部署控制面实现与 ExternalServiceClient
    index.ts             # 只显式导出模块作者 API，不导出内部实现
  electron/              # Electron/Node 适配器与默认装配工厂
  modules/
    settings/
      api.ts             # 跨模块公开：接口 + token
      settings.module.ts # 只允许组合根导入
      settings.service.ts# 实现与注册工厂，模块私有
    search/
      api.ts
      ...
  index.ts               # 应用组合根
  windows.ts             # 应用窗口声明
```

依赖规则：

1. core 不 import Electron，不 import 具体业务模块。
2. `core/api` 不依赖 kernel 或 Electron 实现。
3. `core/spi` 只包含宿主适配接缝及其必要数据类型。
4. electron 适配器只依赖 core 的 api/spi，不依赖具体业务模块。
5. 业务模块只经 `core/index.ts` 使用框架公共 API，不深层导入 kernel、ipc 或 deployment 实现。
6. 跨业务模块 import 只允许指向对方 `api.ts`；`*.module.ts` 只允许组合根导入，实现文件不跨模块公开。
7. 组合根是唯一可以同时接触具体模块、Electron 默认装配和窗口声明的位置。

目录调整应与架构守护测试同步完成，不能只移动文件而保留旧的公开面。

## 4. 公共 API 与能力暴露

### 4.1 core 公共面

`core/index.ts` 改为显式导出模块作者确实需要的符号，不再 `export *` 内部实现。至少遵循：

- 允许：AppModule、ModuleInitContext、HandlerContext、RouteRegistrar、ServiceToken、ServiceAccessor、ServiceRegistration、DisposableService、`serviceToken`、`defineService`、公开能力接口与公开 token、DeploymentSpec、ExternalServiceClient 等模块 authoring API。
- 不允许：ServiceContainer、Lifecycle 实现、IpcRouter、DeploymentManagerImpl、DesktopApp、DesktopAppBuilder、内部 controller token、Electron 适配器。

`DesktopApp` 对进程壳只保留运行所需的最小面，例如 `run()`、`quit()`、`logger`，以及测试/等待所需的只读生命周期视图。不再公开 `host/container/router/windows/events/deployments` 等内部对象。集成测试优先通过 Fake 和 IPC 行为验证，不为测试重新开放完整控制面。

### 4.2 Host

完整宿主接口仅作为内部 SPI，包含 `whenReady`、宿主事件和 `exit` 等框架专用能力，不再作为业务 token 公开。

业务需要的能力拆为：

- 应用信息：通过公开只读环境/信息数据提供，包括名称、版本、locale、是否打包等现有真实消费项。
- 应用控制：窄 `AppControl`，只提供会进入优雅关停的 `quit()`，不提供 `exit()`、宿主事件订阅或单实例锁。

移除公开 `hostToken`，更新 system 模块。

### 4.3 Lifecycle

完整 Lifecycle 仅由内核持有，不再通过公开 token 提供 `transition()`、`shutdown()` 或内部 joiner 管线。

如确有业务消费需求，只提供 `LifecycleView`：`state`、`when()`、`onChange()`。当前没有生产消费方的 `lifecycleToken` 应移除，而不是保留备用能力。

模块持有的资源优先由服务 `dispose()` 回收。若模块 `init` 可直接持有非服务资源，则为 AppModule 增加对称的可选 `dispose(ctx)`，关停时按模块逆序、在 container dispose 前调用；不要因此重新公开 Lifecycle。

### 4.4 Window

完整 WindowHost/WindowController 仅供内核和 Electron 适配器使用。当前没有生产消费方的公开 `windowsToken` 应移除。

未来业务确有窗口操作需求时，再定义只含所需方法的 WindowService，不公开 `register`、`closeAll` 和主窗口重开策略。

### 4.5 模块公开面

Settings、Search 等模块的接口和 token 移到各自 `api.ts`。实现类、加载/刷新方法、注册工厂留在模块私有文件。

跨模块消费者只能拿到接口与 token，不能导入实现类或直接调用其生命周期方法。架构测试应从“允许某些文件名”调整为“只允许对方 api.ts”。

## 5. Deployment 重构

### 5.1 三种受众分离

同一个部署控制面对象可以承载以下三个逻辑接口，但它们必须按受众分离：

- `DeploymentController`：框架内部，`register/startAll/stopAll` 或等价的声明接管与批量编排能力。
- `DeploymentReadiness`：外部服务客户端使用，`getStatus/whenReady/onChange` 等查询与就绪能力。
- `DeploymentAdmin`：deployments 管理模块使用，`list/start/stop/restart`。

Search 与 `createExternalServiceClient` 只能依赖 DeploymentReadiness，不再取得完整管理权限。deployments 模块使用 DeploymentAdmin。DesktopApp 只依赖内部 DeploymentController，不依赖具体 DeploymentManagerImpl。

公开 token 只暴露对应窄接口；内部 controller token 不从 core 公共面导出。

### 5.2 构造与生命周期

将 Builder 中直接 `new DeploymentManagerImpl(...)` 改为容器工厂构造，使其未来可以经 accessor 解析其他服务依赖。DesktopApp 在启动阶段解析内部 controller 并显式启动部署。

公开 readiness/admin token 与内部 controller 必须指向同一个控制面对象，不能形成两套状态或两套对象图。

Database 等普通基础设施不要求 DesktopApp 知情；若 DeploymentManager 的工厂依赖它，容器解析时自然先构造依赖，这就是其进入启动流程的方式。

### 5.3 启动失败策略

部署是否为应用启动的硬依赖必须显式表达。可增加 `DeploymentSpec.required`（缺省 false，保持当前可选 sidecar 行为）：

- 可选部署失败：记录并暴露状态，不阻止其他模块启动。
- required 部署失败：`startAll`  reject，应用启动进入统一回滚。

`startAll` 不应无条件吞掉所有异常而使框架无法区分硬依赖失败。

## 6. Builder 与 Electron 默认装配

增加类似 `createElectronDesktopApp()` 的生产入口，使 `main/index.ts` 只需声明：

```ts
return createElectronDesktopApp({
    mainDir: __dirname,
    deploymentProfile: devDeploymentProfile,
})
    .use(systemModule, settingsModule, deploymentsModule, searchModule)
    .window(createMainWindowDefinition())
    .build();
```

默认工厂负责 Electron Host、IPC transport、ProcessHost、WindowManager 和默认 logger。底层 `desktopApp(...)` Builder 可继续接收 Fake runtime，但不再从业务公共 barrel 导出。

阶段语义调整为：

### build

- 构造核心对象图。
- 登记服务工厂、路由、窗口与部署声明。
- 校验模块 id、service token、IPC channel、window id、deployment id 等重复声明。
- 不打开数据库、不启动 sidecar、不安装 IPC transport、不创建实际窗口、不执行模块 init。

### run

1. 接线宿主事件并等待 `host.whenReady()`。
2. 解析并启动部署及必要基础设施。
3. 执行模块 init，显式解析必须 eager 的服务。
4. 安装 IPC transport。
5. lifecycle 进入 ready。
6. 等待 dev server（如适用）并打开主窗口。
7. 挂起直到 exited。

路由等纯声明冲突必须在任何启动副作用之前暴露。

## 7. 容器正确性要求

这部分优先于目录调整，必须带回归测试。

### 7.1 并发解析

当前全容器共享 `resolutionChain`，会把其他并发调用正在创建的 token 误判为循环依赖，并可能因异步 `push/pop` 交错破坏解析栈。

目标：

- 循环检测祖先链属于单次解析上下文，不能由整个容器共享。
- 工厂接收携带该上下文的 accessor；可使用不可变祖先链。
- 顶层并发消费者首次获取同一个冷服务时共享同一个 memoized Promise，不产生 `CyclicDependencyError`。
- 真正的 A → B → A 仍必须快速报错，不能退化为等待自身 Promise 而挂起。
- 独立子图并发、重叠子图并发、乱序完成均不得误报或破坏后续检测。

至少覆盖：同 token 冷启动并发、独立服务并发、重叠依赖并发、真实循环、失败重试。

### 7.2 在途创建与 dispose

容器必须有唯一、幂等的 dispose Promise，并统一处理 pending 创建：

- dispose 开始后拒绝新的 register/get，不允许再扩张对象图。
- 已在创建中的工厂完成时，晚完成实例必须立即 dispose，或不得作为可用实例交付。
- 所有已成功交付且仍存活的应用级实例按依赖安全的逆序清理。
- 不得出现 dispose 已返回、工厂随后成功但实例未清理的窗口。
- 单项 dispose 失败只记录，不阻断其他清理。

至少覆盖：慢工厂与 dispose 竞态、多个 pending、创建失败、重复 dispose、dispose 后 get/register。

### 7.3 启动失败回滚

`DesktopApp.run()` 必须拥有启动失败清理，不得由进程壳在清理前直接 `process.exit()`：

- 复用正常关停的幂等、best-effort 资源清理逻辑。
- 清理已初始化模块、已实例化服务、已启动部署和已创建窗口。
- 启动失败不得以正常退出的 `host.exit(0)` 收尾；清理完成后 reject，由进程壳决定非零退出。
- build 阶段同步异常也进入明确的 bootstrap fatal 路径。

正常关停顺序保持：停止接受新调用 → 窗口 → 模块逆序 dispose（如实现）→ container dispose → deployments stopAll → exited/host exit。

## 8. 测试与文档要求

### 必补/更新测试

1. `container.test.ts`：本文件第 7 节全部关键并发与回收场景。
2. `desktop-app.integration.test.ts`：build 纯声明校验、run 启动时序、正常退出、模块 init 失败回滚、路由冲突在部署启动前失败、required 部署失败回滚。
3. `router.test.ts`：保持 IPC 门禁、校验与错误信封行为。
4. `deployment-manager.test.ts` / `external-client.test.ts`：readiness 与 admin 受众分离、required 策略、同一控制面状态。
5. `architecture.test.ts`：新 api/kernel/spi 边界、core 零 Electron、electron 只依赖 api/spi、模块只走公共 barrel、跨模块只允许 api.ts。
6. 现有 settings/search/system/deployments 测试随公开 API 调整，不通过重新导出内部实现来规避边界。

### 文档

实施完成后同步更新：

- `docs/ARCHITECTURE.md`：目标结构、依赖规则、公开面、build/run、关停与 Deployment 新语义，移除过时描述。
- `AGENTS.md`：文件去向、模块 api.ts、公共 token、跨模块 import、Builder/Electron 默认装配规则。
- 本变更文档：若实施有明确偏离，记录偏离及原因，不得静默改变已确认决策。

## 9. 验收标准

1. 不新增 Kernel 总控对象，不注入 `ctx.app`。
2. 业务模块无法经公共 API 取得 HostRuntime、完整 Lifecycle、完整 WindowController、DeploymentController 或具体实现类。
3. `core/index.ts` 不再泄露内部实现；跨模块只允许 `api.ts`。
4. Deployment readiness/admin/controller 按受众分离且共享同一实例状态。
5. Database 类基础设施可以作为普通容器服务存在，不需要修改 DesktopApp。
6. 生产组合根不再手动装配全部 Electron 适配器。
7. build 在任何启动副作用前完成纯声明登记与重复校验。
8. 容器并发、真实循环、pending dispose 与启动失败回滚测试全部通过。
9. 正常启动、IPC、优雅退出、外部服务部署的现有行为保持；新增的破坏性变化仅限已确认的公开 API 收窄。
10. 仓库根执行并全部通过：

```bash
pnpm test
pnpm typecheck
pnpm lint
```

不创建 git 分支、不提交、不推送。

## 10. 实施记录与偏离说明

实施按本规格完成，未改变任何已确认决策。以下为实施中的明确偏离与补充决定（均有测试守护）：

1. **`electron/app-factory.ts` 对 `core/kernel/builder` 的豁免**：默认装配工厂是生产组合根入口而非适配器，需要调用 `desktopApp()` DSL。"electron 只依赖 api/spi" 规则对 `electron/app-factory.ts` 单点豁免（`test/architecture.test.ts` 固化），其余 electron 文件仍严格只依赖 api/spi。
2. **`core/api` 允许依赖 `core/spi`**：§3 规则 2 只禁止 api 依赖 kernel 或 Electron 实现；`HandlerContext.sender: IpcCallInfo` 与 `EventSink` 这类接缝数据类型住在 spi，api → spi 是允许方向（architecture 测试按此固化）。
3. **部署 spec 的登记时机**：§5.2 决定控制面由容器工厂构造，模块申报的 spec 因此在工厂内（run 阶段构造控制面时）注册并做字段合法性校验；build 阶段先做部署 id 重复的纯声明校验（§6 要求的"重复校验先于副作用"由 build 期的 set 检查保证），工厂内注册仍先于 `startAll()` 的任何进程副作用。
4. **admin 受众的 `start` 失败语义**：托管启动序列结束仍未就绪（spawn 失败/就绪超时/health:false 秒退）时，`DeploymentAdmin.start` 与内部 `startAll` 一致抛 `DeploymentStartFailedError`（快照状态照常更新为 failed），而不是返回失败快照——这是 §5.3"不无条件吞掉异常"在管理端点的延伸，使调用方能区分成功与失败。
5. **容器的占位时序**：§7.1 的实现补充——创建 promise 在工厂启动**之前**同步占位（deferred），否则工厂的同步重入解析（A 的工厂同步请求 B、B 又同步请求 A）会在 memo 条目存在前无限递归，祖先链检测没有机会触发；占位后真实循环快速报错、并发冷启动共享同一 promise。回归测试见 `container.test.ts`。
6. **`AppModule.dispose(ctx)` 已实现**（§4.3 允许项）：关停 joiner 顺序为窗口 → 模块逆序 dispose → container dispose → deployments stopAll → exited，模块 dispose 单项失败记日志不阻断。
7. **旧 `core/ports/**`、core 根实现文件与 `deployment/client.ts` 删除**：前者由 api/spi 取代，后者与 `api/external-client.ts` 重复（保留公开面版本）。

## 11. 审查修正记录（同日第二轮）

主会话审查发现三处未满足项，已修复并补回归测试：

1. **`run()` 的关停管线注册时序**：joiner 注册（`registerShutdownPipeline`）提前到任何可失败的容器解析之前——控制面工厂经 accessor 实例化的依赖（如 processHost）在工厂失败时也能被 `container.dispose` 回收；宿主事件接线与部署状态订阅（`wireHostEvents`）保持在控制面解析之后，避免提前 wire 丢失部署订阅。回归测试：无效 `DeploymentSpec`（build 只查重复 id，字段校验在工厂内抛 `InvalidDeploymentError`）令工厂在解析 processHost 之后失败，断言该依赖被 dispose、run reject、`host.exit` 未调用（`desktop-app.integration.test.ts`，复用注入的 processHost 作为可观察 seam，未重新公开内部对象）。
2. **`ModuleDisposeContext` 与 init 对称**：改为与 `ModuleInitContext` 同形（services/logger/events/env），`DesktopApp.disposeModules` 传入相同能力；joiner 顺序保证 dispose 内解析服务时容器尚未释放、服务尚未 dispose。回归测试：模块 dispose 内解析到的服务与 init 实例同一，且服务 dispose 发生在其后。
3. **进程壳 build 失败路径**：`src/main.ts` 的 `bootstrap()` 先 `buildDesktopApp()`（同步声明冲突用 console 兜底日志 + `process.exit(1)`），成功后才用产物 logger 安装全局异常兜底并 `run()`——build 与 run 失败都有明确日志与非零退出策略，build 后 logger 供全局异常处理使用的行为不变（进程壳为 Electron 入口，不单测）。
4. **文档一致性**：AGENTS.md / ARCHITECTURE.md 的模块 Electron 直用清单补上 `webContents`（system 模块窗口关联已在用），与 Electron-aware 模块约定对齐，不新增端口。
