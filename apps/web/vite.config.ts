import { defineConfig } from 'vite';

export default defineConfig({
    // 相对 base：保证产物在应用内以 file:// 加载时资源路径可用。
    base: './',
    server: {
        port: 5173,
        // 固定端口：主进程按约定等待该地址，端口漂移会导致加载失败。
        strictPort: true,
    },
    build: {
        // 产物直接输出到 desktop 应用内，由 forge 打包
        //（见 apps/desktop/forge.config.mts 的 prePackage 钩子）。
        outDir: '../desktop/web',
        emptyOutDir: true,
    },
});
