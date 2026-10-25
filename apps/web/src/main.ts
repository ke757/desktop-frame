import './styles.css';
import {
    appEvents,
    contract,
    createClient,
    getDesktopBridge,
    IpcError,
    type DeploymentStatus,
    type LifecycleState,
    type SearchResponse,
    type SettingsFile,
    type SystemInfo,
} from '@desktop-frame/contracts';

/**
 * 最小演示界面：覆盖全部 IPC 面——invoke（查询、变更、对话框、错误信封）
 * 与类型化事件订阅，外加外部服务控制面（部署状态面板）与搜索适配层示例。
 * 刻意不依赖 UI 框架；换成 React/Vue 不需要动契约。
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
        <h2>Deployments (external services control plane)</h2>
        <ul class="deployment-list" id="deployment-list"></ul>
        <p class="note" id="deployment-note"></p>
      </section>
      <section class="card">
        <h2>Search (external domain service via adapter)</h2>
        <div class="row">
          <input id="search-input" type="text" placeholder="query the external search service…" />
          <button id="btn-search">Search</button>
        </div>
        <ul class="log" id="search-hits"></ul>
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

/** 渲染单个部署行（或按 id 更新已有行）。 */
function renderDeployment(status: DeploymentStatus): void {
    const list = document.querySelector<HTMLUListElement>('#deployment-list');
    if (!list) return;
    let row = list.querySelector<HTMLLIElement>(`[data-id="${status.id}"]`);
    if (!row) {
        row = document.createElement('li');
        row.dataset.id = status.id;
        const label = document.createElement('span');
        label.className = 'deployment-id';
        const badge = document.createElement('span');
        badge.className = 'badge deployment-state';
        const note = document.createElement('span');
        note.className = 'note deployment-note';
        const restart = document.createElement('button');
        restart.className = 'deployment-restart';
        restart.textContent = 'Restart';
        restart.addEventListener('click', () => {
            void restartDeployment(status.id);
        });
        row.append(label, badge, note, restart);
        list.append(row);
    }
    const label = row.querySelector<HTMLElement>('.deployment-id');
    if (label) label.textContent = status.id;
    const badge = row.querySelector<HTMLElement>('.deployment-state');
    if (badge) {
        badge.dataset.state = status.state;
        badge.textContent = status.state;
    }
    const note = row.querySelector<HTMLElement>('.deployment-note');
    if (note) {
        const parts = [status.mode, status.baseUrl];
        if (status.pid !== null) parts.push(`pid ${status.pid}`);
        if (status.detail) parts.push(status.detail);
        note.textContent = parts.join(' · ');
    }
}

/** 渲染部署面板说明（dev 下提示手动启动 fixture 的方式）。 */
function setDeploymentNote(text: string): void {
    const note = document.querySelector<HTMLElement>('#deployment-note');
    if (note) note.textContent = text;
}

/** 拉取并渲染全部部署状态。 */
async function refreshDeployments(
    client: ReturnType<typeof createClient>,
): Promise<void> {
    try {
        for (const status of await client.invoke(contract.deployments.list)) {
            renderDeployment(status);
        }
    } catch (cause) {
        const described = describeError(cause) as { message?: string };
        setDeploymentNote(`failed to list deployments: ${described.message ?? cause}`);
    }
}

/** 请求重启一个部署（结果经 deploymentChanged 事件回流界面）。 */
async function restartDeployment(id: string): Promise<void> {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    const client = createClient(bridge);
    try {
        renderDeployment(await client.invoke(contract.deployments.restart, { id }));
        logEvent(`deployment ${id} restarted`);
    } catch (cause) {
        logEvent(
            `deployment ${id} restart failed: ${JSON.stringify(describeError(cause))}`,
        );
    }
}

/** 渲染搜索命中列表。 */
function renderSearchResults(result: SearchResponse): void {
    const target = document.querySelector<HTMLUListElement>('#search-hits');
    if (!target) return;
    target.innerHTML = '';
    if (result.hits.length === 0) {
        const empty = document.createElement('li');
        empty.textContent = '(no hits)';
        target.append(empty);
        return;
    }
    for (const hit of result.hits) {
        const item = document.createElement('li');
        const time = document.createElement('time');
        time.textContent = hit.title;
        item.append(time, document.createTextNode(`score ${hit.score.toFixed(2)}`));
        target.append(item);
    }
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
    client.on(appEvents.deploymentChanged, ({ deployment }) => {
        renderDeployment(deployment);
        logEvent(`deployment ${deployment.id} → ${deployment.state}`);
    });
    client.on(appEvents.searchIndexChanged, ({ at }) => {
        logEvent(`search index updated (${new Date(at).toLocaleTimeString()})`);
    });

    // 控制面面板：初始快照 + 事件增量更新。
    await refreshDeployments(client);
    setDeploymentNote(
        'dev: the search service runs in external mode — start it with ' +
            '`node apps/desktop/test/fixtures/echo-service.mjs` and watch it turn running.',
    );

    // 搜索演示：走适配层代理调用外部领域服务。
    const searchInput = document.querySelector<HTMLInputElement>('#search-input');
    const runSearch = async (): Promise<void> => {
        const query = searchInput?.value.trim();
        if (!query) return;
        try {
            renderSearchResults(await client.invoke(contract.search.query, { query }));
        } catch (cause) {
            const described = describeError(cause) as { code?: string; message?: string };
            logEvent(
                `search failed: ${described.code ?? ''} ${described.message ?? cause}`,
            );
        }
    };
    document
        .querySelector('#btn-search')
        ?.addEventListener('click', () => void runSearch());
    searchInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') void runSearch();
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
