import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, optimize } from '@tailwindcss/node';
import { transform } from 'lightningcss';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filename = path.join(projectRoot, 'src/styles.css');
const candidates = [
    'flex', 'h-full', 'border', 'p-4', 'bg-background', 'text-foreground',
    'bg-popover', 'text-popover-foreground', 'dark:bg-input/30',
    'data-[state=open]:animate-in', 'font-sans', 'font-mono'
];

// 读取真实入口并沿用生产 CLI 的编译、优化接口，不读取可能过期的构建产物。
const compiler = await compile(await fs.readFile(filename, 'utf8'), {
    base: path.dirname(filename), from: filename, onDependency() {}
});
const css = optimize(compiler.build(candidates), { file: filename, minify: true }).code;
const rules = [];
transform({
    filename, code: Buffer.from(css),
    visitor: { Rule: { style({ value }) { rules.push(value); } } }
});

function declarations(rule) {
    return [...rule.declarations.declarations, ...rule.declarations.importantDeclarations];
}

function property(declaration) {
    if (declaration.property === 'custom') return declaration.value.name;
    if (declaration.property === 'unparsed') return declaration.value.propertyId.property;
    return declaration.property;
}

// :not()、:has() 内出现插件名不能限制目标元素；:is()、:where() 的每个分支均须受限。
function isScoped(selector) {
    return selector.some((part) => (
        (part.type === 'class' && part.name.startsWith('i18n-')) ||
        (part.type === 'id' && part.name.startsWith('immersive-translate-')) ||
        (part.type === 'pseudo-class' && (
            part.kind === 'host' || part.kind === 'host-context' ||
            (['is', 'where'].includes(part.kind) && part.selectors.length > 0 &&
                part.selectors.every(isScoped))
        ))
    ));
}

function contains(value, predicate) {
    if (!value || typeof value !== 'object') return false;
    return predicate(value) || Object.values(value).some((child) => contains(child, predicate));
}

function isDark(part) {
    return part.type === 'class' && ['dark', 'theme-dark', 'i18n-ui-dark'].includes(part.name);
}

function utilityRules(name) {
    return rules.filter((rule) => contains(rule.selectors, (part) => (
        part.type === 'class' && part.name === name
    )));
}

function usesVariable(declaration, name) {
    return contains(declaration, (value) => value.type === 'var' && value.value.name.ident === name);
}

function assertNoLeaks(predicate) {
    const leaks = rules.flatMap((rule) => {
        const properties = declarations(rule).map(property).filter(predicate);
        return properties.length === 0 ? [] : rule.selectors.filter((selector) => !isScoped(selector))
            .map((selector) => ({ selector, properties, line: rule.loc.line }));
    });
    assert.equal(leaks.length, 0, `发现 ${leaks.length} 个未隔离的选择器分支：\n${
        JSON.stringify(leaks.slice(0, 6), null, 2)
    }`);
}

test('编译后的普通样式仅影响插件界面和沉浸式翻译控件', () => {
    assertNoLeaks((name) => !name.startsWith('--'));
});

test('主题变量不会写入宿主根节点或全局暗色主题', () => {
    // Tailwind 自身生成的属性初始化不改变宿主元素的常规样式。
    assertNoLeaks((name) => name.startsWith('--') && !name.startsWith('--tw-'));
});

test('界面和代码字体使用 Obsidian 设置，暗色主题不覆盖字体映射', () => {
    for (const [token, source] of [
        ['--font-sans', '--font-interface'],
        ['--font-serif', '--font-interface'],
        ['--font-mono', '--font-monospace']
    ]) {
        const definitions = rules.flatMap((rule) => declarations(rule)
            .filter((declaration) => property(declaration) === token));
        assert.ok(definitions.length > 0, `${token} 必须在插件作用域中定义`);
        assert.ok(definitions.every((declaration) => usesVariable(declaration, source)),
            `${token} 的所有定义（含暗色覆盖）必须引用 ${source}`);
    }
    for (const [candidate, token] of [
        ['font-sans', '--font-sans'], ['font-mono', '--font-mono']
    ]) {
        assert.ok(utilityRules(candidate).some((rule) => declarations(rule).some((declaration) => (
            property(declaration) === 'font-family' && usesVariable(declaration, token)
        ))), `${candidate} 必须通过字体变量应用用户设置`);
    }
});

test('隔离后保留视图、Portal、暗色和展开动画需要的样式', () => {
    assert.ok(rules.some((rule) => rule.selectors.some(isScoped) && declarations(rule).some(
        (declaration) => property(declaration) === 'box-sizing' && declaration.value === 'border-box'
    )), '插件内部必须保留 border-box 布局基线');
    const expected = [
        ['flex', 'display'], ['h-full', 'height'], ['border', 'border-width'],
        ['p-4', 'padding', '--spacing'],
        ['bg-background', 'background-color', '--background'],
        ['text-foreground', 'color', '--foreground'],
        ['bg-popover', 'background-color', '--popover'],
        ['text-popover-foreground', 'color', '--popover-foreground'],
        ['dark:bg-input/30', 'background-color', '--input'],
        ['data-[state=open]:animate-in', 'animation']
    ];
    for (const [candidate, name, variable] of expected) {
        assert.ok(utilityRules(candidate).some((rule) => declarations(rule).some((declaration) => (
            property(declaration) === name && (!variable || usesVariable(declaration, variable))
        ))), `${candidate} 缺少 ${name}${variable ? ` 或 ${variable} 引用` : ''}`);
    }
    assert.ok(utilityRules('dark:bg-input/30').some((rule) => contains(rule.selectors, isDark)),
        '暗色工具类必须保留主题条件');
    assert.ok(utilityRules('data-[state=open]:animate-in').some((rule) => contains(
        rule.selectors, (part) => part.type === 'attribute' && part.name === 'data-state' &&
            part.operation?.operator === 'equal' && part.operation.value === 'open'
    )), '展开动画必须保留 data-state=open 条件');

    for (const name of ['--background', '--foreground']) {
        const values = (dark) => rules.filter((rule) => (
            rule.selectors.some((selector) => isScoped(selector) && contains(selector, isDark) === dark)
        )).flatMap((rule) => declarations(rule).filter((declaration) => property(declaration) === name)
            .map((declaration) => JSON.stringify(declaration.value)));
        const light = values(false);
        const dark = values(true);
        assert.ok(light.length > 0 && dark.length > 0, `${name} 必须保留局部亮色和暗色定义`);
        assert.ok(light.some((value) => dark.some((other) => other !== value)),
            `${name} 的亮色和暗色值应不同`);
    }
});

test('Shadow DOM 宿主自身保留暗色变量覆盖', () => {
    for (const name of ['--background', '--foreground']) {
        const values = (dark) => rules.filter((rule) => rule.selectors.some((selector) => (
            !selector.some((part) => part.type === 'combinator') && selector.some((part) => (
                part.type === 'pseudo-class' && part.kind === 'host' &&
                (dark ? contains(part.selectors, (item) => item.type === 'class' &&
                    item.name === 'i18n-ui-dark') : part.selectors === null)
            ))
        ))).flatMap((rule) => declarations(rule).filter((declaration) => property(declaration) === name)
            .map((declaration) => JSON.stringify(declaration.value)));
        const light = values(false);
        const dark = values(true);
        assert.ok(light.length > 0 && dark.length > 0, `宿主自身必须定义亮色和暗色 ${name}`);
        assert.ok(dark.some((value) => light.every((other) => other !== value)),
            `宿主暗色 ${name} 必须覆盖亮色值`);
    }
});
