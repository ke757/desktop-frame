import './styles.css';
import {
    appEvents,
    contract,
    createClient,
    getDesktopBridge,
    IpcError,
    type LifecycleState,
    type SettingsFile,
    type SystemInfo,
} from '@desktop-frame/contracts';

/**
 * 最小演示界面：覆盖全部 IPC 面——invoke（查询、变更、对话框、错误信封）
 * 与类型化事件订阅。刻意不依赖 UI 框架；换成 React/Vue 不需要动契约。
 */

const app = document.querySelector<HTMLDivElement>('#app')!;

/** 渲染静态骨架。 */
function renderShell(): void {
    app.innerHTML = `
    <main>
      <header>
        <h1>desktop-frame</h1>
        <span class="badge" id="lifecycle-badge" data-state="initializing">initializing</span>
      </header>
      <section class="card" id="bridge-status"></section>
      <section class="card">
        <h2>System (invoke)</h2>
        <dl class="info" id="system-info"></dl>
        <div class="row" style="margin-top: 12px">
          <button id="btn-dialog">Open file picker…</button>
          <button id="btn-error">Trigger demo error</button>
          <button id="btn-quit" class="danger">Quit app</button>
        </div>
        <pre id="invoke-result"></pre>
      </section>
      <section class="card">
        <h2>Settings (service round-trip)</h2>
        <div class="row">
          <label for="select-theme">Theme</label>
          <select id="select-theme">
            <option value="system">system</option>
            <option value="light">light</option>
            <option value="dark">dark</option>
          </select>
          <span class="note" id="settings-note"></span>
        </div>
      </section>
      <section class="card">
        <h2>Events (main → renderer)</h2>
        <ul class="log" id="event-log"></ul>
      </section>
    </main>
  `;
}

/** 更新生命周期徽标。 */
function setLifecycleState(state: LifecycleState): void {
    const badge = document.querySelector<HTMLElement>('#lifecycle-badge');
    if (!badge) return;
    badge.dataset.state = state;
    badge.textContent = state;
}

/** 向事件日志追加一条记录（最多保留 50 条）。 */
function logEvent(text: string): void {
    const list = document.querySelector<HTMLUListElement>('#event-log');
    if (!list) return;
    const item = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = new Date().toLocaleTimeString();
    item.append(time, document.createTextNode(text));
    list.prepend(item);
    while (list.children.length > 50) list.lastChild?.remove();
}

/** 在结果面板展示 JSON（isError 控制错误配色）。 */
function showResult(output: unknown, isError: boolean): void {
    const target = document.querySelector<HTMLPreElement>('#invoke-result');
    if (!target) return;
    target.classList.toggle('error', isError);
    target.textContent = JSON.stringify(output, null, 2);
}

/** 渲染系统信息表格。 */
function renderSystemInfo(info: SystemInfo): void {
    const target = document.querySelector<HTMLDListElement>('#system-info');
    if (!target) return;
    const rows: Array<[string, string]> = [
        ['app', `${info.appName}@${info.appVersion}`],
        ['electron / chrome / node', `${info.electron} / ${info.chrome} / ${info.node}`],
        ['platform', `${info.platform} (${info.arch})`],
        ['locale', info.locale],
        ['packaged', String(info.isPackaged)],
    ];
    target.innerHTML = rows
        .map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`)
        .join('');
}

/** 渲染设置区块（主题下拉 + 启动次数说明）。 */
function renderSettings(settings: SettingsFile): void {
    const select = document.querySelector<HTMLSelectElement>('#select-theme');
    const note = document.querySelector<HTMLElement>('#settings-note');
    if (select) select.value = settings.theme;
    if (note)
        note.textContent = `launch #${settings.launchCount + 1} · locale ${settings.locale}`;
}

/** 应用入口：检测桥、订阅事件、发起初始调用并绑定按钮。 */
async function main(): Promise<void> {
    renderShell();

    const bridge = getDesktopBridge();
    const status = document.querySelector<HTMLElement>('#bridge-status')!;
    if (!bridge) {
        status.innerHTML =
            '<p class="note">Not running inside Electron — start the app with <code>pnpm dev</code> at the repo root to exercise the IPC bridge.</p>';
        setLifecycleState('initializing');
        return;
    }

    const client = createClient(bridge);

    client.on(appEvents.lifecycleChanged, ({ state }) => {
        setLifecycleState(state);
        logEvent(`lifecycle → ${state}`);
    });
    client.on(appEvents.settingsChanged, ({ settings }) => {
        logEvent(`settings changed → ${JSON.stringify(settings)}`);
        renderSettings(settings);
    });

    try {
        const info = await client.invoke(contract.system.getInfo);
        renderSystemInfo(info);
        console.info('[web] IPC bridge OK:', `${info.appName}@${info.appVersion}`);
    } catch (cause) {
        showResult(describeError(cause), true);
    }

    const select = document.querySelector<HTMLSelectElement>('#select-theme');
    select?.addEventListener('change', async () => {
        try {
            const theme = select.value as SettingsFile['theme'];
            renderSettings(await client.invoke(contract.settings.update, { theme }));
        } catch (cause) {
            showResult(describeError(cause), true);
        }
    });

    document.querySelector('#btn-dialog')?.addEventListener('click', async () => {
        try {
            const result = await client.invoke(contract.system.openFilePicker, {
                multiple: false,
                title: 'Pick anything — this crosses the typed IPC bridge',
            });
            showResult(result, false);
        } catch (cause) {
            showResult(describeError(cause), true);
        }
    });

    document.querySelector('#btn-error')?.addEventListener('click', async () => {
        try {
            await client.invoke(contract.system.failWith, { code: 'USER_DEMO' });
            showResult({ unexpected: 'failWith should always fail' }, true);
        } catch (cause) {
            showResult(describeError(cause), true);
        }
    });

    document.querySelector('#btn-quit')?.addEventListener('click', async () => {
        try {
            await client.invoke(contract.system.quit);
        } catch {
            // 后端在该调用期间退出，这里 reject 属预期行为。
        }
    });
}

/** 把错误对象压缩为可展示的结构。 */
function describeError(cause: unknown): unknown {
    if (cause instanceof IpcError) {
        return { code: cause.code, message: cause.message, data: cause.data };
    }
    return { message: cause instanceof Error ? cause.message : String(cause) };
}

void main();
