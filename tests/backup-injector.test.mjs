import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import fs from 'fs-extra';
import { transformSync } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loadedModules = new Map();

// 仅替换宿主 API 和通知文案，备份、状态持久化及译文读取均使用真实代码。
function loadSource(relativePath) {
    const filename = path.resolve(projectRoot, relativePath);
    if (loadedModules.has(filename)) return loadedModules.get(filename).exports;
    const compiled = transformSync(fs.readFileSync(filename, 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'node20'
    }).code;
    const sourceRequire = createRequire(filename);
    const module = { exports: {} };
    loadedModules.set(filename, module);
    const requireSource = (id) => {
        if (id === 'obsidian') return { debounce: (fn) => fn };
        if (id === '../locales') return { t: (key) => key };
        if (id.startsWith('.')) {
            const target = path.resolve(path.dirname(filename), id);
            if (fs.existsSync(`${target}.ts`)) return loadSource(`${target}.ts`);
        }
        return sourceRequire(id);
    };
    new Function('require', 'module', 'exports', compiled)(requireSource, module, module.exports);
    return module.exports;
}

const { BackupManager } = loadSource('src/manager/backup-manager.ts');
const { InjectorManager } = loadSource('src/manager/injector.ts');
const { StateManager } = loadSource('src/manager/state-manager.ts');

const pluginId = 'target-plugin';
const originalV1 = 'module.exports = { version: "1.0.0", label: "English" };\n';
const originalV2 = 'module.exports = { version: "2.0.0", newFeature: true, label: "English" };\n';

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

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-backup-test-'));
    t.after(() => fs.removeSync(root));
    const i18nDir = path.join(root, '.obsidian', 'plugins', 'i18n');
    const pluginDir = path.join(root, '.obsidian', 'plugins', pluginId);
    fs.ensureDirSync(i18nDir);
    fs.ensureDirSync(pluginDir);
    const manifests = {
        [pluginId]: { id: pluginId, name: pluginId, version: '1.0.0', dir: `.obsidian/plugins/${pluginId}` }
    };
    const enabledPlugins = new Set();
    const notices = [];
    const translationInputs = [];
    const sourcePaths = new Map();
    const app = {
        vault: { configDir: '.obsidian', adapter: { getBasePath: () => root } },
        plugins: {
            manifests, enabledPlugins,
            disablePlugin: async (id) => { enabledPlugins.delete(id); },
            enablePlugin: async (id) => { enabledPlugins.add(id); }
        }
    };
    const i18n = {
        app, manifest: { dir: '.obsidian/plugins/i18n' },
        settings: { automaticUpdate: true },
        sourceManager: { getActiveSourcePath: (id) => sourcePaths.get(id) },
        notice: Object.fromEntries(['successPrefix', 'warning', 'error', 'success', 'info'].map((kind) => [
            kind, (...args) => notices.push({ kind, args })
        ])),
        coreManager: {
            getAstTranslator: () => ({ loadCode: (code) => code, translate: (code) => code }),
            getRegexTranslator: () => ({
                translate: (code, entries) => {
                    translationInputs.push(code);
                    return entries.reduce((result, entry) => result.split(entry.source).join(entry.target), code);
                }
            })
        }
    };
    i18n.stateManager = new StateManager(i18n);
    i18n.backupManager = new BackupManager(i18nDir, (id) => {
        const state = i18n.stateManager.getPluginState(id) || i18n.stateManager.getThemeState(id);
        return state?.isApplied ? state.pluginVersion : undefined;
    });
    const injector = new InjectorManager(i18n);
    function writeVersion(version, content) {
        manifests[pluginId].version = version;
        fs.writeJsonSync(path.join(pluginDir, 'manifest.json'), manifests[pluginId]);
        fs.writeFileSync(path.join(pluginDir, 'main.js'), content);
    }
    function writeTranslation(target = '中文', id = pluginId, dict) {
        const sourcePath = path.join(root, `${id}.json`);
        fs.writeJsonSync(sourcePath, {
            schemaVersion: 1, metadata: { version: '1.0.0' },
            dict: dict || { 'main.js': { ast: [], regex: [{ source: 'English', target }] } }
        });
        sourcePaths.set(id, sourcePath);
    }
    function setApplied(version = '1.0.0') {
        i18n.stateManager.setPluginState(pluginId, {
            id: pluginId, isApplied: true, pluginVersion: version, translationVersion: '1.0.0'
        });
    }
    writeVersion('1.0.0', originalV1);
    writeTranslation();
    return {
        root, pluginDir, app, i18n, injector, notices, translationInputs,
        backup: i18n.backupManager, writeVersion, writeTranslation, setApplied,
        readMain: () => fs.readFileSync(path.join(pluginDir, 'main.js'), 'utf8')
    };
}

test('智能更新基于新版源码汉化，恢复仍得到新版源码', async (t) => {
    const f = fixture(t);
    assert.equal(await f.injector.applyToPlugin(pluginId), true);
    f.writeVersion('2.0.0', originalV2);
    await f.injector.run(f.app);
    assert.equal(f.readMain(), originalV2.replace('English', '中文'));
    assert.equal(f.i18n.stateManager.getPluginState(pluginId).pluginVersion, '2.0.0');
    assert.equal(await f.backup.restoreBackup(pluginId, f.pluginDir), true);
    assert.equal(f.readMain(), originalV2);
});

test('先校准状态也不会把未标记版本的旧快照当作新版源码', async (t) => {
    const f = fixture(t);
    const backupPath = path.join(f.backup.getPluginBackupDir(pluginId), 'main.js.gz');
    fs.outputFileSync(backupPath, gzipSync(originalV1));
    f.setApplied();
    f.writeVersion('2.0.0', originalV2);
    await f.i18n.stateManager.validateVersions(f.app);
    assert.equal(f.i18n.stateManager.getPluginState(pluginId).isApplied, false);
    assert.equal(f.i18n.stateManager.getPluginState(pluginId).pluginVersion, '2.0.0');
    assert.equal(await f.injector.applyToPlugin(pluginId), true);
    assert.equal(f.readMain(), originalV2.replace('English', '中文'));
    assert.equal(await f.backup.restoreBackup(pluginId, f.pluginDir), true);
    assert.equal(f.readMain(), originalV2);
});

test('恢复旧版本快照时拒绝覆盖已安装的新版插件', async (t) => {
    const f = fixture(t);
    assert.equal(await f.backup.createBackup(pluginId, f.pluginDir, ['main.js']), true);
    f.writeVersion('2.0.0', originalV2);
    assert.equal(await f.backup.restoreBackup(pluginId, f.pluginDir), false);
    assert.equal(f.readMain(), originalV2);
    assert.equal(f.backup.hasBackup(pluginId), true);
});

test('跨版本重建快照后恢复不会复活新版已移除的文件', async (t) => {
    const f = fixture(t);
    const removedPath = path.join(f.pluginDir, 'removed.js');
    fs.writeFileSync(removedPath, 'only exists in version one');
    assert.equal(await f.backup.createBackup(pluginId, f.pluginDir, ['main.js', 'removed.js']), true);
    f.setApplied();
    f.writeVersion('2.0.0', originalV2);
    fs.removeSync(removedPath);
    await f.injector.run(f.app);
    assert.equal(f.readMain(), originalV2.replace('English', '中文'));
    assert.equal(fs.existsSync(removedPath), false);
    assert.equal(await f.backup.restoreBackup(pluginId, f.pluginDir), true);
    assert.equal(f.readMain(), originalV2);
    assert.equal(fs.existsSync(removedPath), false);
});

test('同版本重复应用始终从原文翻译，恢复后原文不变', async (t) => {
    const f = fixture(t);
    assert.equal(await f.injector.applyToPlugin(pluginId), true);
    f.writeTranslation('第二份译文');
    assert.equal(await f.injector.applyToPlugin(pluginId), true);
    assert.deepEqual(f.translationInputs, [originalV1, originalV1]);
    assert.equal(f.readMain(), originalV1.replace('English', '第二份译文'));
    assert.equal(await f.backup.restoreBackup(pluginId, f.pluginDir), true);
    assert.equal(f.readMain(), originalV1);
});

test('备份返回失败时注入器不写目标、不翻译也不更新状态', async (t) => {
    const f = fixture(t);
    mockBackupSession(t, f.backup, () => ({ createBackup: async () => false }));
    assert.equal(await f.injector.applyToPlugin(pluginId), false);
    assert.equal(f.readMain(), originalV1);
    assert.deepEqual(f.translationInputs, []);
    assert.equal(f.i18n.stateManager.getPluginState(pluginId), undefined);
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
    test(`注入器拒绝${name}，不创建备份、不写入、不改状态且不重载`, async (t) => {
        const f = fixture(t);
        f.app.plugins.enabledPlugins.add(pluginId);
        f.setApplied();
        const initialState = f.i18n.stateManager.getPluginState(pluginId);
        f.writeTranslation(undefined, pluginId, dict);
        let createBackup;
        mockBackupSession(t, f.backup, (session) => {
            createBackup = t.mock.fn((...args) => session.createBackup(...args));
            return { createBackup };
        });
        const write = t.mock.method(fs, 'writeFileSync');
        const state = t.mock.method(f.i18n.stateManager, 'setPluginState');
        const disable = t.mock.method(f.app.plugins, 'disablePlugin');
        const enable = t.mock.method(f.app.plugins, 'enablePlugin');

        assert.equal(await f.injector.applyToPlugin(pluginId), false);

        assert.equal(createBackup.mock.callCount(), 0);
        assert.equal(write.mock.callCount(), 0);
        assert.equal(state.mock.callCount(), 0);
        assert.deepEqual(f.i18n.stateManager.getPluginState(pluginId), initialState);
        assert.equal(disable.mock.callCount(), 0);
        assert.equal(enable.mock.callCount(), 0);
        assert.deepEqual(f.translationInputs, []);
        assert.equal(f.readMain(), originalV1);
    });
}

for (const kind of ['ast', 'regex']) {
    test(`注入器允许仅含有效 ${kind} 译文的文件`, async (t) => {
        const f = fixture(t);
        f.writeTranslation(undefined, pluginId, {
            'main.js': {
                ast: [], regex: [],
                [kind]: [{ type: 'StringLiteral', name: 'label', source: 'English', target: '中文' }]
            }
        });
        if (kind === 'ast') {
            t.mock.method(f.i18n.coreManager, 'getAstTranslator', () => ({
                loadCode: (code) => code,
                translate: (code, entries) => entries.reduce((result, entry) => result.split(entry.source).join(entry.target), code)
            }));
        }

        assert.equal(await f.injector.applyToPlugin(pluginId), true);

        assert.equal(f.readMain(), originalV1.replace('English', '中文'));
        assert.equal(f.i18n.stateManager.getPluginState(pluginId).isApplied, true);
    });
}

test('自动应用准备第二个文件失败时不写入任何目标文件', async (t) => {
    const f = fixture(t);
    const mainPath = path.join(f.pluginDir, 'main.js');
    const secondPath = path.join(f.pluginDir, 'second.js');
    const secondOriginal = 'module.exports = { label: "Second English" };\n';
    fs.writeFileSync(secondPath, secondOriginal);
    f.writeTranslation(undefined, pluginId, {
        'main.js': { ast: [], regex: [{ source: 'English', target: '中文' }] },
        'second.js': { ast: [], regex: [{ source: 'English', target: '中文' }] }
    });
    const writes = [];
    const writeFileSync = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (filename, ...args) => {
        if (filename === mainPath || filename === secondPath) writes.push(filename);
        return writeFileSync.call(fs, filename, ...args);
    });
    mockBackupSession(t, f.backup, (session) => ({
        getBackupContent: async (file, dir) => {
            if (file === 'second.js') throw new Error('injected second backup read failure');
            return session.getBackupContent(file, dir);
        }
    }));
    assert.equal(await f.injector.applyToPlugin(pluginId), false);
    assert.deepEqual(f.translationInputs, [originalV1]);
    assert.deepEqual(writes, []);
    assert.equal(f.readMain(), originalV1);
    assert.equal(fs.readFileSync(secondPath, 'utf8'), secondOriginal);
    assert.equal(f.i18n.stateManager.getPluginState(pluginId), undefined);
    assert.equal(f.backup.hasBackup(pluginId), true);
});

test('备份目录位置是普通文件时不能将其当作有效快照', async (t) => {
    const f = fixture(t);
    fs.writeFileSync(f.backup.getPluginBackupDir(pluginId), 'occupied');
    assert.equal(f.backup.hasBackup(pluginId), false);
    assert.equal(await f.backup.createBackup(pluginId, f.pluginDir, ['main.js']), false);
    assert.equal(f.readMain(), originalV1);
    assert.equal(fs.readFileSync(f.backup.getPluginBackupDir(pluginId), 'utf8'), 'occupied');
});

test('新版快照创建中途失败时保留原有完整快照', async (t) => {
    const f = fixture(t);
    assert.equal(await f.backup.createBackup(pluginId, f.pluginDir, ['main.js']), true);
    f.writeVersion('2.0.0', originalV2);
    fs.ensureDirSync(path.join(f.pluginDir, 'unreadable.js'));
    assert.equal(await f.backup.createBackup(pluginId, f.pluginDir, ['main.js', 'unreadable.js']), false);
    assert.equal(await f.backup.getBackupContent(pluginId, 'main.js'), originalV1);
    assert.equal(f.readMain(), originalV2);
});

test('快照元数据写入失败时保留旧快照并清理未完成的临时文件', async (t) => {
    const f = fixture(t);
    assert.equal(await f.backup.createBackup(pluginId, f.pluginDir, ['main.js']), true);
    f.writeVersion('2.0.0', originalV2);
    const originalWriteJson = fs.writeJson;
    fs.writeJson = async (filename, ...args) => {
        if (path.basename(filename) === '.backup-info.json') throw new Error('injected metadata write failure');
        return originalWriteJson(filename, ...args);
    };
    try {
        assert.equal(await f.backup.createBackup(pluginId, f.pluginDir, ['main.js']), false);
    } finally {
        fs.writeJson = originalWriteJson;
    }
    assert.equal(await f.backup.getBackupContent(pluginId, 'main.js'), originalV1);
    assert.equal(f.readMain(), originalV2);
    const entries = fs.readdirSync(path.dirname(f.backup.getPluginBackupDir(pluginId)));
    assert.equal(entries.some((entry) => entry.startsWith('.snapshot-')), false);
});

test('并发创建新版快照时复用首份原文，不把已汉化文件存为原文', { timeout: 5000 }, async (t) => {
    const f = fixture(t);
    assert.equal(await f.backup.createBackup(pluginId, f.pluginDir, ['main.js']), true);
    f.writeVersion('2.0.0', originalV2);
    const mainPath = path.join(f.pluginDir, 'main.js');
    const originalReadFile = fs.readFile;
    let notifyFirstRead;
    const firstRead = new Promise((resolve) => { notifyFirstRead = resolve; });
    let releaseFirstRead;
    const firstReadReleased = new Promise((resolve) => { releaseFirstRead = resolve; });
    let sourceReads = 0;
    fs.readFile = async (filename, ...args) => {
        if (filename !== mainPath) return originalReadFile(filename, ...args);
        sourceReads++;
        if (sourceReads === 1) {
            const content = await originalReadFile(filename, ...args);
            notifyFirstRead();
            await firstReadReleased;
            return content;
        }
        // 若第二个操作绕过锁读取目标，就会把译文错误地备份为原文。
        return Buffer.from(originalV2.replace('English', '中文'));
    };
    try {
        const first = f.backup.createBackup(pluginId, f.pluginDir, ['main.js']);
        await firstRead;
        const second = f.backup.createBackup(pluginId, f.pluginDir, ['main.js']);
        fs.writeFileSync(mainPath, originalV2.replace('English', '中文'));
        await new Promise((resolve) => setImmediate(resolve));
        releaseFirstRead();
        assert.deepEqual(await Promise.all([first, second]), [true, true]);
    } finally {
        releaseFirstRead();
        fs.readFile = originalReadFile;
    }
    assert.equal(sourceReads, 1);
    assert.equal(await f.backup.getBackupContent(pluginId, 'main.js', f.pluginDir), originalV2);
    assert.equal(await f.backup.restoreBackup(pluginId, f.pluginDir), true);
    assert.equal(f.readMain(), originalV2);
});

test('临时快照切换失败时旧快照与版本信息复位', async (t) => {
    const f = fixture(t);
    assert.equal(await f.backup.createBackup(pluginId, f.pluginDir, ['main.js']), true);
    f.writeVersion('2.0.0', originalV2);
    const originalRename = fs.rename;
    let injected = false;
    fs.rename = async (source, destination, ...args) => {
        if (!injected && destination === f.backup.getPluginBackupDir(pluginId)
            && path.basename(source).startsWith('.snapshot-') && !source.endsWith('.previous')) {
            injected = true;
            throw new Error('injected snapshot rename failure');
        }
        return originalRename(source, destination, ...args);
    };
    try {
        assert.equal(await f.backup.createBackup(pluginId, f.pluginDir, ['main.js']), false);
    } finally {
        fs.rename = originalRename;
    }
    assert.equal(injected, true);
    assert.equal(f.readMain(), originalV2);
    assert.equal(await f.backup.getBackupContent(pluginId, 'main.js'), originalV1);
    assert.equal(fs.readJsonSync(path.join(f.backup.getPluginBackupDir(pluginId), '.backup-info.json')).version, '1.0.0');
    const entries = fs.readdirSync(path.dirname(f.backup.getPluginBackupDir(pluginId)));
    assert.equal(entries.some((entry) => entry.startsWith('.snapshot-')), false);
});

test('旧备份版本标记写入失败时不校准内存或磁盘状态', async (t) => {
    const f = fixture(t);
    const legacyPath = f.backup.getLegacyBackupPath(pluginId);
    fs.writeFileSync(legacyPath, gzipSync(originalV1));
    f.setApplied();
    f.writeVersion('2.0.0', originalV2);
    const originalOutputJson = fs.outputJson;
    fs.outputJson = async (filename, ...args) => {
        if (path.basename(filename) === '.backup-info.json') throw new Error('injected legacy version write failure');
        return originalOutputJson(filename, ...args);
    };
    try {
        await assert.rejects(() => f.i18n.stateManager.validateVersions(f.app), /injected legacy version write failure/);
    } finally {
        fs.outputJson = originalOutputJson;
    }
    const state = f.i18n.stateManager.getPluginState(pluginId);
    assert.equal(state.isApplied, true);
    assert.equal(state.pluginVersion, '1.0.0');
    const persistedState = fs.readJsonSync(path.join(f.root, '.obsidian/plugins/i18n/states.json')).plugins[pluginId];
    assert.deepEqual(persistedState, state);
    assert.equal(fs.existsSync(legacyPath), true);
    assert.equal(f.readMain(), originalV2);
});

for (const compressed of [true, false]) {
    test(`旧单文件 ${compressed ? '.js.gz' : '.js'} 备份迁移时保留同版本原文`, async (t) => {
        const f = fixture(t);
        f.setApplied();
        const legacyPath = compressed ? f.backup.getLegacyBackupPath(pluginId) : f.backup.getLegacyUncompressedBackupPath(pluginId);
        fs.writeFileSync(legacyPath, compressed ? gzipSync(originalV1) : originalV1);
        fs.writeFileSync(path.join(f.pluginDir, 'main.js'), originalV1.replace('English', '旧译文'));
        assert.equal(await f.backup.createBackup(pluginId, f.pluginDir, ['main.js']), true);
        assert.equal(await f.backup.getBackupContent(pluginId, 'main.js', f.pluginDir), originalV1);
        assert.equal(await f.backup.restoreBackup(pluginId, f.pluginDir), true);
        assert.equal(f.readMain(), originalV1);
    });
}

test('无法判断版本的旧备份拒绝用于恢复且保留备份', async (t) => {
    const f = fixture(t);
    const legacyPath = f.backup.getLegacyBackupPath(pluginId);
    fs.writeFileSync(legacyPath, gzipSync('unknown old version'));
    const content = await f.backup.getBackupContent(pluginId, 'main.js', f.pluginDir).catch(() => null);
    assert.equal(content, null);
    assert.equal(await f.backup.restoreBackup(pluginId, f.pluginDir), false);
    assert.equal(f.readMain(), originalV1);
    assert.equal(fs.existsSync(legacyPath), true);
});

test('未应用状态的当前版本不能证明未知旧备份属于当前版本', async (t) => {
    const f = fixture(t);
    const legacyPath = f.backup.getLegacyBackupPath(pluginId);
    fs.writeFileSync(legacyPath, gzipSync(originalV1));
    f.writeVersion('2.0.0', originalV2);
    const state = { id: pluginId, isApplied: false, pluginVersion: '2.0.0', translationVersion: '1.0.0' };
    f.i18n.stateManager.setPluginState(pluginId, state);
    assert.equal(await f.injector.applyToPlugin(pluginId), false);
    assert.equal(f.readMain(), originalV2);
    assert.deepEqual(f.translationInputs, []);
    assert.deepEqual(f.i18n.stateManager.getPluginState(pluginId), state);
    assert.equal(fs.existsSync(legacyPath), true);
    assert.equal(fs.existsSync(path.join(f.backup.getPluginBackupDir(pluginId), '.backup-info.json')), false);
});

test('多文件快照含损坏 gzip 时不部分恢复且保留所有备份', async (t) => {
    const f = fixture(t);
    const secondPath = path.join(f.pluginDir, 'z-last.js');
    fs.writeFileSync(secondPath, 'second original');
    assert.equal(await f.backup.createBackup(pluginId, f.pluginDir, ['main.js', 'z-last.js']), true);
    fs.writeFileSync(path.join(f.backup.getPluginBackupDir(pluginId), 'z-last.js.gz'), 'broken gzip');
    fs.writeFileSync(path.join(f.pluginDir, 'main.js'), 'current main');
    fs.writeFileSync(secondPath, 'current second');
    assert.equal(await f.backup.restoreBackup(pluginId, f.pluginDir), false);
    assert.equal(f.readMain(), 'current main');
    assert.equal(fs.readFileSync(secondPath, 'utf8'), 'current second');
    assert.equal(fs.existsSync(path.join(f.backup.getPluginBackupDir(pluginId), 'main.js.gz')), true);
    assert.equal(fs.readFileSync(path.join(f.backup.getPluginBackupDir(pluginId), 'z-last.js.gz'), 'utf8'), 'broken gzip');
});

test('旧格式清理失败时连续恢复仍只使用新版快照并保留版本信息', async (t) => {
    const f = fixture(t);
    f.writeVersion('2.0.0', originalV2);
    assert.equal(await f.backup.createBackup(pluginId, f.pluginDir, ['main.js']), true);
    f.setApplied('2.0.0');
    const legacyPath = f.backup.getLegacyBackupPath(pluginId);
    fs.writeFileSync(legacyPath, gzipSync(originalV1));
    fs.writeFileSync(path.join(f.pluginDir, 'main.js'), originalV2.replace('English', '中文'));
    const originalRemove = fs.remove;
    fs.remove = async (filename, ...args) => {
        if (filename === legacyPath) throw new Error('injected legacy cleanup failure');
        return originalRemove(filename, ...args);
    };
    try {
        for (let attempt = 0; attempt < 2; attempt++) {
            assert.equal(await f.backup.restoreBackup(pluginId, f.pluginDir), false);
            assert.equal(f.readMain(), originalV2);
            assert.equal(fs.existsSync(path.join(f.backup.getPluginBackupDir(pluginId), '.backup-info.json')), true);
            assert.equal(await f.backup.getBackupContent(pluginId, 'main.js', f.pluginDir), originalV2);
            assert.equal(fs.existsSync(legacyPath), true);
        }
    } finally {
        fs.remove = originalRemove;
    }
});

test('重载失败而恢复成功时清除已应用状态并报告回滚', async (t) => {
    const f = fixture(t);
    f.app.plugins.enabledPlugins.add(pluginId);
    let enableCalls = 0;
    f.app.plugins.enablePlugin = async (id) => {
        if (++enableCalls === 1) throw new Error('translated plugin load failed');
        f.app.plugins.enabledPlugins.add(id);
    };
    await assert.rejects(() => f.injector.applyToPlugin(pluginId), /ROLLBACK_TRIGGERED/);
    assert.equal(f.readMain(), originalV1);
    assert.equal(f.i18n.stateManager.getPluginState(pluginId), undefined);
    assert.equal(enableCalls, 2);
    assert.equal(f.notices.some(({ args }) => args.includes('Manager.Common.Notices.RollbackSuccess')), true);
});

test('重载及恢复均失败时不报告回滚成功，保留状态与备份', async (t) => {
    const f = fixture(t);
    f.app.plugins.enabledPlugins.add(pluginId);
    f.app.plugins.enablePlugin = async () => { throw new Error('translated plugin load failed'); };
    mockBackupSession(t, f.backup, () => ({ restoreBackup: async () => false }));
    const result = await f.injector.applyToPlugin(pluginId).catch((error) => error);
    assert.notEqual(result, true);
    if (result instanceof Error) assert.doesNotMatch(result.message, /^ROLLBACK_TRIGGERED$/);
    assert.equal(f.readMain(), originalV1.replace('English', '中文'));
    assert.equal(f.i18n.stateManager.getPluginState(pluginId).isApplied, true);
    assert.equal(f.backup.hasBackup(pluginId), true);
    assert.equal(f.notices.some(({ args }) => args.includes('Manager.Common.Notices.RollbackSuccess')), false);
});

test('主题备份失败时不写 CSS 也不更新状态', async (t) => {
    const f = fixture(t);
    const themeId = 'test-theme';
    const themeDir = path.join(f.root, '.obsidian', 'themes', themeId);
    const themeCss = '/* @settings\nname: English\n*/\nbody { color: red; }\n';
    fs.ensureDirSync(themeDir);
    fs.writeJsonSync(path.join(themeDir, 'manifest.json'), { version: '1.0.0' });
    fs.writeFileSync(path.join(themeDir, 'theme.css'), themeCss);
    f.writeTranslation(undefined, themeId, [{ type: 'name', source: 'English', target: '中文' }]);
    mockBackupSession(t, f.backup, () => ({ createBackup: async () => false }));
    assert.equal(await f.injector.applyToTheme(themeId), false);
    assert.equal(fs.readFileSync(path.join(themeDir, 'theme.css'), 'utf8'), themeCss);
    assert.equal(f.i18n.stateManager.getThemeState(themeId), undefined);
});

test('并发应用等待前一次重载及回滚结束，后一次成功不会被前一次回滚撤销', { timeout: 5000 }, async (t) => {
    const f = fixture(t);
    const firstLoadStarted = deferred();
    const releaseFirstLoad = deferred();
    const events = [];
    let snapshots = 0;
    let enableCalls = 0;
    let second;
    f.app.plugins.enabledPlugins.add(pluginId);
    f.writeTranslation('第一次译文');
    mockBackupSession(t, f.backup, (session) => ({
        createBackup: (...args) => {
            snapshots++;
            return session.createBackup(...args);
        }
    }));
    f.app.plugins.enablePlugin = async (id) => {
        enableCalls++;
        if (enableCalls === 1) {
            events.push('first-load-started');
            firstLoadStarted.resolve();
            await releaseFirstLoad.promise;
            events.push('first-load-failed');
            throw new Error('injected first translation load failure');
        }
        f.app.plugins.enabledPlugins.add(id);
        events.push(enableCalls === 2 ? 'original-enabled' : 'second-enabled');
    };
    const first = f.injector.applyToPlugin(pluginId).catch((error) => error);
    try {
        await firstLoadStarted.promise;
        f.writeTranslation('第二次译文');
        second = f.injector.applyToPlugin(pluginId);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(snapshots, 1, '后一次应用不得在前一次重载期间创建快照');
        assert.equal(enableCalls, 1);
        assert.deepEqual(f.translationInputs, [originalV1]);
        assert.equal(f.readMain(), originalV1.replace('English', '第一次译文'));

        releaseFirstLoad.resolve();
        const [firstResult, secondResult] = await Promise.all([first, second]);
        assert.match(firstResult.message, /^ROLLBACK_TRIGGERED$/);
        assert.equal(secondResult, true);
        assert.deepEqual(events, ['first-load-started', 'first-load-failed', 'original-enabled', 'second-enabled']);
        assert.equal(snapshots, 2);
        assert.deepEqual(f.translationInputs, [originalV1, originalV1]);
        assert.equal(f.readMain(), originalV1.replace('English', '第二次译文'));
        assert.equal(f.i18n.stateManager.getPluginState(pluginId).isApplied, true);
        assert.equal(f.app.plugins.enabledPlugins.has(pluginId), true);
        assert.equal(await f.backup.getBackupContent(pluginId, 'main.js', f.pluginDir), originalV1);
        assert.equal(await f.backup.restoreBackup(pluginId, f.pluginDir), true);
        assert.equal(f.readMain(), originalV1);
    } finally {
        releaseFirstLoad.resolve();
        await Promise.allSettled([first, second].filter(Boolean));
    }
});

for (const phase of ['preparation', 'reload']) {
    test(`应用${phase === 'preparation' ? '准备文件' : '重载'}期间排队恢复等待完整操作，随后恢复原文并清理状态`, { timeout: 5000 }, async (t) => {
        const f = fixture(t);
        const applyBlocked = deferred();
        const releaseApply = deferred();
        const events = [];
        let enableCalls = 0;
        let restoreStarted = false;
        let restoration;
        f.app.plugins.enabledPlugins.add(pluginId);
        if (phase === 'preparation') {
            mockBackupSession(t, f.backup, (session) => ({
                getBackupContent: async (...args) => {
                    const content = await session.getBackupContent(...args);
                    applyBlocked.resolve();
                    await releaseApply.promise;
                    return content;
                }
            }));
        }
        f.app.plugins.enablePlugin = async (id) => {
            enableCalls++;
            if (enableCalls === 1 && phase === 'reload') {
                applyBlocked.resolve();
                await releaseApply.promise;
            }
            f.app.plugins.enabledPlugins.add(id);
            events.push(enableCalls === 1 ? 'apply-enabled' : 'restore-enabled');
        };
        const application = f.injector.applyToPlugin(pluginId);
        try {
            await applyBlocked.promise;
            restoration = f.backup.withBackupSession(pluginId, async (backup) => {
                restoreStarted = true;
                events.push('restore-started');
                assert.equal(f.i18n.stateManager.getPluginState(pluginId).isApplied, true);
                assert.equal(f.app.plugins.enabledPlugins.has(pluginId), true);
                const restored = await backup.restoreBackup(f.pluginDir);
                if (restored) {
                    f.i18n.stateManager.deletePluginState(pluginId);
                    await f.app.plugins.disablePlugin(pluginId);
                    await f.app.plugins.enablePlugin(pluginId);
                }
                return restored;
            });
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(restoreStarted, false, '恢复不得提前进入会话并消费备份');
            assert.equal(f.backup.hasBackup(pluginId), true);
            assert.equal(f.readMain(), phase === 'preparation' ? originalV1 : originalV1.replace('English', '中文'));

            releaseApply.resolve();
            assert.deepEqual(await Promise.all([application, restoration]), [true, true]);
            assert.deepEqual(events, ['apply-enabled', 'restore-started', 'restore-enabled']);
            assert.equal(f.readMain(), originalV1);
            assert.equal(f.i18n.stateManager.getPluginState(pluginId), undefined);
            assert.equal(fs.readJsonSync(path.join(f.root, '.obsidian/plugins/i18n/states.json')).plugins[pluginId], undefined);
            assert.equal(f.backup.hasBackup(pluginId), false);
            assert.equal(f.app.plugins.enabledPlugins.has(pluginId), true);
        } finally {
            releaseApply.resolve();
            await Promise.allSettled([application, restoration].filter(Boolean));
        }
    });
}

for (const reloadFailure of ['throw', 'silent']) {
    test(`恢复原版后重载${reloadFailure === 'throw' ? '抛错' : '静默未启用'}时返回失败，不报告回滚成功且清理已应用状态`, { timeout: 5000 }, async (t) => {
        const f = fixture(t);
        f.app.plugins.enabledPlugins.add(pluginId);
        let enableCalls = 0;
        f.app.plugins.enablePlugin = async () => {
            enableCalls++;
            if (enableCalls === 1) throw new Error('injected translation load failure');
            if (reloadFailure === 'throw') throw new Error('injected original load failure');
        };
        assert.equal(await f.injector.applyToPlugin(pluginId), false);
        assert.equal(enableCalls, 2);
        assert.equal(f.readMain(), originalV1);
        assert.equal(f.i18n.stateManager.getPluginState(pluginId), undefined);
        assert.equal(fs.readJsonSync(path.join(f.root, '.obsidian/plugins/i18n/states.json')).plugins[pluginId], undefined);
        assert.equal(f.backup.hasBackup(pluginId), false);
        assert.equal(f.app.plugins.enabledPlugins.has(pluginId), false);
        assert.equal(f.notices.some(({ args }) => args.includes('Manager.Common.Notices.RollbackSuccess')), false);
        assert.ok(f.notices.some(({ kind, args }) => (
            kind === 'error' && args.includes('Manager.Common.Errors.RestoredReloadFailed')
        )));
    });
}
