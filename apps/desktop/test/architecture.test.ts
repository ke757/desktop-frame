import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 架构守护测试：把 AGENTS.md 的分层约定固化为可执行断言。
 * 改动 src/main 结构前先跑这里——红了说明破坏了约定，不是测试的问题。
 *
 * 分层（见 docs/ARCHITECTURE.md）：
 * - core/api    模块作者公共 API（可依赖 spi，不依赖 kernel/ipc/deployment 实现）
 * - core/kernel 内核实现（DesktopApp/Builder/Container/Lifecycle）
 * - core/spi    宿主适配接缝（唯一允许被 electron 适配器实现的 core 面）
 * - core/ipc、core/deployment  框架实现
 * - electron    适配器 + 默认装配工厂（只依赖 core/api、core/spi）
 * - modules     业务模块（只走 core barrel；跨模块只允许对方 api.ts）
 * - main 根     组合根（index.ts）与窗口声明（windows.ts），唯一全开层
 */

const appRoot = path.resolve(__dirname, '../src/main');

/** 递归收集 main 下全部 .ts 源文件。 */
const sourceFiles = (() => {
    const result: string[] = [];
    const collect = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) collect(full);
            else if (entry.isFile() && entry.name.endsWith('.ts')) result.push(full);
        }
    };
    collect(appRoot);
    return result;
})();

interface ImportSpec {
    /** 源文件绝对路径。 */
    from: string;
    /** import 说明符原文（相对路径或包名）。 */
    spec: string;
}

/** 提取一个文件里的全部 import 说明符。 */
function importsOf(file: string): ImportSpec[] {
    const content = readFileSync(file, 'utf8');
    const specs: string[] = [];
    const fromClause = /(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g;
    const bareImport = /import\s+['"]([^'"]+)['"]/g;
    for (const match of content.matchAll(fromClause)) specs.push(match[1]);
    for (const match of content.matchAll(bareImport)) specs.push(match[1]);
    return specs.map((spec) => ({ from: file, spec }));
}

/** 相对 main 根的 POSIX 风格路径。 */
function rel(file: string): string {
    return path.relative(appRoot, file).split(path.sep).join('/');
}

/** 相对说明符解析到 main 根相对路径（扩展名可省略）。 */
function resolveSpec(source: string, spec: string): string | undefined {
    if (!spec.startsWith('.')) return undefined;
    const base = path.relative(appRoot, path.resolve(path.dirname(source), spec));
    return base.split(path.sep).join('/');
}

const allImports = sourceFiles.flatMap(importsOf);

describe('架构守护：core 分层', () => {
    it("core/** 不得 import 'electron'", () => {
        const violations = allImports.filter(
            ({ from, spec }) =>
                rel(from).startsWith('core/') && /^electron(\/|$)/.test(spec) === true,
        );
        expect(violations.map((v) => `${rel(v.from)} -> ${v.spec}`)).toEqual([]);
    });

    it('core/** 的相对 import 不得逃出 core/（含业务模块）', () => {
        const violations = allImports.filter(({ from, spec }) => {
            if (!rel(from).startsWith('core/')) return false;
            const target = resolveSpec(from, spec);
            return target !== undefined && !target.startsWith('core/');
        });
        expect(violations.map((v) => `${rel(v.from)} -> ${v.spec}`)).toEqual([]);
    });

    it('core/api/** 只依赖 api 内部、spi 与 contracts，不依赖 kernel/ipc/deployment 实现', () => {
        const violations = allImports.filter(({ from, spec }) => {
            if (!rel(from).startsWith('core/api/')) return false;
            const target = resolveSpec(from, spec);
            if (target === undefined) return false; // 外部包（contracts）允许。
            return (
                target.startsWith('core/kernel/') ||
                target.startsWith('core/ipc/') ||
                target.startsWith('core/deployment/') ||
                /^core\/[^/]+\.ts$/.test(target)
            );
        });
        expect(violations.map((v) => `${rel(v.from)} -> ${v.spec}`)).toEqual([]);
    });

    it('core/kernel/**、core/ipc/**、core/deployment/** 不得依赖 core/api 之外的实现捷径（实现互只走相对路径且不逃层）', () => {
        // 内核与实现层之间的依赖由"相对 import 不逃出 core + core 零 electron"
        // 约束；这里补一条：实现层不得反向把内部实现经 barrel 泄露（barrel
        // 只从 api 再导出，由 core/index.ts 内容守护）。
        const barrel = readFileSync(path.join(appRoot, 'core/index.ts'), 'utf8');
        const exported = [...barrel.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
            (match) => match[1],
        );
        expect(exported).toEqual(['./api']);
    });
});

describe('架构守护：electron 适配层', () => {
    it('electron/** 对 core 的 import 只允许 core/api/** 与 core/spi/**（app-factory 豁免：默认装配工厂可用 kernel/builder）', () => {
        const violations = allImports.filter(({ from, spec }) => {
            if (!rel(from).startsWith('electron/')) return false;
            const target = resolveSpec(from, spec);
            if (target === undefined) return false;
            if (!target.startsWith('core/')) return false;
            if (rel(from) === 'electron/app-factory.ts') {
                // 装配工厂是生产组合根入口：额外允许 kernel/builder。
                return (
                    target !== 'core/kernel/builder' &&
                    !target.startsWith('core/api/') &&
                    !target.startsWith('core/spi/')
                );
            }
            return !(
                target.startsWith('core/api/') ||
                target.startsWith('core/spi/') ||
                /^core\/api\.ts$/.test(target)
            );
        });
        expect(violations.map((v) => `${rel(v.from)} -> ${v.spec}`)).toEqual([]);
    });

    it('electron/** 不得 import 业务模块与组合根（electron/app-factory 只被组合根导入）', () => {
        const violations = allImports.filter(({ from, spec }) => {
            if (!rel(from).startsWith('electron/')) return false;
            const target = resolveSpec(from, spec);
            if (target === undefined) return false;
            return (
                target.startsWith('modules/') ||
                target === 'index' ||
                target === 'windows'
            );
        });
        expect(violations.map((v) => `${rel(v.from)} -> ${v.spec}`)).toEqual([]);
    });
});

describe('架构守护：modules 边界', () => {
    it('modules/** 不得 import 适配层、默认装配工厂与组合根', () => {
        const violations = allImports.filter(({ from, spec }) => {
            if (!rel(from).startsWith('modules/')) return false;
            const target = resolveSpec(from, spec);
            if (target === undefined) return false;
            return (
                target.startsWith('electron/') ||
                target === 'index' ||
                target === 'windows' ||
                target.startsWith('windows/')
            );
        });
        expect(violations.map((v) => `${rel(v.from)} -> ${v.spec}`)).toEqual([]);
    });

    it("modules/** 对 core 只允许经 barrel（'../../core'）导入", () => {
        const violations = allImports.filter(({ from, spec }) => {
            if (!rel(from).startsWith('modules/')) return false;
            const target = resolveSpec(from, spec);
            if (target === undefined) return false;
            // 允许：core barrel 本身；禁止：core 的任何深层路径。
            return target.startsWith('core/');
        });
        expect(violations.map((v) => `${rel(v.from)} -> ${v.spec}`)).toEqual([]);
    });

    it('跨模块 import 只允许指向对方 api.ts（模块目录即封装边界）', () => {
        const violations = allImports.filter(({ from, spec }) => {
            const sourceModule = rel(from).match(/^modules\/([^/]+)/)?.[1];
            if (!sourceModule) return false;
            const target = resolveSpec(from, spec);
            if (!target?.startsWith('modules/')) return false;
            const targetModule = target.match(/^modules\/([^/]+)/)?.[1];
            if (targetModule === sourceModule) return false;
            return path.basename(target) !== 'api';
        });
        expect(violations.map((v) => `${rel(v.from)} -> ${v.spec}`)).toEqual([]);
    });

    it('*.module.ts 只允许组合根（main/index.ts）导入', () => {
        const violations = allImports.filter(({ from, spec }) => {
            const target = resolveSpec(from, spec);
            return (
                target !== undefined &&
                target.endsWith('.module') &&
                rel(from) !== 'index.ts'
            );
        });
        expect(violations.map((v) => `${rel(v.from)} -> ${v.spec}`)).toEqual([]);
    });
});

describe('架构守护：组合根', () => {
    it('组合根（index.ts）不得被 main 内其他文件 import（进程壳在 main.ts，扫描范围外）', () => {
        const violations = allImports.filter(({ from, spec }) => {
            const target = resolveSpec(from, spec);
            return target === 'index' && rel(from) !== 'index.ts';
        });
        expect(violations.map((v) => `${rel(v.from)} -> ${v.spec}`)).toEqual([]);
    });
});
