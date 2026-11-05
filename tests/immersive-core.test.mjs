import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filename = path.join(projectRoot, 'src/manager/core.ts');
const compiled = transformSync(fs.readFileSync(filename, 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'node20'
}).code;
const sourceRequire = createRequire(filename);

function fixture() {
    const events = [];
    const managers = [];
    const positionCallbacks = [];
    const settings = { modeImt: false, imtPagerule: {} };
    const i18n = {
        settings,
        app: {},
        saveSettings: async () => { events.push(['save', settings.modeImt]); },
        logger: { error: (...args) => events.push(['error', ...args]) },
        notice: { errorPrefix: (...args) => events.push(['notice', ...args]) }
    };
    class ImmersiveWindowManager {
        constructor(app, handlers) {
            assert.equal(app, i18n.app);
            this.handlers = handlers;
            managers.push(this);
        }
        async start() { events.push(['start']); }
        stop() { events.push(['stop']); }
    }
    const module = { exports: {} };
    const requireSource = (id) => {
        if (id === '../utils') return {
            activateIMT: async (value, win, onPositionChange) => {
                events.push(['activate', value, win]);
                positionCallbacks.push(onPositionChange);
            },
            deactivateIMT: async (win) => events.push(['deactivate', win])
        };
        if (id === '../utils/ui/immersive-windows') return { ImmersiveWindowManager };
        if (id === '../locales') return { t: (key) => key };
        if (id === '../views/manager/manager-view') return { MANAGER_VIEW_TYPE: 'manager' };
        return sourceRequire(id);
    };
    new Function('require', 'module', 'exports', compiled)(requireSource, module, module.exports);
    return { core: new module.exports.CoreManager(i18n), i18n, settings, events, managers, positionCallbacks };
}

test('启用后按目标窗口传递当前配置，单窗口错误提供可见提示', async () => {
    const f = fixture();
    await f.core.activateIMT();
    assert.equal(f.settings.modeImt, true);
    assert.deepEqual(f.events, [['save', true], ['start']]);
    const target = {};
    await f.managers[0].handlers.activate(target);
    assert.deepEqual(f.events.at(-1), ['activate', f.settings, target]);
    await f.managers[0].handlers.deactivate(target);
    assert.deepEqual(f.events.at(-1), ['deactivate', target]);
    const error = new Error('SDK unavailable');
    f.managers[0].handlers.onError(error);
    assert.equal(f.events.at(-2)[0], 'error');
    assert.equal(f.events.at(-2)[2], error);
    assert.deepEqual(f.events.at(-1), [
        'notice', 'Settings.Immersive.Title', 'Settings.Immersive.LoadFailed'
    ]);
});

test('显式停用先停止发现窗口，并持久化关闭偏好和清理全部会话', async () => {
    const f = fixture();
    await f.core.activateIMT();
    f.events.length = 0;
    await f.core.deactivateIMT();
    assert.equal(f.settings.modeImt, false);
    assert.deepEqual(f.events, [['stop'], ['save', false], ['deactivate', undefined]]);
});

test('插件卸载释放运行时并保留用户启用偏好', async () => {
    const f = fixture();
    await f.core.activateIMT();
    f.events.length = 0;
    await f.core.disposeIMT();
    assert.equal(f.settings.modeImt, true);
    assert.deepEqual(f.events, [['stop'], ['deactivate', undefined]]);
    await f.core.activateIMT();
    assert.equal(f.managers.length, 1);
    assert.equal(f.events.filter(([name]) => name === 'start').length, 0);
});

test('窗口拖动回调持久化位置且保留启用偏好，卸载后不再改配置', async () => {
    const f = fixture();
    await f.core.activateIMT();
    await f.managers[0].handlers.activate({});
    assert.equal(typeof f.positionCallbacks[0], 'function');
    f.events.length = 0;
    await f.positionCallbacks[0](0.625);
    assert.equal(f.settings.imtBallPosition, 0.625);
    assert.equal(f.settings.modeImt, true);
    assert.deepEqual(f.events, [['save', true]]);

    await f.core.disposeIMT();
    f.events.length = 0;
    await f.positionCallbacks[0](0.25);
    assert.equal(f.settings.imtBallPosition, 0.625);
    assert.deepEqual(f.events, []);
});

test('保存启用偏好期间卸载，不在异步保存结束后重新启动 SDK', async () => {
    const f = fixture();
    let finishSave;
    f.i18n.saveSettings = () => new Promise((resolve) => { finishSave = resolve; });
    const activating = f.core.activateIMT();
    await f.core.disposeIMT();
    finishSave();
    await activating;
    assert.equal(f.settings.modeImt, true);
    assert.equal(f.managers.length, 0);
    assert.deepEqual(f.events, [['deactivate', undefined]]);
});

test('SDK 清理拒绝时插件卸载仍释放调试界面，并处理异常', async () => {
    const mainSource = transformSync(fs.readFileSync(path.join(projectRoot, 'src/main.ts'), 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'node20'
    }).code;
    const module = { exports: {} };
    new Function('require', 'module', 'exports', mainSource)(
        (id) => id === 'obsidian' ? { Plugin: class {} } : {}, module, module.exports
    );
    const plugin = new module.exports.default();
    const events = [];
    const error = new Error('SDK cleanup failed');
    plugin.view = { deactivateAllViews: () => events.push('views') };
    plugin.coreManager = { disposeIMT: async () => { throw error; } };
    plugin.logger = { error: (message, value) => events.push(value) };
    plugin.cleanupDevDebug = () => events.push('debug');
    await plugin.onunload();
    assert.deepEqual(events, ['views', error, 'debug']);
});
