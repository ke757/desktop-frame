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
      app/               # 主进程应用代码
        core/            # 框架核心（不依赖 electron，可单测/集成测试）
          builder.ts     #   desktopApp() 装配 DSL（框架接线收敛于 build()）
          desktop-app.ts #   DesktopApp 总对象：run() 拥有启动到退出的生命周期
          container.ts   #   DI 容器（token + 异步工厂 + 逆序 dispose）
          lifecycle.ts   #   生命周期状态机 + shutdown joiner
          env.ts         #   环境/路径/来源白名单
          host.ts        #   Electron app 的窄接口抽象
          window.ts      #   WindowHost/WindowDefinition 纯接口
          tokens.ts      #   核心服务 token（core.* 命名空间）
          logging.ts     #   Logger 接口 + 测试用 MemoryLogger
          module.ts      #   AppModule 协议
          ipc/router.ts  #   类型安全 IPC 路由（校验/门禁/信封）
          ipc/events.ts  #   main→renderer 事件发布
        windows/         # 窗口管理器（实现 WindowHost）+ 声明式窗口定义
        modules/         # 业务模块（system / settings 示例）
        index.ts         # 装配脚本：.use()/.window() 声明应用组成
    test/                # 核心单测 + 全生命周期集成测试
  web/                   # 独立前端项目（Vite，当前为 vanilla TS，可换 React/Vue）
packages/
  contracts/             # IPC 契约：channel + zod schema + typed client
docs/
  ARCHITECTURE.md        # 架构文档（必读）
```

## 新增一个业务模块

1. 在 `packages/contracts/src/` 里定义 procedure/event（zod schema）；
2. 在 `apps/desktop/src/app/modules/<name>/` 写 `defineModule`：services + routes + init；
3. 在 `app/index.ts` 装配脚本 `.use(...)` 加一行；
4. web 侧用 `createClient(bridge).invoke(contract.xxx.yyy, input)` 调用。

详细指引与设计取舍见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#9-添加新业务模块)。

## 环境备注

- Node ≥ 24，pnpm ≥ 11（`nodeLinker: hoisted` 是 electron-forge 对 pnpm 的要求，见 `pnpm-workspace.yaml`）。
- `.npmrc` 配置了 electron 二进制国内镜像（npmmirror）；无此需要的协作者可删除。
- 首次 `forge package` 若下载 electron 缓存失败，可 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm --filter @desktop-frame/desktop package`。
