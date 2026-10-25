import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventPublisherImpl } from '../src/main/core/ipc/events';
import { MemoryLogger } from '../src/main/core/logging';
import { SettingsServiceImpl } from '../src/main/modules/settings/settings.service';

/** 每个用例创建的临时目录，结束后统一清理。 */
let dirs: string[] = [];

/** 创建一次性临时目录。 */
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'df-settings-'));
    dirs.push(dir);
    return dir;
}

afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs = [];
});

/** 构造 SettingsService 及记录事件出口的假 sink。 */
function createService(filePath: string) {
    const logger = new MemoryLogger();
    const sink = { sent: [] as unknown[] };
    const events = new EventPublisherImpl(
        {
            send: (_channel: string, payload: unknown) => {
                sink.sent.push(payload);
            },
        },
        logger,
    );
    return { service: new SettingsServiceImpl(filePath, logger, events), sink };
}

describe('SettingsService', () => {
    it('文件不存在时回退到 schema 默认值', async () => {
        const dir = await tempDir();
        const { service } = createService(path.join(dir, 'settings.json'));
        await service.load();
        expect(service.get()).toEqual({
            theme: 'system',
            locale: 'en-US',
            launchCount: 0,
        });
    });

    it('加载并校验已存在的文件', async () => {
        const dir = await tempDir();
        const filePath = path.join(dir, 'settings.json');
        await writeFile(
            filePath,
            JSON.stringify({ theme: 'dark', launchCount: 3 }),
            'utf8',
        );

        const { service } = createService(filePath);
        await service.load();
        expect(service.get()).toEqual({
            theme: 'dark',
            locale: 'en-US',
            launchCount: 3,
        });
    });

    it('文件损坏时使用默认值', async () => {
        const dir = await tempDir();
        const filePath = path.join(dir, 'settings.json');
        await writeFile(filePath, '{ not json', 'utf8');

        const { service } = createService(filePath);
        await service.load();
        expect(service.get().theme).toBe('system');
    });

    it('合并补丁、广播变更事件并在 dispose 时落盘', async () => {
        const dir = await tempDir();
        const filePath = path.join(dir, 'settings.json');
        const { service, sink } = createService(filePath);
        await service.load();

        const updated = service.update({ theme: 'dark' });
        expect(updated.theme).toBe('dark');
        expect(updated.launchCount).toBe(0);
        expect(sink.sent).toHaveLength(1);

        await service.dispose();
        const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
            theme: string;
        };
        expect(persisted.theme).toBe('dark');
    });

    it('dispose 后新实例可完整读回数据', async () => {
        const dir = await tempDir();
        const filePath = path.join(dir, 'settings.json');

        const first = createService(filePath);
        await first.service.load();
        first.service.update({ launchCount: 7, locale: 'zh-CN' });
        await first.service.dispose();

        const second = createService(filePath);
        await second.service.load();
        expect(second.service.get()).toEqual({
            theme: 'system',
            locale: 'zh-CN',
            launchCount: 7,
        });
    });
});
