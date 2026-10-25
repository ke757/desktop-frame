import { exec as execCallback } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const exec = promisify(execCallback);
const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(desktopDir, '../web');

const config: ForgeConfig = {
    packagerConfig: {
        asar: true,
        // vite 插件默认的 ignore 只保留 `.vite/**`；这里额外放行预构建的
        // web 产物（见 prePackage 钩子）。node_modules 的裁剪不走此函数。
        ignore: (file: string) => {
            if (file === '' || file === '/package.json') return false;
            return !(file.startsWith('/.vite') || file.startsWith('/web'));
        },
    },
    rebuildConfig: {},
    makers: [
        new MakerSquirrel({}),
        new MakerZIP({}, ['darwin']),
        new MakerRpm({}),
        new MakerDeb({}),
    ],
    plugins: [
        new VitePlugin({
            // renderer 是独立的 apps/web 项目：dev 由主进程加载其
            // dev server（WEB_DEV_SERVER_URL，默认 http://localhost:5173），
            // 打包则加载 `web/` 下的预构建产物。
            build: [
                {
                    entry: 'src/main.ts',
                    config: 'vite.main.config.mts',
                    target: 'main',
                },
                {
                    entry: 'src/preload.ts',
                    config: 'vite.preload.config.mts',
                    target: 'preload',
                },
            ],
            renderer: [],
        }),
        new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true,
        }),
    ],
    hooks: {
        // 在 vite 插件清空并重建 `.vite/` 之前运行；web 产物输出到 `web/`，
        // 不受 .vite 清空影响，且被上面的 ignore 白名单保留进 asar。
        prePackage: async () => {
            await exec('pnpm run build', { cwd: webDir });
        },
    },
};

export default config;
