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
        if (id.startsWith('.')) {
            const target = path.resolve(path.dirname(filename), `${id}.ts`);
            if (fs.existsSync(target)) return loadSource(target);
        }
        return sourceRequire(id);
    };
    new Function('require', 'module', 'exports', compiled)(requireSource, module, module.exports);
    return module.exports;
}

const { AstTranslator } = loadSource('src/utils/translator/core-ast-translator.ts');

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
