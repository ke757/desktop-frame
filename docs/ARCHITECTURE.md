# 架构文档（desktop-frame 基座）

本文回答四个问题：为什么需要显式生命周期管理、依赖注入如何划分作用域、IPC 层如何做到类型安全且可演进、以及文件结构如何支撑长期迭代。所有设计均标注了业界参照。

> 结论先行：Electron 生态没有 FastAPI 那样的统一框架惯例。本基座以 VS Code 主进程（最大的开源 Electron 应用）的 lifecycle phase + service locator + shutdown joiner 模式为蓝本，用现代 TypeScript（异步工厂、token 类型化、zod 契约）重新实现，并用可单测的纯 TS 核心 + 薄 electron 适配层组织代码。

## 1. 调研结论（决策依据）

| 主题 | 结论 | 参照 |
| --- | --- | --- |
| 显式生命周期状态机 | 大型应用（VS Code）用 forward-only phase 机器管理启动阶段与关停管线；Electron 原生只有裸事件 | VS Code `LifecycleMainPhase`（`lifecycleMainService.ts`） |
| 优雅退出 | 标准模式 = `before-quit` + `preventDefault` + joiner 收集异步清理 + 落盘 + 二次退出；VS Code 源码即活例 | VS Code lifecycleMainService；Electron app 文档 |
| DI | 无生态标准。两条主流路线：自研轻量 service locator（VS Code `createDecorator`/`registerSingleton`）或 显式手动组装 + init()（Expo Orbit 2025）。第三方容器（inversify 等）无大型主进程先例 | VS Code instantiationService；expo/orbit |
| 请求级作用域 | Electron 无 HTTP 请求概念。对应物是 **每次 IPC 调用**（本基座实现为 HandlerContext）与 **窗口级**（VS Code 用 createChild 子容器） | VS Code `invokeFunction`/`createChild` |
| 类型安全 IPC | electron-trpc 已停更且不支持 tRPC v11（issue #227）；自研「zod 契约 + envelope」是当前稳妥路线。Electron IPC 只保留 Error.message（electron#24427），错误必须走信封 | electron-trpc 仓库；Electron ipcMain 文档 |
| preload 安全 | Electron 45：sandbox 默认开；sandboxed preload 移除 Buffer/events/timers shim，只能 require `electron`。不得暴露 `ipcRenderer` 本体（安全检查表 #20） | Electron 45 breaking changes；安全检查表 |
| 前后端拆分 | forge vite 插件 `renderer: []` 合法；dev 加载 web dev server URL、打包把 web 产物复制进 asar 是成熟模式 | plugin-vite 源码行为（已实测验证） |
| 日志/校验 | electron-log v5 与 zod v4 是当前事实标准 | 两者官方文档 |

## 2. 总体结构与启动装配

```
┌────────────── apps/web（独立 Vite 项目，界面） ───────────────┐
│  typed client ←─ @desktop-frame/contracts（编译期类型 + 运行期校验）│
└────────────┬──────────────────────────────────────────────┘
             │ window.desktop（contextBridge 暴露的 invoke/on，preload.ts）
┌────────────┴──────────────────────────────────────────────┐
│  Electron ipcMain.handle（envelope 协议，永不 reject）        │
│  ┌──────────────────── apps/desktop 主进程 ─────────────────┐ │
│  │ IpcRouter ──→ HandlerContext（每次调用）──→ 业务 handler    │ │
│  │      │                    │                              │ │
│  │      │            ServiceContainer（app 级单例，逆序 dispose）│ │
│  │      │            Lifecycle（状态机 + shutdown joiner）│ │
│  │      └──→ EventPublisher ──→ WindowManager（webContents.send）│ │
│  └─────────────────────────────────────────────────────────── │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 启动装配（builder 形态，对齐 Tauri v2 / FastAPI）

启动控制权在框架（总对象）而非调用方——业务只声明，框架驱动（FastAPI 的 `lifespan` 由框架调用；Tauri 的 `setup` 钩子与 `App::run` 事件循环同理）：

```ts
// main/index.ts —— 装配脚本（唯一声明"应用由什么组成"的地方）
buildDesktopApp():
  desktopApp({ host, transport, createWindows, mainDir, createLogger })
      .use(systemModule, settingsModule)   // 声明业务模块
      .window(createMainWindowDefinition()) // 声明窗口
      .build();                            // 构造对象图，不启动（Tauri build 语义）

// main.ts —— 进程壳（进程级策略集中于此，对齐 Tauri main.rs 的 .expect）
squirrel → 单实例锁 → buildDesktopApp() → 全局异常兜底 → .run()
  .catch(() => process.exit(1));
```

| Tauri v2 | 本基座 |
| --- | --- |
| `Builder::default().plugin().setup().manage()` | `desktopApp(opts).use(mod).window(def)` |
| `build(context) → App`（不启动） | `.build() → DesktopApp`（不启动，对象图可检视） |
| `App::run(cb)` 阻塞至退出 | `.run()` Promise 至 lifecycle `exited` |
| `RunEvent::ExitRequested { api.prevent_exit() }` | `before-quit` preventDefault → joiner 管线 |
| `setup(\|app\|)` 钩子 | `module.init(ctx)`（+ dispose/onShutdown = lifespan 关停段） |
| `AppHandle::exit(code)` | `HostApp.quit()`（业务经 `hostToken` 取用；框架自身另有 `DesktopApp.quit()`） |

**接线与声明的分离**是关键：核心对象的互连（lifecycle/container/windows/events/router 之间的构造注入）全部收敛在 `core/builder.ts` 的 `build()`——一次性框架代码，只在框架演进时改动且有集成测试守护；应用的高频变化（加模块、加窗口）只触碰装配脚本里的一行 `.use()` / `.window()`，不碰任何接线。核心对象间的"互含"用接口倒置消解（如 `EventPublisher` 依赖 `EventSink`/`WindowHost` 接口，`WindowManager` 是其 Electron 实现），构造顺序固定为 DAG。

### 2.2 端口与适配器（六边形架构的显式化）

`main/core/ports/` 与 `main/electron/` 是一对镜像目录：**ports 是 core 拥有的接缝接口（一侧是框架、一侧是外部世界），electron/ 的每个文件实现一个端口**。端口清单与实现一一对应：

| 端口（core/ports/） | 实现方 |
| --- | --- |
| `host.ts`（HostApp + BeforeQuitEvent） | `electron/host.ts` |
| `ipc-transport.ts`（IpcTransport + IpcListener + IpcCallInfo） | `electron/ipc-transport.ts` |
| `window-host.ts`（WindowHost + WindowDefinition）、`event-sink.ts`（EventSink） | `electron/windows-manager.ts` |
| `logger.ts`（Logger + LogLevel + LogMeta） | `electron/logging.ts`、core 的 MemoryLogger |
| `event-publisher.ts`（EventPublisher） | core 的 `EventPublisherImpl` |
| `module.ts`（AppModule + ModuleInitContext，driving port） | `modules/**` |
| `di.ts`（ServiceToken/ServiceAccessor/DisposableService 等 DI 词汇） | core 的 ServiceContainer |
| `route-registrar.ts`（RouteRegistrar + HandlerContext + RouteHandler） | core 的 IpcRouter |
| `env.ts`（AppEnv 数据契约） | core 的 resolveEnv 产出 |

判定口径：**接口存在是为了让 core 之外的某方实现或消费，才是 port**；框架自身实现（Lifecycle、ServiceContainer、IpcRouter、DesktopApp、builder）不是 port，不做每类一接口的抽象（无多实现前景、无仅内部可见的公开方法、同包同版本内 DIP 无收益）。`AppEnv` 作为共享内核数据契约随 ports 存放（适配器与业务共同消费）。

分层规则（保证可测试性的关键，全部由守护测试固化）：

- `main/core/**`：**纯 TS，零 electron 依赖**，相对 import 不逃出 core；`core/ports/**` 只依赖 ports。
- `main/electron/**`：适配层，对 core 的 import 只允许 `core/ports/**`（端口镜像，依赖方向自证）。
- `main/modules/**`：对 core 只经 barrel `core/index.ts` 导入；跨模块 import 只允许 `*.service.ts`/`*.module.ts`/`*.tokens.ts`。
- `main/index.ts`（装配脚本）、`main/windows.ts`（窗口定义，应用声明而非适配器）。
- `src/main.ts` / `src/preload.ts`：仅有的两个构建入口。

## 3. 生命周期状态机（`core/lifecycle.ts`）

```
initializing ──→ ready ──→ shuttingDown ──→ exited
```

- **只进不退**：`transition()` 拒绝回退，重复置同态为 no-op。
- **可等待**：`when(state)` 返回 Promise（已到达则立即 resolve），启动编排用它挂接阶段任务（对应 VS Code 的 `when(phase)`）。
- **关停管线**：`onShutdown(joiner)` 注册清理函数，`shutdown()` 顺序执行、逐个容错（失败记日志不中断），最终落 `exited`。这是 VS Code `onWillShutdown` + `e.join()` 的等价物。

Electron 原生事件到状态机的映射（`core/desktop-app.ts` 的 `DesktopApp.run()`）：

| Electron 事件 | 行为 |
| --- | --- |
| `app.whenReady` | 注册模块服务 → 模块 init → 安装路由 → `ready` → 打开主窗口 → 挂起等待 `exited` |
| `before-quit` | `preventDefault()` → `lifecycle.shutdown()`（窗口先关、服务后 dispose）→ `host.exit(0)` |
| `window-all-closed` | 非 macOS `quit()`（macOS 留 Dock，`activate` 重开窗口） |
| `second-instance` | 聚焦已有主窗口（单实例锁在 `main.ts` 进程壳检查） |
| `uncaughtException` / `unhandledRejection` | 记日志，不崩溃（`main.ts` 安装） |

状态变化会通过 `app.lifecycleChanged` 事件广播给所有 renderer（web 界面左上角徽标实时显示）。

**为什么需要状态机**：Electron 只有事件没有秩序。大型后端需要回答"现在能不能接请求"（路由门禁：非 `ready` 一律返回 `UNAVAILABLE` 信封）、"退出时以什么顺序释放什么"（joiner 顺序即资源依赖序）、"各子系统进行到哪一步了"（`when()` 可等待）。这三个问题裸事件模型回答不了。

## 4. 依赖注入（`core/container.ts`）

### 4.1 与 FastAPI 的对照

| FastAPI | 本基座 | 说明 |
| --- | --- | --- |
| `lifespan` 管理的 app 级依赖（如 db） | `ServiceContainer` + `defineService(token, factory)` | 异步工厂、惰性实例化、memoize、逆序 dispose |
| `Depends` 注入的请求级依赖 | `HandlerContext`（每次 IPC 调用构造） | 含 `services`/`log`/`events`/`sender`，随调用结束即弃 |
| —（无对应） | 窗口级作用域 | 演进方向：多窗口时用子容器（见 §12） |

### 4.2 设计要点

- **Token 类型化**：`serviceToken<T>('modules.settings')` —— 不用装饰器/`reflect-metadata`，对任意打包器友好且 tree-shakable（VS Code 需要自定义 TS transform 才能用装饰器元数据，我们不背这个包袱）。
- **异步工厂**：不同于 VS Code 的纯同步容器，工厂可 `await`（打开数据库、读配置文件），更贴合后端语义。
- **惰性 + memoize**：首次 `get` 才创建（VS Code `InstantiationType.Delayed` 同款策略，利于启动性能）；失败不缓存可重试。
- **循环依赖**：解析链检测，抛 `CyclicDependencyError`（带完整链路）。已知限制：工厂内 `Promise.all` 两个存在重叠子图的 `get` 可能误报——避免在工厂里并行取重叠依赖。
- **逆序 dispose**：按实例化相反顺序调用 `dispose()`（依赖方先释放）；单个失败只记日志，不阻断其余清理。

### 4.3 三种获得依赖的方式

```ts
// 1) 服务工厂内声明依赖（app 级）
export const settingsService = defineService(settingsToken, async (acc) => {
  const env = await acc.get(envToken);
  ...
});

// 2) handler 内按调用取（请求级，FastAPI Depends 的对应物）
registrar.handle(contract.settings.getAll, async (ctx) => {
  const settings = await ctx.services.get(settingsToken);
  return settings.get();
});

// 3) 框架层（builder/DesktopApp 直接持有核心对象引用，无需容器）
```

### 4.4 接口化 token：公开面与框架钩子分离

暴露给模块外部的服务**必须接口化**，规则是"两个受众、两个接口"：

```ts
/** 公开接口：token 的类型参数 = 外部允许调用的全部方法。 */
export interface SettingsService {
    get(): SettingsFile;
    update(patch: SettingsPatch): SettingsFile;
}
export const settingsToken = serviceToken<SettingsService>('modules.settings');

/** 实现：生命周期方法（load/flush/dispose）不在公开接口里。 */
export class SettingsServiceImpl implements SettingsService, DisposableService { ... }
```

- **公开接口**（token 类型）：外部消费方经 `get(settingsToken)` 只看到 `get/update`，类型即文档；测试替身只需实现窄接口。
- **框架钩子**（`DisposableService.dispose`）：受众是容器，**独占调用**。dispose 刻意不进公开接口——否则任何 handler 都能把别人的服务释放掉。
- 实现类缺省命名 `XxxServiceImpl`（实现有更贴切的角色名时可用，如 `JsonFileStore`）；模块内部独享、不经 token 暴露的服务可省略接口。

**不做 FastAPI Depends 式自动注入**（刻意决策）：自动签名分析需要装饰器/reflect-metadata（VS Code 为此自写 TS transform），换来的是魔法反射与更差的报错，省去的只是一行 `acc.get()`；我们的服务是单次组合的 app 级单例，factory + accessor 就是组合语言（且 `CyclicDependencyError` 带完整链路）。FastAPI 使用经验里感到"缺"的其实是作用域（P3 的 `createScope`），不是自动注入。

## 5. 类型安全 IPC（`core/ipc/` + `packages/contracts`）

### 5.1 契约（单一事实源）

`packages/contracts` 中 `procedure(channel, inputSchema, outputSchema)` 定义端点、`event(channel, payloadSchema)` 定义事件。主进程注册 handler、web 调用 client，两侧共享同一编译期类型；运行期 zod 双向校验（web 侧输出校验防契约漂移）。

### 5.2 信封协议（为什么不是 throw）

Electron 的 `ipcMain.handle` reject 后只有 `message` 字符串能到 renderer（V8 序列化丢弃自定义属性，electron#24427），contextBridge 还会二次剥离。因此 handler **永不 reject**，一切调用返回：

```ts
type RpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; data?: unknown } };
```

框架错误码：`VALIDATION` / `FORBIDDEN` / `UNAVAILABLE` / `INTERNAL` / `BRIDGE_ERROR`；业务侧 `throw new RpcError('MY_CODE', msg, data)` 自由扩展。web 侧 client 把 `ok:false` 转成 `IpcError` 抛出。

### 5.3 每次调用的处理管线（`IpcRouter.dispatch`）

```
frame 来源白名单校验 → 生命周期门禁(ready) → 输入 zod 校验
→ handler(ctx, input) → 输出 zod 校验 → ok 信封
（任何一步失败 → 对应错误码信封，永不 reject）
```

`sender.frameUrl` 白名单：dev 为 web dev server origin，打包后仅 `file://`。

### 5.4 事件（main → renderer）

`EventPublisher.publish(evt, payload)` 校验后经 `WindowManager.send` 广播到所有存活窗口；preload 包装返回 **unsubscribe 函数**（channel 级多路复用，最后一个订阅者移除时才 `removeAllListeners`，防泄漏）。

### 5.5 preload 约束（Electron 45）

沙箱 preload 中不可用 Buffer / events / timers / url shim。`src/preload.ts` 只使用 `electron` 模块与标准 Web API；桥是**通用**的（string channel + unknown payload），因此契约演进不需要改 preload。

## 6. 窗口管理（`app/windows/`）

- 声明式 `WindowDefinition`（id、`create(env)` 构造含安全 webPreferences 的 BrowserWindow）；`WindowManager` 负责：加载 renderer 入口（dev URL / 打包文件）、ready-to-show 后显示、跟踪与清理。
- **提前缓存 `webContents.id`**（electron-trpc #156 的教训：窗口 destroyed 后不可再触碰 `win.webContents`）。
- `render-process-gone` 记日志；`closeAll()` 在关停管线中先于服务 dispose 执行。
- 安全基线：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true` 显式声明。

## 7. 模块协议、角色与命名（`core/module.ts`）

业务特性以模块接入：`{ id, services?, registerRoutes?, init? }`。装配脚本（`main/index.ts`）只做声明，框架在 `run()` 中按固定时序调用：注册服务 → 注册路由 → 模块 init → 路由上线 → `ready` → 开窗。示例模块 `system`（纯路由：0 个服务）与 `settings`（服务 + 路由 + init）。

### 7.1 角色词汇表

| 角色 | 是什么 | 不是什么 | 业界类比 |
| --- | --- | --- | --- |
| **Token** | 依赖接缝的命名句柄（id 即分层标记） | 不是依赖本身/实例 | VS Code `createDecorator` 的 id |
| **Service（业务服务）** | 运行时对象图节点：有状态、可持资源、可 dispose | 不是文件/模块/"大一号的东西" | Nest provider |
| **核心部件** | 框架器官（Lifecycle/EventPublisher/WindowManager/IpcRouter） | 业务不可增删；build() 同步构造 | VS Code platform 层 |
| **Module** | **声明期申报单元**（services+routes+init）；运行时"溶解"为 token 与 channel | 没有运行时实例；不是服务容器 | Nest `@Module` |
| **Handler/Route** | 无状态调用端点（状态放服务） | 不是依赖存放处 | FastAPI 路由函数 |
| **Contract** | 跨进程接缝（procedure/event + schema） | 不含行为 | tRPC procedure |

三条判断轴：Service vs Module（运行时节点 vs 声明期申报）；Service vs Handler（状态要活过本次调用吗）；业务服务 vs 核心部件（`modules.*` 惰性异步 / `core.*` 内置同步）。

### 7.2 命名约定

1. **token id 即边界**：`core.*`（集中定义于 `core/tokens.ts`）/ `modules.<mod>.*`（定义在模块内）。
2. **类名**：业务服务 = 接口 `XxxService` + 实现 `XxxServiceImpl`（见 §4.4）；核心部件用角色名（Manager/Router/Publisher/Logger），不带 Service 后缀。
3. **目录即分层（六边形）**：`core/ports` 只依赖 ports；`core/` 不逃逸且零 electron；`electron/` 只 import ports；`modules/` 对 core 只经 barrel 且跨模块 import 只认 `*.service.ts`/`*.module.ts`/`*.tokens.ts`；electron 直接使用仅限适配目录与模块内 `dialog`/`BrowserWindow`。
   以上三条由 `test/architecture.test.ts` 静态扫描固化（改结构先跑它）。

### 7.3 模块目录即封装边界

```
modules/project/
  project.module.ts     # 申报：services + routes + init（模块"封面"）
  project.service.ts    # 接口 + token + 实现（公开接缝）
  sqlite-store.ts       # 私有协作者：无 token，跨模块不可见
```

- **跨模块 import 只允许指向 `*.service.ts` / `*.module.ts` / `*.tokens.ts`**（拿接口与 token）；私有协作者文件被守护测试封死。
- 跨模块协作只有两条通道：**契约**（contract/appEvents）与 **token**（`ctx.services.get`）。
- **接缝三问**（何时值得一个 token）：要跨模块共享吗？要在测试里替换吗？要运行时可选/多实现吗？——皆否则私有类直接 `new`（factory 即该服务的私有组合根）。
- 初始化分界：**factory 内 await** = 服务自给自足的准备（打开自己的资源）；**module.init** = 特性的启动仪式（跨服务 warm-up、发初始事件）。

### 7.4 服务的注册、实例化与回收

```
register（run 期）        只登记工厂，零实例化
首次 get（惰性）           构造 + memoize（失败不缓存，可重试）
dispose（唯一回收点）      关停 joiner 触发 container.dispose()
```

**唯一回收点是应用关停**：joiner 管线（窗口先销毁、服务后 dispose）按**实例化逆序**调用 `dispose?.()`——依赖方先于被依赖方；单个失败记日志不阻断。没有运行期回收（无引用计数/空闲驱逐），服务与进程同寿命——刻意的简单性。边界情况：未实例化的服务 dispose 时是 no-op；忘写 dispose 只能靠 review（框架无法静态得知谁持资源）；进程被强杀时 joiner 不跑，持久化要按"随时可能死"设计（防抖 + 临时文件 + rename 原子写）。第二类回收（窗口级）由 P3 的 `createScope` 引入：`scope.dispose()` 随窗口关闭整支逆序释放，机制与 app 级完全同构。

## 8. 开发与打包链路

- **dev**：根 `pnpm dev` 并行起 web dev server（5173，strictPort）与 `forge start`。主进程 `waitForDevServer` 轮询等待（最多 30s）再开窗，规避启动顺序竞态。forge vite 插件配置 `renderer: []`（合法，实测验证），主进程/preload 热重启由插件负责，web 由 vite HMR 负责。
- **package**：`forge.config.mts` 的 `prePackage` 钩子执行 `pnpm --filter web build`（产物输出到 `apps/desktop/web/`，`base: './'` 保证 file:// 可用）；`packagerConfig.ignore` 白名单只保留 `/.vite`、`/web`、`/package.json`。主进程依赖全部由 vite 内联进 `main.cjs`，asar 内零 node_modules。
- 打包产物 `out/desktop-frame-darwin-arm64/`。

## 9. 添加新业务模块（操作清单）

1. **契约**：`packages/contracts/src/schemas.ts` 加 schema，`contract.ts` 加 `procedure('mod.action', In, Out)`（channel 唯一性有单测兜底）；事件加进 `appEvents`。
2. **模块**：`apps/desktop/src/main/modules/mod/` 新建 `mod.service.ts`（接口 + token + `XxxServiceImpl`，见 §4.4）与 `mod.module.ts`（routes + init）；私有协作者放同目录独立文件（见 §7.3）。
3. **装配**：`main/index.ts` 装配脚本 `.use(modModule)` 加一行（新窗口同理 `.window(...)`）。
4. **前端**：web 侧 `client.invoke(contract.mod.action, input)` / `client.on(appEvents.modChanged, cb)`。
5. **测试**：服务单测（注入 MemoryLogger + 内存 sink + tmpdir），路由行为已由 router 测试覆盖通用管线；涉及启动/关停时序的改动补 `desktop-app.integration.test.ts` 断言。

## 10. 测试策略

三层测试全部不依赖 Electron：**单元层**覆盖容器（惰性/memoize/循环依赖/逆序 dispose/失败重试）、生命周期（转换约束/when/joiner 顺序与容错/幂等）、路由（白名单/门禁/双向校验/RpcError/信封）、事件发布（校验丢弃）、settings 服务（持久化往返/损坏文件回退/落盘）；**集成层**（`test/desktop-app.integration.test.ts`）用 FakeHost/FakeTransport/FakeWindowHost 驱动 `desktopApp().build().run()` 跑通 `build 只装配不启动 → ready → IPC 实调 → quit → 关停管线 → exited → run() resolve` 的完整生命周期——等价于 FastAPI TestClient 驱动 lifespan 的体验；**架构守护层**（`test/architecture.test.ts`）静态扫描 import 图，把 §7.2 的分层约定固化为可执行断言（core 零 electron、core 只依赖 core、modules 不碰适配层、跨模块 import 白名单）。electron 相关薄层（host 适配、窗口管理、preload）靠 dev/package 冒烟覆盖。

## 11. 安全清单（对照官方 checklist）

- ✅ contextIsolation + sandbox 默认开启且显式声明；nodeIntegration 关闭。
- ✅ preload 暴露最小面（通用 invoke/on），不暴露 `ipcRenderer`；事件订阅返回退订函数。
- ✅ handler 校验 sender frame 来源白名单后才执行特权操作。
- ✅ 输入/输出双向 zod 校验；未知字段剥离。
- ✅ web 页面 CSP meta（`script-src 'self'` 等；dev 放行 localhost HMR）。
- ✅ Fuses：`EnableNodeCliInspectArguments`/`RunAsNode` 关闭，asar 完整性校验开启。

## 12. 演进路线（按需启用，不要提前建）

- **窗口级作用域**：多窗口业务（如每窗口独立项目状态）时引入子容器（参照 VS Code `createChild`）+ 按 webContentsId 路由事件。
- **关闭 veto 协议**：需要"有未保存数据时阻止关窗"时，参照 VS Code 逐窗口 `close` + `preventDefault` + 询问 renderer 的协议。
- **utilityProcess 工作池**：CPU 密集/可崩溃隔离任务用 Electron `utilityProcess`（MessagePort、独立崩溃上报），封装为容器服务，dispose 时统一 kill。
- **自动更新 / 托盘**：electron-updater 的 `quitAndInstall` 与托盘"关窗不退出"都应注册为 shutdown joiner 并叠加 `isQuitting` 标志，而不是散落的 preventDefault。
- **数据库/大状态**：settings.json 只适合小配置；结构化数据用 better-sqlite3（VS Code 与 Expo Orbit 同款选择），同样以 app 级服务 + dispose 关闭。
- **前端框架**：web 当前为 vanilla TS 以保持零主张；引入 React/Vue 只动 `apps/web`，契约与主进程不变。
