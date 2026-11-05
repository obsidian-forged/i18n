import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import { transformSync } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loadedModules = new Map();
const jsx = (type, props) => ({ type, props });
const ui = Object.fromEntries([
    'Settings', 'FolderOpen', 'Pen', 'FileOutput', 'XCircle', 'Loader2',
    'MoreHorizontal', 'CloudDownload', 'Cloud', 'Button', 'Select',
    'SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue', 'Badge',
    'Tooltip', 'TooltipContent', 'TooltipProvider', 'TooltipTrigger', 'Separator',
    'DropdownMenu', 'DropdownMenuContent', 'DropdownMenuItem', 'DropdownMenuTrigger',
    'DropdownMenuSeparator', 'Dialog', 'DialogContent', 'DialogDescription',
    'DialogFooter', 'DialogHeader', 'DialogTitle'
].map((name) => [name, name]));
const react = {
    memo: (component) => component,
    useState: (initial) => [initial, () => {}],
    useMemo: (calculate) => calculate()
};

// 仅替换宿主和界面依赖；入口、译文读取、备份及状态持久化均加载真实源码。
function loadSource(relativePath) {
    const filename = path.resolve(projectRoot, relativePath);
    if (loadedModules.has(filename)) return loadedModules.get(filename).exports;
    const compiled = transformSync(fs.readFileSync(filename, 'utf8'), {
        loader: filename.endsWith('.tsx') ? 'tsx' : 'ts',
        format: 'cjs', target: 'node20', jsx: 'automatic'
    }).code;
    const sourceRequire = createRequire(filename);
    const module = { exports: {} };
    loadedModules.set(filename, module);
    const requireSource = (id) => {
        if (id === 'react') return react;
        if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
        if (id === 'react-i18next') return { useTranslation: () => ({ t: (key) => key }) };
        if (id === 'obsidian') return { debounce: (fn) => fn };
        if (id === '~/shadcn' || id === 'lucide-react') return ui;
        if (id === '~/shadcn/lib/utils') return { cn: (...values) => values.filter(Boolean).join(' ') };
        if (id === '~/utils') return { useGlobalStoreInstance: { getState: () => ({}) } };
        if (id === '../../../views') return { EDITOR_VIEW_TYPE: 'editor' };
        if (id === '../../../utils') return {
            AstTranslator: class {
                loadCode(code) { new Function(code); return code; }
                translate(code, entries) {
                    return entries.reduce((result, entry) => result.split(entry.source).join(entry.target), code);
                }
            },
            RegexTranslator: class {
                translate(code, entries) {
                    return entries.reduce((result, entry) => result.split(entry.source).join(entry.target), code);
                }
            }
        };
        if (id.startsWith('.')) {
            const target = path.resolve(path.dirname(filename), id);
            if (fs.existsSync(`${target}.ts`)) return loadSource(`${target}.ts`);
        }
        return sourceRequire(id);
    };
    new Function('require', 'module', 'exports', compiled)(requireSource, module, module.exports);
    return module.exports;
}

const { PluginItem } = loadSource('src/views/manager/components/plugin-item.tsx');
const { BackupManager } = loadSource('src/manager/backup-manager.ts');
const { StateManager } = loadSource('src/manager/state-manager.ts');
const { saveTranslationFile } = loadSource('src/manager/io-manager.ts');
const pluginId = 'manual-target';
const original = 'module.exports = { label: "English" };\n';

// 保留真实会话锁，只替换当前用例需要控制的备份操作。
function mockBackupSession(t, backup, override) {
    const withBackupSession = backup.withBackupSession.bind(backup);
    return t.mock.method(backup, 'withBackupSession', (id, operation) => (
        withBackupSession(id, (session) => operation({
            createBackup: (...args) => session.createBackup(...args),
            getBackupContent: (...args) => session.getBackupContent(...args),
            restoreBackup: (...args) => session.restoreBackup(...args),
            ...override(session)
        }))
    ));
}

function findActionButton(node, action) {
    if (Array.isArray(node)) return node.map((child) => findActionButton(child, action)).find(Boolean);
    if (!node || typeof node !== 'object') return undefined;
    if (node.type === 'Button' && [node.props.children].flat(Infinity).includes(`Manager.Common.Actions.${action}`)) {
        return node;
    }
    return findActionButton(node.props?.children, action);
}

function fixture(t, { loadSucceeds = false, isApplied = false, reloadSucceeds = true } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-manual-backup-test-'));
    t.after(() => fs.removeSync(root));
    const i18nDir = path.join(root, '.obsidian', 'plugins', 'i18n');
    const pluginDir = path.join(root, '.obsidian', 'plugins', pluginId);
    const mainPath = path.join(pluginDir, 'main.js');
    const statePath = path.join(i18nDir, 'states.json');
    const langDoc = path.join(root, 'translation.json');
    const plugin = { id: pluginId, name: '测试插件', version: '1.0.0', description: '', dir: `.obsidian/plugins/${pluginId}` };
    fs.ensureDirSync(pluginDir);
    fs.writeFileSync(mainPath, original);
    fs.writeJsonSync(path.join(pluginDir, 'manifest.json'), plugin);
    function writeTranslation(target = '中文', dict) {
        saveTranslationFile(langDoc, {
            schemaVersion: 1, metadata: { version: '1.0.0' },
            dict: dict || { 'main.js': { ast: [], regex: [{ source: 'English', target }] } }
        });
    }
    writeTranslation();
    const calls = { enable: [], disable: [], reload: [], notices: [], writes: [] };
    const i18n = {
        manifest: { dir: '.obsidian/plugins/i18n' }, settings: {}, sourceManager: {},
        app: {
            vault: { adapter: { getBasePath: () => root } },
            plugins: {
                enabledPlugins: new Set([pluginId]), plugins: {},
                enablePlugin: async (id) => {
                    calls.enable.push(id);
                    if (loadSucceeds) {
                        i18n.app.plugins.enabledPlugins.add(id);
                        i18n.app.plugins.plugins[id] = {};
                    }
                },
                disablePlugin: async (id) => {
                    calls.disable.push(id);
                    i18n.app.plugins.enabledPlugins.delete(id);
                    delete i18n.app.plugins.plugins[id];
                }
            }
        },
        notice: Object.fromEntries(['result', 'error', 'successPrefix'].map((kind) => [
            kind, (...args) => calls.notices.push({ kind, args })
        ]))
    };
    i18n.stateManager = new StateManager(i18n);
    i18n.stateManager.setPluginState(pluginId, {
        id: pluginId, isApplied, pluginVersion: '1.0.0', translationVersion: '0.9.0'
    });
    i18n.backupManager = new BackupManager(i18nDir);
    const initialState = fs.readFileSync(statePath, 'utf8');
    const writeFileSync = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (filename, ...args) => {
        if (path.dirname(filename) === pluginDir && filename.endsWith('.js')) calls.writes.push(filename);
        return writeFileSync.call(fs, filename, ...args);
    });
    const tree = PluginItem({
        plugin, i18n, settings: {}, isEnabled: true, viewMode: 'list',
        refreshParent: () => {},
        reloadPlugin: async (id) => {
            calls.reload.push(id);
            return reloadSucceeds;
        },
        close: () => {},
        data: {
            statusColor: 'bg-slate-500', statusText: '', statusDesc: '',
            isLangDoc: true, langDoc, pluginDir, sources: [], activeSourceId: null,
            translationFormatMark: true, mainDoc: mainPath,
            manifestDoc: path.join(pluginDir, 'manifest.json'), isApplied, isTranslated: true
        }
    });
    const applyButton = findActionButton(tree, 'Apply');
    const restoreButton = findActionButton(tree, 'Restore');
    if (isApplied) {
        assert.ok(restoreButton, '应从真实组件渲染树找到恢复按钮');
    } else {
        assert.ok(applyButton, '应从真实组件渲染树找到应用按钮');
    }
    return {
        i18n, calls, initialState, statePath, pluginDir, plugin, writeTranslation,
        writeSource: (file, content) => writeFileSync.call(fs, path.join(pluginDir, file), content),
        writeVersion: (version, content) => {
            plugin.version = version;
            fs.writeJsonSync(path.join(pluginDir, 'manifest.json'), plugin);
            writeFileSync.call(fs, mainPath, content);
        },
        readMain: () => fs.readFileSync(mainPath, 'utf8'),
        apply: () => applyButton.props.onClick(),
        restore: () => restoreButton.props.onClick()
    };
}

test('手动应用备份失败时不写源码、不改状态且不启停插件', async (t) => {
    const f = fixture(t);
    mockBackupSession(t, f.i18n.backupManager, () => ({ createBackup: async () => false }));
    await f.apply();
    assert.equal(f.readMain(), original);
    assert.deepEqual(f.calls.writes, []);
    assert.equal(fs.readFileSync(f.statePath, 'utf8'), f.initialState);
    assert.deepEqual(f.calls.enable, []);
    assert.deepEqual(f.calls.disable, []);
    assert.ok(f.calls.notices.some(({ kind, args }) => (
        kind === 'result' && args[0] === false && args[1].includes('Manager.Common.Errors.BackupFailed')
    )));
});

for (const [name, dict] of [
    ['空字典', {}],
    ['文件存在但两类规则均为空', { 'main.js': { ast: [], regex: [] } }],
    ['仅有未翻译或空译文条目', {
        'main.js': {
            ast: [{ type: 'StringLiteral', name: 'label', source: 'English', target: 'English' }],
            regex: [{ source: 'English', target: '' }]
        }
    }]
]) {
    test(`手动应用重新读取后拒绝${name}，不创建备份、不写入、不改状态且不重载`, async (t) => {
        const f = fixture(t, { loadSucceeds: true });
        // 模拟页面渲染后，云端更新或编辑使当前译文变为空内容。
        f.writeTranslation(undefined, dict);
        let createBackup;
        mockBackupSession(t, f.i18n.backupManager, (session) => {
            createBackup = t.mock.fn((...args) => session.createBackup(...args));
            return { createBackup };
        });

        await f.apply();

        assert.equal(createBackup.mock.callCount(), 0);
        assert.deepEqual(f.calls.writes, []);
        assert.equal(f.readMain(), original);
        assert.equal(fs.readFileSync(f.statePath, 'utf8'), f.initialState);
        assert.deepEqual(f.calls.disable, []);
        assert.deepEqual(f.calls.enable, []);
        assert.deepEqual(f.calls.reload, []);
    });
}

for (const kind of ['ast', 'regex']) {
    test(`手动应用允许仅含有效 ${kind} 译文的文件`, async (t) => {
        const f = fixture(t, { loadSucceeds: true });
        f.writeTranslation(undefined, {
            'main.js': {
                ast: [], regex: [],
                [kind]: [{ type: 'StringLiteral', name: 'label', source: 'English', target: '中文' }]
            }
        });

        await f.apply();

        assert.equal(f.readMain(), original.replace('English', '中文'));
        assert.equal(f.i18n.stateManager.getPluginState(pluginId).isApplied, true);
        assert.deepEqual(f.calls.disable, [pluginId]);
        assert.deepEqual(f.calls.enable, [pluginId]);
    });
}

test('手动应用加载失败且恢复失败时保留状态、不再次启用插件', async (t) => {
    const f = fixture(t);
    const restore = t.mock.fn(async () => false);
    mockBackupSession(t, f.i18n.backupManager, () => ({ restoreBackup: restore }));
    const deletion = t.mock.method(f.i18n.stateManager, 'deletePluginState');
    await f.apply();
    assert.equal(f.readMain(), original.replace('English', '中文'));
    assert.equal(restore.mock.callCount(), 1);
    assert.equal(deletion.mock.callCount(), 0);
    assert.equal(f.i18n.stateManager.getPluginState(pluginId).isApplied, true);
    assert.equal(fs.readJsonSync(f.statePath).plugins[pluginId].isApplied, true);
    assert.deepEqual(f.calls.enable, [pluginId]);
    assert.deepEqual(f.calls.disable, [pluginId]);
    assert.ok(f.calls.notices.some(({ kind, args }) => (
        kind === 'result' && args[0] === false && args[1].includes('Manager.Common.Errors.RestoreFailed')
    )));
});

test('手动应用准备第二个文件失败时不写入任何目标文件', async (t) => {
    const f = fixture(t, { loadSucceeds: true });
    const secondOriginal = 'module.exports = { label: "Second English" };\n';
    f.writeSource('second.js', secondOriginal);
    f.writeTranslation(undefined, {
        'main.js': { ast: [], regex: [{ source: 'English', target: '中文' }] },
        'second.js': { ast: [], regex: [{ source: 'English', target: '中文' }] }
    });
    const reads = [];
    mockBackupSession(t, f.i18n.backupManager, (session) => ({
        getBackupContent: async (file, dir) => {
            reads.push(file);
            if (file === 'second.js') throw new Error('injected second backup read failure');
            return session.getBackupContent(file, dir);
        }
    }));
    await f.apply();
    assert.deepEqual(reads, ['main.js', 'second.js']);
    assert.deepEqual(f.calls.writes, []);
    assert.equal(f.readMain(), original);
    assert.equal(fs.readFileSync(path.join(f.pluginDir, 'second.js'), 'utf8'), secondOriginal);
    assert.equal(fs.readFileSync(f.statePath, 'utf8'), f.initialState);
    assert.equal(f.i18n.stateManager.getPluginState(pluginId).isApplied, false);
    assert.deepEqual(f.calls.enable, []);
    assert.deepEqual(f.calls.disable, []);
    assert.equal(f.i18n.backupManager.hasBackup(pluginId), true);
    assert.ok(f.calls.notices.some(({ kind, args }) => (
        kind === 'result' && args[0] === false && args[1].includes('injected second backup read failure')
    )));
});

test('手动同版本重复应用从备份原文翻译，恢复得到最初原文', async (t) => {
    const f = fixture(t, { loadSucceeds: true });
    await f.apply();
    assert.equal(f.readMain(), original.replace('English', '中文'));
    f.writeTranslation('第二份译文');
    await f.apply();
    assert.equal(f.readMain(), original.replace('English', '第二份译文'));
    assert.equal(f.i18n.stateManager.getPluginState(pluginId).isApplied, true);
    assert.equal(await f.i18n.backupManager.restoreBackup(pluginId, f.pluginDir), true);
    assert.equal(f.readMain(), original);
    assert.equal(f.calls.notices.some(({ kind, args }) => kind === 'result' && args[0] === false), false);
});

test('手动升级后使用新版源码翻译，恢复保留新版新增功能', async (t) => {
    const f = fixture(t, { loadSucceeds: true });
    await f.apply();
    assert.equal(f.readMain(), original.replace('English', '中文'));
    const upgraded = 'module.exports = { version: "2.0.0", newFeature: true, label: "English" };\n';
    f.writeVersion('2.0.0', upgraded);
    await f.apply();
    assert.equal(f.readMain(), upgraded.replace('English', '中文'));
    assert.equal(f.i18n.stateManager.getPluginState(pluginId).pluginVersion, '2.0.0');
    assert.equal(await f.i18n.backupManager.restoreBackup(pluginId, f.pluginDir), true);
    assert.equal(f.readMain(), upgraded);
    assert.equal(f.calls.notices.some(({ kind, args }) => kind === 'result' && args[0] === false), false);
});

test('手动恢复文件后重载返回 false 时报告重载失败，不发送成功通知', { timeout: 5000 }, async (t) => {
    const f = fixture(t, { isApplied: true, reloadSucceeds: false });
    assert.equal(await f.i18n.backupManager.createBackup(pluginId, f.pluginDir, ['main.js']), true);
    f.writeSource('main.js', original.replace('English', '中文'));
    f.i18n.app.plugins.plugins[pluginId] = {};

    await f.restore();

    assert.deepEqual(f.calls.reload, [pluginId]);
    assert.equal(f.readMain(), original);
    assert.equal(f.i18n.stateManager.getPluginState(pluginId), undefined);
    assert.equal(fs.readJsonSync(f.statePath).plugins[pluginId], undefined);
    assert.equal(f.i18n.backupManager.hasBackup(pluginId), false);
    assert.equal(f.calls.notices.some(({ kind, args }) => kind === 'result' && args[0] === true), false);
    assert.equal(f.calls.notices.some(({ kind }) => kind === 'successPrefix'), false);
    assert.ok(f.calls.notices.some(({ kind, args }) => (
        kind === 'result' && args[0] === false && args[1].includes('Manager.Common.Errors.RestoredReloadFailed')
    )));
});
