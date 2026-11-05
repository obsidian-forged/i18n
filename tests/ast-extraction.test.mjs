import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadSource(relativePath) {
    const filename = path.resolve(projectRoot, relativePath);
    const compiled = transformSync(fs.readFileSync(filename, 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'node20'
    }).code;
    const sourceRequire = createRequire(filename);
    const module = { exports: {} };
    const requireSource = (id) => {
        // 合并测试不访问生成译文时使用的全局状态。
        if (id === '~/utils') return {};
        if (id.startsWith('.')) {
            const target = path.resolve(path.dirname(filename), `${id}.ts`);
            if (fs.existsSync(target)) return loadSource(target);
            const index = path.resolve(path.dirname(filename), id, 'index.ts');
            if (fs.existsSync(index)) return loadSource(index);
        }
        return sourceRequire(id);
    };
    new Function('require', 'module', 'exports', compiled)(requireSource, module, module.exports);
    return module.exports;
}

const { AstTranslator } = loadSource('src/utils/translator/core-ast-translator.ts');
const { mergeAstItems } = loadSource('src/utils/translator/translation.ts');

function extractSources(code) {
    const translator = new AstTranslator({});
    const ast = translator.loadCode(code);
    assert.ok(ast);
    return translator.extract(ast).map((item) => item.source).sort();
}

test('创建设置元素时只提取内容，不把 article 和 option 标签当成文案', () => {
    assert.deepEqual(extractSources(`
        container.createEl('article', { text: 'Homepage settings' });
        select.createEl('option', { text: 'Open the daily note' });
    `), ['Homepage settings', 'Open the daily note']);
});

test('createEl 模板标签不参与提取，内容选项仍保留插值文案', () => {
    assert.deepEqual(extractSources('container.createEl(`article`, { text: `Settings for ${name}` });'), [
        'Settings for ${name}'
    ]);
});

test('其他白名单调用继续提取与 HTML 标签同名的可见文案', () => {
    assert.deepEqual(extractSources(`
        setting.setName('article');
        setting.setDesc('Select an option');
        container.createDiv({ text: 'Daily note settings' });
        new Notice('Pick a file');
    `), ['Daily note settings', 'Pick a file', 'Select an option', 'article']);
});

test('从设置文案调用识别完整本地化字典，支持动态键和占位符替换', () => {
    assert.deepEqual(extractSources(`
        const english = {
            startupText: 'Open on startup',
            startupDetails: 'When launching Obsidian, open the homepage.',
            modeText: 'Opening method'
        };
        const languages = { en: english, ru: { startupText: 'Открывать при запуске' } };
        const unrelated = { privateValue: 'Do not extract this configuration' };
        let selected;
        function tr(key, ...replacements) {
            key = selected?.[key] || english[key];
            let index = 0;
            for (const replacement of replacements) key = key.replace('?' + index++, replacement);
            return key;
        }
        function render(settingKey) { setting.setName(tr(settingKey)).setDesc(tr(settingKey + 'Details')); }
    `), ['Open on startup', 'Opening method', 'When launching Obsidian, open the homepage.']);
});

test('直接返回查找结果时识别静态英文回退字典', () => {
    assert.deepEqual(extractSources(`
        const languages = {
            en: { startupText: 'Open on startup', modeText: 'Opening method' },
            ru: { startupText: 'Открывать при запуске' }
        };
        function tr(key) { return selected?.[key] || languages.en[key]; }
        setting.setName(tr(dynamicKey));
    `), ['Open on startup', 'Opening method']);
});

test('局部同名参数不会关联到外部本地化函数', () => {
    assert.deepEqual(extractSources(`
        const english = { startupText: 'Open on startup' };
        const languages = { en: english, ru: { startupText: 'Открывать при запуске' } };
        function tr(key) { return english[key]; }
        function render(tr) { setting.setName(tr(dynamicKey)); }
    `), []);
});

test('读取配置但不返回查找结果时不扩展提取范围', () => {
    assert.deepEqual(extractSources(`
        const configuration = { privateValue: 'Do not extract this configuration' };
        function read(key) { const value = configuration[key]; return key; }
        setting.setName(read(dynamicKey));
    `), []);
});

test('字典结果被无关内容覆盖后不视为本地化返回值', () => {
    assert.deepEqual(extractSources(`
        const english = { startupText: 'Open on startup' };
        const languages = { en: english, ru: { startupText: 'Открывать при запуске' } };
        function tr(key) { key = english[key]; key = unknownValue; return key; }
        setting.setName(tr(dynamicKey));
    `), []);
});

test('不将混合类型配置或未用于设置文案的字符串表识别为字典', () => {
    assert.deepEqual(extractSources(`
        const configuration = { privateValue: 'Do not extract this configuration', enabled: true };
        const english = { startupText: 'Open on startup' };
        const languages = { en: english, ru: { startupText: 'Открывать при запуске' } };
        function read(key) { return configuration[key]; }
        function tr(key) { return english[key]; }
        setting.setName(read(dynamicKey));
        fetch(tr(dynamicKey));
    `), []);
});

test('字典提取继续使用原有内容过滤规则', () => {
    assert.deepEqual(extractSources(`
        const english = { startupText: 'Open on startup', endpoint: 'https://example.invalid', selector: '.internal-ui' };
        const languages = { en: english, ru: { startupText: 'Открывать при запуске' } };
        const tr = (key) => english[key];
        setting.setName(tr(dynamicKey));
    `), ['Open on startup']);
});

test('普通字符串配置表的查询函数不会扩大提取范围', () => {
    assert.deepEqual(extractSources(`
        const configuration = { selectedMode: 'Dark color scheme', densityMode: 'Compact mode' };
        function read(key) { return configuration[key]; }
        setting.setName(read(dynamicKey));
    `), []);
});

test('本地化译文只修改字典值，保留同文的查询键和选项值', () => {
    const translator = new AstTranslator({});
    const code = `
        const english = { 'Replace all open notes': 'Replace all open notes' };
        const languages = { en: english, ru: { 'Replace all open notes': 'Заменить все заметки' } };
        function tr(key) { return english[key]; }
        const stableKey = 'Replace all open notes';
        setting.setName(tr(stableKey));
        setting.addOption(stableKey, tr(stableKey));
    `;
    const ast = translator.loadCode(code);
    const entries = translator.extract(ast).map((item) => ({ ...item, target: '替换全部打开的笔记' }));
    assert.deepEqual(entries.map((item) => item.type), ['LocalizationProperty']);
    assert.deepEqual([...translator.traceUsage(ast, entries)], [
        'LocalizationProperty:Replace all open notes:Replace all open notes'
    ]);
    const observed = {};
    const output = translator.translate(ast, entries);
    assert.ok(translator.loadCode(output));
    new Function('setting', output)({
        setName(value) { observed.name = value; },
        addOption(value, label) { observed.option = { value, label }; }
    });
    assert.deepEqual(observed, {
        name: '替换全部打开的笔记',
        option: { value: 'Replace all open notes', label: '替换全部打开的笔记' }
    });
});

test('原有 AST 条目的宽松匹配仍然生效', () => {
    const translator = new AstTranslator({});
    const ast = translator.loadCode(`const description = 'Original description'; setting.setText('Original description');`);
    const entries = [{ type: 'VariableDeclarator', name: 'description', source: 'Original description', target: '原有描述' }];
    assert.equal(translator.traceUsage(ast, entries).has('Original description'), true);
    let observed;
    new Function('setting', translator.translate(ast, entries))({ setText(value) { observed = value; } });
    assert.equal(observed, '原有描述');
});

for (const change of ['english.startupText = unknownValue;', 'mutate(english);']) {
    test(`英文对象可被修改或逃逸时不扩展提取：${change}`, () => {
        assert.deepEqual(extractSources(`
            const english = { startupText: 'Open on startup' };
            const languages = { en: english, ru: { startupText: 'Открывать при запуске' } };
            ${change}
            function tr(key) { return english[key]; }
            setting.setName(tr(dynamicKey));
        `), []);
    });
}

test('嵌套函数的返回语句不改变本地化函数自身的返回值分析', () => {
    assert.deepEqual(extractSources(`
        const english = { startupText: 'Open on startup' };
        const languages = { en: english, ru: { startupText: 'Открывать при запуске' } };
        function tr(key) { function unused() { return 'Unrelated output'; } return english[key]; }
        setting.setName(tr(dynamicKey));
    `), ['Open on startup']);
});

for (const operator of ['||', '??']) {
    test(`不可达的字典回退不参与识别：${operator}`, () => {
        assert.deepEqual(extractSources(`
            const english = { startupText: 'Open on startup' };
            const languages = { en: english, ru: { startupText: 'Открывать при запуске' } };
            function tr(key) { return 'Unrelated output' ${operator} english[key]; }
            setting.setName(tr(dynamicKey));
        `), []);
    });
}

test('本地化严格译文优先于同文的普通宽松译文，使用追踪保持一致', () => {
    const translator = new AstTranslator({});
    const code = `
        const english = { startupText: 'Open on startup' };
        const languages = { en: english, ru: { startupText: 'Открывать при запуске' } };
        function tr(key) { return english[key]; }
        setting.setName(tr('startupText'));
        setting.setText('Open on startup');
    `;
    const ast = translator.loadCode(code);
    const entries = [
        { type: 'LocalizationProperty', name: 'startupText', source: 'Open on startup', target: '启动时打开' },
        { type: 'VariableDeclarator', name: 'originalText', source: 'Open on startup', target: '普通节点译文' }
    ];
    assert.deepEqual([...translator.traceUsage(ast, entries)].sort(), [
        'LocalizationProperty:startupText:Open on startup', 'Open on startup'
    ]);
    const observed = {};
    new Function('setting', translator.translate(ast, entries))({
        setName(value) { observed.name = value; },
        setText(value) { observed.text = value; }
    });
    assert.deepEqual(observed, { name: '启动时打开', text: '普通节点译文' });
});

test('真实增量合并的新未翻译条目不会覆盖旧有效译文或把旧条目标为未使用', () => {
    const translator = new AstTranslator({});
    const ast = translator.loadCode(`
        const english = { startupText: 'Open on startup' };
        const languages = { en: english, ru: { startupText: 'Открывать при запуске' } };
        function tr(key) { return english[key]; }
        setting.setName(tr('startupText'));
    `);
    const existing = [{ type: 'ObjectProperty', name: 'startupText', source: 'Open on startup', target: '原有启动译文' }];
    const entries = mergeAstItems(existing, translator.extract(ast));
    assert.deepEqual(entries.map((item) => item.type), ['ObjectProperty', 'LocalizationProperty']);
    const hits = translator.traceUsage(ast, entries);
    assert.equal(hits.has('ObjectProperty:startupText:Open on startup'), true);
    let observed;
    new Function('setting', translator.translate(ast, entries))({ setName(value) { observed = value; } });
    assert.equal(observed, '原有启动译文');
});

for (const setup of [
    `const english = { startupText: 'Open on startup' }; mutate({ en: english, ru: {} });`,
    `const english = { startupText: 'Open on startup' }; const languages = { en: english, ru: {} }; mutate(languages.en);`,
    `const english = { startupText: 'Open on startup' }; const languages = { en: english, ru: {} }; ({ x: english.startupText } = input);`,
    `const english = { startupText: 'Open on startup' }; const languages = { en: english, ru: {} }; const alias = languages.en; alias.startupText = unknownValue;`
]) {
    test(`目录逃逸、别名或解构写入时不识别静态字典：${setup}`, () => {
        assert.deepEqual(extractSources(`${setup} function tr(key) { return english[key]; } setting.setName(tr(dynamicKey));`), []);
    });
}
