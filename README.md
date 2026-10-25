# desktop-frame

Electron 桌面应用工程化基座：主进程"后端"（`apps/desktop`）与 Web 前端（`apps/web`）拆分为两个独立项目，通过 `packages/contracts` 中的类型安全 IPC 契约通信。

架构设计与决策依据见 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**。

## 快速开始

```bash
pnpm install
pnpm dev        # 并行启动 web dev server + electron-forge start
```

其他命令（在仓库根执行，作用于所有包）：

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 开发模式：web HMR + 主进程/preload 热重启 |
| `pnpm build` | 构建所有包（web 产物输出到 `apps/desktop/web/`） |
| `pnpm --filter @desktop-frame/desktop package` | electron-forge 打包（自动先构建 web） |
| `pnpm --filter @desktop-frame/desktop make` | 生成安装包（zip/dmg/deb/rpm/squirrel） |
| `pnpm test` | vitest 单测（核心框架 + 契约） |
| `pnpm typecheck` | 全部包 TypeScript 检查 |
| `pnpm lint` / `pnpm lint:fix` | oxlint + oxfmt |

## 仓库结构

```
apps/
  desktop/               # Electron 主进程（后端）+ preload 桥
    src/
      main.ts            # 进程壳：squirrel/单实例锁/全局异常/fatal 退出码
      preload.ts         # 沙箱 preload：contextBridge 暴露最小 invoke/on
      main/              # 主进程应用代码（六边形：端口与适配器镜像）
        core/ports/      #   端口层：HostApp/WindowHost/IpcTransport/EventPublisher/
                         #     Logger/AppModule/DI 词汇/AppEnv（纯类型，只依赖 ports）
        core/            #   框架实现（零 electron，可单测/集成测试）
          builder.ts     #     desktopApp() 装配 DSL（框架接线收敛于 build()）
          desktop-app.ts #     DesktopApp 总对象：run() 拥有启动到退出的生命周期
          container.ts   #     DI 容器（token + 异步工厂 + 逆序 dispose）
          lifecycle.ts   #     生命周期状态机 + shutdown joiner
          env.ts         #     环境解析（AppEnv 类型在 ports）
          tokens.ts      #     核心服务 token（core.* 命名空间）
          logging.ts     #     MemoryLogger / ConsoleLogger（Logger 端口在 ports）
          ipc/router.ts  #     类型安全 IPC 路由（校验/门禁/信封）
          ipc/events.ts  #     EventPublisherImpl（接口在 ports）
          index.ts       #     barrel：core 公共面（模块层只准从这里 import core）
        electron/        #   适配层：每个文件实现一个端口
          host.ts        #     HostApp ← electron app
          ipc-transport.ts #   IpcTransport ← ipcMain
          logging.ts     #     Logger ← electron-log
          windows-manager.ts # WindowHost ← BrowserWindow
        windows.ts       #   窗口定义（应用声明：开哪些窗、安全基线）
        modules/         #   业务模块（system / settings 示例）
        index.ts         #   装配脚本：.use()/.window() 声明应用组成
    test/                #   核心单测 + 全生命周期集成测试 + 架构守护
  web/                   # 独立前端项目（Vite，当前为 vanilla TS，可换 React/Vue）
packages/
  contracts/             # IPC 契约：channel + zod schema + typed client
docs/
  ARCHITECTURE.md        # 架构文档（必读）
```

## 新增一个业务模块

1. 在 `packages/contracts/src/` 里定义 procedure/event（zod schema）；
2. 在 `apps/desktop/src/main/modules/<name>/` 写 `defineModule`：services + routes + init；
3. 在 `main/index.ts` 装配脚本 `.use(...)` 加一行；
4. web 侧用 `createClient(bridge).invoke(contract.xxx.yyy, input)` 调用。

详细指引与设计取舍见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#9-添加新业务模块)。

## 环境备注

- Node ≥ 24，pnpm ≥ 11（`nodeLinker: hoisted` 是 electron-forge 对 pnpm 的要求，见 `pnpm-workspace.yaml`）。
- `.npmrc` 配置了 electron 二进制国内镜像（npmmirror）；无此需要的协作者可删除。
- 首次 `forge package` 若下载 electron 缓存失败，可 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm --filter @desktop-frame/desktop package`。
