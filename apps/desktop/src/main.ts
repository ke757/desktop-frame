import { app } from 'electron';
import started from 'electron-squirrel-startup';
import { runDesktopApp } from './app';

// Windows Squirrel 安装器在安装/卸载时会为处理快捷方式拉起应用一次，此时直接退出。
if (started) {
    app.quit();
} else {
    runDesktopApp();
}
