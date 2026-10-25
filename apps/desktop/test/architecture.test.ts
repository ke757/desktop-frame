import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 架构守护测试：把 AGENTS.md 的分层约定固化为可执行断言。
 * 改动 src/main 结构前先跑这里——红了说明破坏了约定，不是测试的问题。
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

describe('架构守护：core 与 ports', () => {
    it("core/** 不得 import 'electron'", () => {
        const violations = allImports.filter(
            ({ from, spec }) =>
                rel(from).startsWith('core/') && /^electron(\/|$)/.test(spec) === true,
        );
        expect(violations.map((v) => `${rel(v.from)} -> ${v.spec}`)).toEqual([]);
    });

    it('core/** 的相对 import 不得逃出 core/', () => {
        const violations = allImports.filter(({ from, spec }) => {
            if (!rel(from).startsWith('core/')) return false;
            const target = resolveSpec(from, spec);
            return target !== undefined && !target.startsWith('core/');
        });
        expect(violations.map((v) => `${rel(v.from)} -> ${v.spec}`)).toEqual([]);
    });

    it('ports/** 只依赖 ports（不得 import core 实现侧文件）', () => {
        const violations = allImports.filter(({ from, spec }) => {
            if (!rel(from).startsWith('core/ports/')) return false;
            const target = resolveSpec(from, spec);
            return target !== undefined && !target.startsWith('core/ports/');
        });
        expect(violations.map((v) => `${rel(v.from)} -> ${v.spec}`)).toEqual([]);
    });
});

describe('架构守护：modules 边界', () => {
    it('modules/** 不得 import 适配层与装配层（../electron、../index、../windows）', () => {
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

    it('跨模块 import 只允许指向 *.service.ts / *.module.ts / *.tokens.ts', () => {
        const violations = allImports.filter(({ from, spec }) => {
            const sourceModule = rel(from).match(/^modules\/([^/]+)/)?.[1];
            if (!sourceModule) return false;
            const target = resolveSpec(from, spec);
            if (!target?.startsWith('modules/')) return false;
            const targetModule = target.match(/^modules\/([^/]+)/)?.[1];
            if (targetModule === sourceModule) return false;
            const basename = path.basename(target);
            return !/\.(service|module|tokens)$/.test(basename);
        });
        expect(violations.map((v) => `${rel(v.from)} -> ${v.spec}`)).toEqual([]);
    });
});

describe('架构守护：electron 适配层', () => {
    it('electron/** 对 core 的 import 只允许指向 core/ports/**（端口镜像）', () => {
        const violations = allImports.filter(({ from, spec }) => {
            if (!rel(from).startsWith('electron/')) return false;
            const target = resolveSpec(from, spec);
            if (target === undefined) return false;
            if (!target.startsWith('core/')) return false;
            return !target.startsWith('core/ports/');
        });
        expect(violations.map((v) => `${rel(v.from)} -> ${v.spec}`)).toEqual([]);
    });
});
