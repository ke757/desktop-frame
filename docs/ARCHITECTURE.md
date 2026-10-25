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

## 2. 总体结构

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
│  │      │            LifecycleService（状态机 + shutdown joiner）│ │
│  │      └──→ EventPublisher ──→ WindowManager（webContents.send）│ │
│  └─────────────────────────────────────────────────────────── │
└──────────────────────────────────────────────────────────────┘
```

分层规则（保证可测试性的关键）：

- `src/app/core/**`：**纯 TS，零 electron 依赖**。依赖注入用接口（`HostApp`、`IpcTransport`、`EventSink`、`Logger`），单测全部在这一层。
- `src/app/**`（core 之外）：electron 适配与业务。`electron-host.ts`、`electron-transport.ts`、`logging.ts`、`windows/` 是仅有的 import electron 的基础设施。
- `src/main.ts` / `src/preload.ts`：仅有的两个构建入口。

## 3. 生命周期状态机（`core/lifecycle.ts`）

```
initializing ──→ ready ──→ shuttingDown ──→ exited
```

- **只进不退**：`transition()` 拒绝回退，重复置同态为 no-op。
- **可等待**：`when(state)` 返回 Promise（已到达则立即 resolve），启动编排用它挂接阶段任务（对应 VS Code 的 `when(phase)`）。
- **关停管线**：`onShutdown(joiner)` 注册清理函数，`shutdown()` 顺序执行、逐个容错（失败记日志不中断），最终落 `exited`。这是 VS Code `onWillShutdown` + `e.join()` 的等价物。

Electron 原生事件到状态机的映射（`runtime.ts`）：

| Electron 事件 | 行为 |
| --- | --- |
| `app.whenReady` | 注册模块服务 → 模块 init → 安装路由 → `ready` → 打开主窗口 |
| `before-quit` | `preventDefault()` → `lifecycle.shutdown()`（窗口先关、服务后 dispose）→ `app.exit(0)` |
| `window-all-closed` | 非 macOS `quit()`（macOS 留 Dock，`activate` 重开窗口） |
| `second-instance` | 聚焦已有主窗口（单实例锁在入口 `requestSingleInstanceLock`） |
| `uncaughtException` / `unhandledRejection` | 记日志，不崩溃 |

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

// 3) 启动编排（组合根直接持有引用，无需容器）
```

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

## 7. 模块协议（`core/module.ts`）

业务特性以模块接入：`{ id, services?, registerRoutes?, init? }`。组合根（`app/index.ts`）只做装配。启动顺序：注册服务 → 注册路由 → 模块 init → 路由上线 → `ready` → 开窗。示例模块 `system`（窗口关联 dialog、RpcError 演示、退出）与 `settings`（app 级服务：JSON 持久化 + 防抖落盘 + dispose flush + 变更事件）。

## 8. 开发与打包链路

- **dev**：根 `pnpm dev` 并行起 web dev server（5173，strictPort）与 `forge start`。主进程 `waitForDevServer` 轮询等待（最多 30s）再开窗，规避启动顺序竞态。forge vite 插件配置 `renderer: []`（合法，实测验证），主进程/preload 热重启由插件负责，web 由 vite HMR 负责。
- **package**：`forge.config.mts` 的 `prePackage` 钩子执行 `pnpm --filter web build`（产物输出到 `apps/desktop/web/`，`base: './'` 保证 file:// 可用）；`packagerConfig.ignore` 白名单只保留 `/.vite`、`/web`、`/package.json`。主进程依赖全部由 vite 内联进 `main.cjs`，asar 内零 node_modules。
- 打包产物 `out/desktop-frame-darwin-arm64/`。

## 9. 添加新业务模块（操作清单）

1. **契约**：`packages/contracts/src/schemas.ts` 加 schema，`contract.ts` 加 `procedure('mod.action', In, Out)`（channel 唯一性有单测兜底）；事件加进 `appEvents`。
2. **模块**：`apps/desktop/src/app/modules/mod/` 新建 `mod.service.ts`（`defineService` + token + `dispose`）与 `mod.module.ts`（routes + init）。
3. **装配**：`app/index.ts` 的 `modules` 数组加一行。
4. **前端**：web 侧 `client.invoke(contract.mod.action, input)` / `client.on(appEvents.modChanged, cb)`。
5. **测试**：服务单测（注入 MemoryLogger + 内存 sink + tmpdir），路由行为已由 router 测试覆盖通用管线。

## 10. 测试策略

核心 38 个单测全部不依赖 Electron：容器（惰性/memoize/循环依赖/逆序 dispose/失败重试）、生命周期（转换约束/when/joiner 顺序与容错/幂等）、路由（白名单/门禁/双向校验/RpcError/信封）、事件发布（校验丢弃）、settings 服务（持久化往返/损坏文件回退/落盘）。electron 相关薄层（host 适配、窗口管理、preload）靠 dev/package 冒烟覆盖。

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
