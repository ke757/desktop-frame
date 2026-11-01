# 能力内核与业务服务容器边界调整

- 日期：2026-11-01
- 状态：已实施（同日完成，实施记录与偏离见 §11；后续「AppHandle 签发与组装切分」见 §12）
- 前置变更：`docs/ARCHITECTURE_REFACTOR_PLAN.md`
- 范围：DesktopApp、Container、模块/服务工厂/Handler 接触点、Deployment 管理路由、相关测试与文档

## 1. 背景与本次决策

上一轮重构建立了 api/kernel/spi 边界，并修复了容器与启动回滚问题，但 Logger、AppEnv、EventPublisher、Deployment 同时存在以下访问方式：

1. 由 DesktopApp/Builder 持有；
2. 注册进 ServiceContainer；
3. 通过 framework token 暴露；
4. 部分能力又直接出现在 ModuleInitContext/HandlerContext。

这使“谁是能力所有者”和“业务应当走哪条依赖通道”不够清晰。

本次统一为：

> **能力内核（DesktopApp）+ 业务服务容器（Container）+ 受限应用上下文（ctx.app）。**

- DesktopApp 拥有并管理 Logger、AppEnv、EventPublisher、Deployment 等内核能力。
- Container 只管理业务与应用服务，不再登记这些内核能力。
- token 面向业务与应用服务，不再为 Logger、Env、Event、AppControl、Deployment 等内核能力保留 token。
- ModuleInitContext、ModuleDisposeContext、HandlerContext、ServiceFactoryContext 等接触点统一通过 `ctx.app` 获取受限内核能力，通过 `ctx.services` 获取业务服务。
- `ctx.app` 的类型是专门定义的 AppHandle facade，不是 DesktopApp 本体，不暴露组合根与内核控制面。

本变更取代前置文档中关于“内核能力 token 化”“DeploymentManager 经业务 Container 工厂构造”“不引入 ctx.app”的决策；前置文档中已完成的容器并发、dispose、启动回滚、模块 api.ts 和 Electron 默认装配成果必须保留。

## 2. 两条依赖通道

所有业务接触点遵循同一模型：

```text
ctx.app
  内核能力：env / logger / events / lifecycle / deployments / quit

ctx.services
  业务服务：settings / search / database / repository ...
```

语义：

- `ctx.app` 回答“我正在与哪个应用宿主协作”。
- `ctx.services` 回答“我需要哪个业务服务对象”。

禁止再出现同一内核能力同时通过 DesktopApp、context 字段和 token 三条路径公开的情况。

## 3. AppHandle 公共面

在 `core/api` 中定义稳定的 AppHandle facade，至少包含：

```ts
interface AppHandle {
    /** 只读应用环境。 */
    readonly env: AppEnv;
    /** 应用根日志能力。 */
    readonly logger: Logger;
    /** 向 renderer 发布事件。 */
    readonly events: EventPublisher;
    /** 只读生命周期视图。 */
    readonly lifecycle: LifecycleView;
    /** 部署状态与就绪查询，不含管理和批量编排。 */
    readonly deployments: DeploymentReadiness;
    /** 请求进入优雅关停，不提供 host.exit。 */
    quit(): void;
}
```

AppHandle 不得暴露：

- ServiceContainer；
- IpcRouter；
- HostRuntime；
- WindowController；
- 完整 Lifecycle；
- DeploymentController 或 DeploymentAdmin；
- DesktopApp 的 build/run/rollback 等内部能力；
- 任何可以直接修改内核对象图的入口。

`quit()` 仍走 Electron before-quit 与统一优雅关停，不能退化为 `host.exit()`。

AppHandle 可以由 Builder 组装并共享给 DesktopApp、IpcRouter、ServiceContainer 与模块接触点，但它必须只是受限 facade；上述对象对内核能力的内部直接引用不视为另一套公开面。

## 4. 所有接触点统一调整

### 4.1 服务工厂必须纳入本次调整

删除内核能力 token 后，ServiceFactory 是当前最容易断裂的接触点。工厂签名调整为接收同时包含 app 与 services 的受限上下文：

```ts
interface ServiceFactoryContext {
    /** 内核能力的受限公开面。 */
    readonly app: AppHandle;
    /** 当前解析上下文中的业务服务访问器。 */
    readonly services: ServiceAccessor;
}

type ServiceFactory<T> = (
    ctx: ServiceFactoryContext,
) => T | Promise<T>;
```

ServiceContainer 在解析业务服务时：

- `app` 使用 Builder/DesktopApp 提供的同一个 AppHandle；
- `services` 必须仍是携带当前不可变祖先链的 scoped accessor；
- 不得为了传 AppHandle 退回全容器共享 resolution chain，也不能破坏同 token 并发 memoize、真实循环检测和 dispose 语义。

### 4.2 模块上下文

ModuleInitContext 与 ModuleDisposeContext 统一为：

```ts
interface ModuleInitContext {
    readonly app: AppHandle;
    readonly services: ServiceAccessor;
}

type ModuleDisposeContext = ModuleInitContext;
```

移除直接的 `env/logger/events` 字段。模块通过 `ctx.app` 使用内核能力，通过 `ctx.services` 获取业务服务。

Module dispose 仍在业务 Container dispose 前执行，仍可解析业务服务；原有启动失败回滚与逆序清理行为保持不变。

### 4.3 HandlerContext

HandlerContext 统一为：

```ts
interface HandlerContext {
    readonly app: AppHandle;
    readonly services: ServiceAccessor;
    /** 当前 channel 的子 logger，不是另一个根能力入口。 */
    readonly log: Logger;
    /** 当前调用方信息。 */
    readonly sender: IpcCallInfo;
}
```

移除直接的 `events` 等内核能力字段。IpcRouter 内部仍可直接消费 AppHandle 以完成来源校验、日志与事件相关工作。

### 4.4 业务模块迁移

- system：应用信息来自 `ctx.app.env`；退出使用 `ctx.app.quit()`。
- settings：工厂通过 `app.env/app.logger/app.events` 构造实现；模块 init 通过 `ctx.app.logger` 记录日志。
- search：工厂通过 `app.deployments` 创建 ExternalServiceClient；模块 init 使用 `ctx.app.logger`。
- 其他测试与演示模块按同一规则迁移。

## 5. DesktopApp 与 Container 所有权

### 5.1 DesktopApp 拥有的对象

DesktopApp/Builder 直接持有并接线：

- 固定机制：Lifecycle、ServiceContainer、IpcRouter、模块激活；
- 内核能力：Logger、AppEnv、EventPublisher、DeploymentController、WindowController；
- 宿主运行时：HostRuntime、IpcTransport、ProcessHost；
- 受限 AppHandle facade。

Builder 可以创建这些对象，但创建后的应用生命周期所有权归 DesktopApp。DesktopApp 可以保留私有直接引用，不再把它们注册进业务 Container。

`DesktopApp.logger` 继续作为进程壳 fatal logging 的启动期快捷入口；模块不直接访问 DesktopApp，只访问 AppHandle。

### 5.2 Container 只管理业务与应用服务

删除以下注册与公开 token：

- `envToken`；
- `loggerToken`；
- `eventsToken`；
- `appControlToken`；
- `deploymentReadinessToken`；
- `deploymentAdminToken`；
- 内部 `processHostToken`；
- 内部 `deploymentControlPlaneToken`。

`core/api/tokens.ts` 与 `core/kernel/tokens.ts` 应随最后的使用者移除。`core/api/app-control.ts` 的能力由 `AppHandle.quit()` 取代，可删除。

保留 `serviceToken`、`defineService`、ServiceToken、ServiceAccessor 等业务服务词汇。业务 token 继续由各模块自己的 `api.ts` 定义。

Container 构造时可以接收 AppHandle 和 Logger 作为框架依赖，但这些是构造注入，不表示把内核能力登记为业务服务。

### 5.3 生命周期清理

保持现有顺序：

```text
停止接受新调用
→ 关闭窗口
→ 模块逆序 dispose
→ 业务 Container dispose
→ Deployment stopAll
→ 内核能力收尾
→ Logger 最后释放（若未来有释放需求）
```

Deployment 不再经 Container dispose，而由 DesktopApp 显式 `stopAll()`。Logger 不经过业务 Container 回收，避免容器清理完成后 fatal/shutdown 日志失去日志能力。

保留上一轮全部容器并发、pending dispose 和启动失败回滚行为。

## 6. Deployment 调整

### 6.1 回到内核直接构造与持有

DeploymentManagerImpl 不再经 ServiceContainer 工厂创建。Builder 使用 Env、Logger、ProcessHost、DeploymentProfile 直接构造，登记模块申报的 DeploymentSpec，然后将同一个实例：

- 作为 DeploymentController 交给 DesktopApp 启动和停止；
- 作为 DeploymentReadiness 放进受限 AppHandle；
- 作为 DeploymentAdmin 仅用于框架内部管理路由接线。

由于 spec 登记回到 build 阶段，字段非法与重复声明都应在任何 run 副作用之前暴露。原先依赖“无效 spec 在 run 工厂失败”的测试应改为验证 build 失败；启动回滚仍须由模块 init 失败、required 部署失败等场景覆盖。

### 6.2 三种受众仍然分离

- AppHandle 只暴露 DeploymentReadiness。
- DesktopApp 独占 DeploymentController。
- DeploymentAdmin 不进入 AppHandle，也不保留公开 token。

为了在不使用 token 的情况下保持 Admin 权限边界，本次将 deployments 管理 RPC 改为**框架内置路由**：由 core/deployment 的管理路由接线函数在 Builder/build 时直接注册，并消费内部 DeploymentAdmin。

因此：

- 删除 `main/modules/deployments` 业务模块及组合根中的 `.use(deploymentsModule)`；
- `deployments.list/start/stop/restart` 的 channel、输入输出、错误翻译和现有 renderer 行为保持不变；
- 管理路由仍在 build 期登记、run 期随 Router 安装；
- Search 等普通业务模块只能得到 Readiness，无法经公共面取得 Admin/Controller。

DeploymentAdmin 类型可移到 core/deployment 内部公开给管理路由使用，不再从 `core/api` 导出。DeploymentReadiness、DeploymentSpec、状态与错误等模块 authoring 类型继续保留在 api。

### 6.3 内核依赖方向

DesktopApp 拥有的 Deployment 等内核能力只能依赖其他内核能力和 SPI，不能反向解析业务 Container 中的服务。

未来若某个部署策略必须依赖业务 Database 或领域配置：

- 通用进程 supervisor 仍留在内核；
- 业务相关策略移入基础设施/业务模块；
- 不通过让 DeploymentManager 反向获取任意业务 token 来破坏依赖方向。

## 7. api / kernel / spi 目录语义

不把所有内核能力笼统塞进 spi。

- `core/api`：模块可见的 AppHandle、Logger、AppEnv、EventPublisher、LifecycleView、DeploymentReadiness、业务 DI 词汇等公共类型。
- `core/kernel`：DesktopApp、Builder、Container、Lifecycle，以及内核拥有的能力实现/解析器。
- `core/spi`：真正由 Electron/Node/OS/测试替身提供的宿主实现接缝，例如 HostRuntime、IpcTransport、ProcessHost、WindowController/EventSink。
- `core/deployment`：DeploymentManager 实现、内部 Controller/Admin 类型和内置管理路由。

Env resolver、内存/控制台 Logger、EventPublisherImpl 等内核能力实现可整理到 `core/kernel/capabilities/`；公开 facade 类型仍在 api。Logger 当前公开方法与适配实现所需方法相同，可以暂时共享 `api/logger.ts`，不为了目录纯粹性额外复制 LoggerBackend 类型；只有出现真实后端权限差异时才拆分 SPI。

`core/api/external-client.ts` 继续作为模块 authoring API，依赖 DeploymentReadiness。

## 8. 测试调整与新增守护

### 必须保留

- 容器同 token 冷启动并发、独立/重叠子图、真实循环、失败重试；
- pending 创建与 dispose 竞态、幂等 dispose；
- build 纯声明冲突先于副作用；
- 模块 init/required 部署失败回滚；
- 正常 IPC、优雅退出、Settings 持久化、Search 外部服务；
- 现有架构分层和 Electron 默认装配。

### 必须更新或新增

1. ServiceFactoryContext 测试：工厂能取得同一 AppHandle，并且 scoped services 的循环检测不退化。
2. Module init/dispose 测试：通过 `ctx.app` 获取 Env/Logger/Events/Lifecycle/Readiness，dispose 仍可通过 `ctx.services` 使用未释放业务服务。
3. HandlerContext 测试：handler 能通过 `ctx.app` 使用内核能力，`ctx.log` 仍是 channel 子 logger。
4. Settings/Search/System 测试：不再引用任何内核能力 token。
5. Container 测试：业务工厂只注册业务 token；内核能力不存在于 Container 注册表。
6. Deployment 内置路由测试：list/start/stop/restart 行为与错误翻译保持；普通 AppHandle 只有 Readiness。
7. 无效 DeploymentSpec 在 build 期失败且不产生 run 副作用。
8. 架构测试：core 公共面不导出内核能力 token，模块不出现已删除 token 的深层兼容导入。

## 9. 文档同步

完成后更新：

- `docs/ARCHITECTURE.md`：以“DesktopApp 能力内核 + 业务 Container + ctx.app”为唯一当前模型，删除内核能力 token 与 Deployment 容器工厂的旧描述。
- `AGENTS.md`：更新公开能力、服务工厂签名、模块上下文、业务 token、Deployment 内置管理路由和文件去向。
- `docs/ARCHITECTURE_REFACTOR_PLAN.md`：顶部增加后续变更指引，避免把已完成的旧决策误读为当前约定。
- 本文档：记录必要实现偏离与审查修正。

## 10. 验收标准

1. Logger、AppEnv、EventPublisher、Deployment 由 DesktopApp/Builder 直接持有，不注册进业务 Container。
2. 不再存在任何内核能力 token；token 只用于业务与应用服务。
3. ServiceFactory、Module init/dispose、Handler 全部统一为 `ctx.app + ctx.services`，没有遗漏的接触点。
4. `ctx.app` 是窄 AppHandle，不是 DesktopApp；不含 Container、Router、Host、完整 Lifecycle、Admin 或 Controller。
5. Deployment Readiness/Admin/Controller 三受众仍分离，管理 RPC 行为不变且不再作为业务模块暴露。
6. SPI 只包含真实宿主实现接缝，没有重新变成通用 ports 目录。
7. 内核能力不反向依赖业务 Container 服务。
8. 前一轮容器并发、dispose、启动回滚和架构守护成果没有回退。
9. `docs/ARCHITECTURE.md` 与 `AGENTS.md` 只描述新模型，没有互相矛盾的当前约定。
10. 仓库根以下命令全部通过：

```bash
pnpm test
pnpm typecheck
pnpm lint
```

不创建 git 分支、不提交、不推送。

## 11. 实施记录与偏离说明

实施按本规格完成。以下为实施中的明确补充决定（均有测试守护）：

1. **`ServiceContainer` 构造签名**：`constructor(app: AppHandle, logger?: Logger)`——AppHandle 为首个构造参数（§5.2 允许的构造注入），logger 仍用于 dispose 失败记录。
2. **`IpcRouter` 选项收敛**：`RouterOptions` 收敛为 `{ app, services }`——来源白名单（`app.env`）、生命周期门禁（`app.lifecycle`）、根 logger（`app.logger`）都经 AppHandle 取得；`ctx.log` 仍是 channel 子 logger，`ctx.events` 字段删除（事件发布走 `ctx.app.events`）。
3. **AppHandle 的 `lifecycle` 直接传入 `Lifecycle` 实例**：`Lifecycle` 本就实现 `LifecycleView`，无需额外包装；`deployments` 直接传入 DeploymentManagerImpl（实现 `DeploymentReadiness`）。facade 是普通对象字面量，`quit` 闭包指向 `host.quit()`（仍走 before-quit → 优雅关停）。
4. **`DeploymentAdmin` 接口落位**：从 `core/api/deployment.ts` 移到 `core/deployment/controller.ts`（与 DeploymentController 同文件），只被 `core/deployment/admin-routes.ts` 的内置路由接线消费；`core/api` 与公共 barrel 不再出现该名字（架构守护测试固化）。
5. **部署 spec 校验时机**：重复 id 仍在 build 的纯声明校验段先行抛错（plain Error，与原先一致）；字段合法性（baseUrl、managed 缺 command 等）随 `DeploymentManagerImpl.register()` 在 build 期暴露为 `InvalidDeploymentError`——原「控制面工厂失败时清理容器内 processHost」的回归场景随控制面脱离容器而不复存在，该测试改写为「无效 spec 在 build 期失败且无任何 run 副作用」；启动失败回滚仍由模块 init 失败、required 部署失败测试覆盖，`registerShutdownPipeline()` 仍是 `run()` 内第一步。
6. **架构守护测试新增**：已删除内核能力 token 的标识符级全源码扫描（含深层兼容导入）、`core/api/**` 无 `serviceToken(...)` 调用（豁免 di.ts 的词汇定义）、`DeploymentAdmin` 不经 api 导出、三类接触点类型均含 `readonly app: AppHandle`。
7. **测试夹具**：`test/fakes.ts` 新增 `FakeReadiness`（空就绪面）与 `makeAppHandle()`（内存 AppHandle 组合），供 container/router 等单元测试构造 `ctx.app`。

## 12. 后续实施记录：AppHandle 签发权收敛到 DesktopApp

§11 第 3 条当时的实现仍由 Builder 组装 facade，并把 `Lifecycle`/`DeploymentManagerImpl` 实例直接放进 `ctx.app`（类型窄面，运行时本体仍可达），`quit` 闭包直指 `host.quit()`。后续讨论确认这不够：**能力调用权应收进 DesktopApp，而不是 Builder**。已按以下方案补齐（本节为当前权威约定）：

1. **类型改名**：`AppContext` → `AppHandle`（`core/api/app-handle.ts`）。它是由 DesktopApp 签发的冻结委托 facade，语义对齐 Tauri `AppHandle`，不再叫"上下文"。
2. **组装按句柄切分**：Builder 保留组合根职责——收集声明、声明级冲突校验、调 providers 构造**叶子能力**（logger/env/lifecycle/windows/events/部署控制面）后移交；DesktopApp 构造函数是唯一句柄签发点——`createHandle()` → `new ServiceContainer(handle)` → `new IpcRouter({ app: handle, services })` → 登记服务/路由/窗口/内置管理路由。依赖句柄的部件必须由句柄签发者构造，Builder 不再出现这些接线。
3. **运行时窄面（不只是类型窄面）**：`ctx.app.lifecycle` 是只含 `state/when/onChange` 的冻结 wrapper（`transition/shutdown/onShutdown` 不在对象上）；`ctx.app.deployments` 是只含 `getStatus/whenReady/onChange` 的冻结 wrapper（`start/stop/restart/list/register/startAll/stopAll` 不在对象上）；logger/events 为转发回调；句柄整体 `Object.freeze`。
4. **env 冻结快照**：`AppEnv` 全字段 readonly（含 `rendererEntry` 属性与来源白名单数组），`resolveEnv` 对对象与嵌套 entry/数组执行 `Object.freeze`。
5. **受控退出入口**：`ctx.app.quit()` 与 `DesktopApp.quit()` 共同走 `requestQuit()`——shuttingDown/exited 后 no-op，其余状态经 `host.quit()` 进入 before-quit → 统一优雅关停，不再由 Builder 闭包直指宿主。
6. **测试守护**：集成测试断言句柄冻结、lifecycle/deployments 无特权方法、env 冻结且严格模式改写抛 TypeError、quit 关停后重复调用 no-op；架构守护断言 Builder 不含 `new ServiceContainer`/`new IpcRouter`/`registerDeploymentAdminRoutes`/`createHandle`，DesktopApp 含句柄签发与受控退出实现。
