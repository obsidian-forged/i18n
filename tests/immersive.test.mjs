import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK_URL = 'https://sdk.invalid/fixture.js';
const SDK_SOURCE = '/* 本地 SDK 替身，仅由测试 DOM 模拟挂载，不执行远程脚本。 */';
const STOP_EVENT = 'immersiveTranslateDocumentMessageTypeStopJsSDK';
const settings = { imtPagerule: { selectors: ['.mod-settings'], excludeSelectors: ['.cm-editor'] } };
const settle = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback, options) {
        const listeners = this.listeners.get(type) || [];
        listeners.push({ callback, once: options?.once });
        this.listeners.set(type, listeners);
    }
    removeEventListener(type, callback) {
        this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item.callback !== callback));
    }
    dispatchEvent(event) {
        if (!event.target) event.target = this;
        for (const item of [...(this.listeners.get(event.type) || [])]) {
            if (item.once) this.removeEventListener(event.type, item.callback);
            item.callback.call(this, event);
        }
        return true;
    }
    fire(type, properties = {}) {
        this.dispatchEvent({ type, preventDefault() {}, ...properties });
    }
    listenerCount(type) {
        if (type) return (this.listeners.get(type) || []).length;
        return [...this.listeners.values()].reduce((count, listeners) => count + listeners.length, 0);
    }
}

function makeWindow(name, { autoMount = true, scriptError = false } = {}) {
    const win = new Events();
    Object.assign(win, { name, closed: false, innerHeight: 800, autoMount, scriptError, observers: new Set(), timers: new Map(), runtimes: [], trace: [], reloads: 0 });
    let nextTimer = 0;
    win.setTimeout = (callback, delay) => { const id = ++nextTimer; win.timers.set(id, { callback, delay }); return id; };
    win.clearTimeout = (id) => win.timers.delete(id);
    win.runTimers = () => {
        for (const [id, timer] of [...win.timers]) {
            win.timers.delete(id);
            timer.callback();
        }
    };
    win.URLSearchParams = class extends URLSearchParams {};
    win.CustomEvent = class {
        constructor(type, options) { this.type = type; this.detail = options?.detail; }
    };
    win.MutationObserver = class {
        constructor(callback) { this.callback = callback; this.active = false; }
        observe(target, options) { this.target = target; this.options = options; this.active = true; win.observers.add(this); }
        disconnect() { this.active = false; win.observers.delete(this); }
    };
    const doc = new Events();
    Object.assign(doc, { nodeType: 9, defaultView: win, events: [], location: { reload() { win.reloads++; } } });
    win.document = doc;
    const notify = (target) => {
        for (const observer of win.observers) {
            if (observer.target !== target && !(observer.options.subtree && observer.target.contains(target))) continue;
            queueMicrotask(() => {
                if (observer.active) observer.callback([{ type: 'childList', target }]);
            });
        }
    };
    win.Node = class extends Events {
        constructor(tagName) {
            super();
            Object.assign(this, { tagName: tagName.toUpperCase(), nodeType: 1, ownerDocument: doc, children: [], parentNode: null, dataset: {}, style: {}, id: '', className: '', textContent: '', offsetHeight: 32 });
        }
        get childElementCount() { return this.children.length; }
        get isConnected() { return this.parentNode?.nodeType === 9 || !!this.parentNode?.isConnected; }
        contains(target) { return this === target || this.children.some((child) => child.contains(target)); }
        appendChild(child) {
            child.remove();
            child.parentNode = this;
            this.children.push(child);
            notify(this);
            if (child.tagName === 'SCRIPT' && child.isConnected) doc.executeScript(child);
            return child;
        }
        append(...children) { children.forEach((child) => this.appendChild(child)); }
        removeChild(child) {
            this.children.splice(this.children.indexOf(child), 1);
            child.parentNode = null;
            notify(this);
            return child;
        }
        remove() { this.parentNode?.removeChild(this); }
        getBoundingClientRect() {
            const top = Number.parseFloat(this.style.top);
            return { top: Number.isFinite(top) ? top : 30, height: this.offsetHeight };
        }
    };
    const all = (element) => [element, ...element.children.flatMap(all)];
    const matches = (element, selector) => {
        const id = selector.match(/^#([^\[]+)/)?.[1];
        const session = selector.match(/data-i18n-imt-session="([^"]+)"/)?.[1];
        if (id) return element.id === id && (!session || element.dataset.i18nImtSession === session);
        return element.tagName.toLowerCase() === selector.toLowerCase();
    };
    doc.createElement = (tag) => new win.Node(tag);
    doc.documentElement = doc.createElement('html');
    doc.documentElement.parentNode = doc;
    doc.head = doc.createElement('head');
    doc.body = doc.createElement('body');
    doc.documentElement.append(doc.head, doc.body);
    doc.querySelectorAll = (selector) => all(doc.documentElement).filter((element) => matches(element, selector));
    doc.querySelector = (selector) => doc.querySelectorAll(selector)[0] || null;
    doc.getElementById = (id) => doc.querySelector(`#${id}`);
    const dispatch = doc.dispatchEvent.bind(doc);
    doc.dispatchEvent = (event) => { doc.events.push(event); return dispatch(event); };
    doc.executeScript = (script) => {
        assert.equal(script.src, undefined, 'SDK 必须先获取文本再受控执行');
        assert.equal(script.textContent, SDK_SOURCE, '测试禁止执行未知脚本');
        const runtime = { id: win.runtimes.length + 1, mounted: false, stopped: false };
        win.runtimes.push(runtime);
        win.trace.push(`execute:${runtime.id}`);
        const fetchBridge = win.GM_fetch;
        win.GM_fetch = function imtStreamPolyfill(...args) { return fetchBridge(...args); };
        win.GM_fetch.imtStreamPolyfill = true;
        win.GM = { runtime: runtime.id };
        win.immersiveTranslateBrowserAPI = { runtime: runtime.id };
        win.TranslationServicesClass = class {};
        const mount = () => {
            if (runtime.stopped || runtime.mounted) return;
            const panel = doc.querySelector(win.immersiveTranslateConfig.mountPoint.selector);
            assert.ok(panel, 'SDK 必须能找到本窗口、本会话的挂载点');
            runtime.widget = doc.createElement('button');
            panel.appendChild(runtime.widget);
            runtime.mounted = true;
            win.trace.push(`mount:${runtime.id}`);
        };
        runtime.mount = mount;
        const handshake = () => mount();
        const stop = () => {
            win.trace.push(`stop:${runtime.id}`);
            runtime.stopped = true;
            runtime.widget?.remove();
            doc.removeEventListener(STOP_EVENT, stop);
            doc.removeEventListener('fixture-sdk-handshake', handshake);
        };
        doc.addEventListener(STOP_EVENT, stop);
        doc.addEventListener('fixture-sdk-handshake', handshake);
        win.initImmersiveTranslate = async () => mount();
        win.destroyImmersiveTranslate = () => { win.trace.push(`destroy:${runtime.id}`); runtime.widget?.remove(); };
        runtime.onerror = function fixtureSdkErrorHandler() {};
        win.onerror = runtime.onerror;
        win.immersiveTranslateSwitchTranslateState = async (state) => { win.trace.push(`switch:${runtime.id}:${state}`); };
        if (win.scriptError) script.fire('error');
        else if (win.autoMount) mount();
    };
    return win;
}

function fixture(t, { fetchSdk } = {}) {
    const main = makeWindow('main');
    const windows = [main];
    const requests = [];
    const requestUrl = async (request) => {
        requests.push(request);
        if (request.url === SDK_URL) {
            return fetchSdk ? fetchSdk(request) : { status: 200, text: SDK_SOURCE };
        }
        assert.equal(request.url, 'https://translation.invalid/test', '测试禁止真实网络');
        return { status: 201, headers: { 'Content-Type': 'application/json', 'X-Trace': 'fixture' }, json: { translated: true }, text: '{"translated":true}', arrayBuffer: new ArrayBuffer(2) };
    };
    const filename = path.join(projectRoot, 'src/utils/ui/immersive.ts');
    const compiled = transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node20' }).code;
    const module = { exports: {} };
    const requireSource = (id) => {
        if (id === 'obsidian') return { requestUrl };
        if (id === 'src/constants/url') return { SDK_URL };
        throw new Error(`未预期的源码依赖：${id}`);
    };
    new Function('require', 'module', 'exports', 'window', 'document', 'Node', 'URLSearchParams', compiled)(
        requireSource, module, module.exports, main, main.document, main.Node, main.URLSearchParams
    );
    const manager = module.exports.ImmersiveTranslate.getInstance();
    t.after(async () => {
        for (const win of windows) {
            if (win.document.getElementById('immersive-translate-ball')) {
                for (const runtime of win.runtimes) runtime.mount();
            }
            win.runTimers();
        }
        await manager.deactivate();
    });
    return {
        main, manager, requests,
        child(options) { const win = makeWindow('settings', options); windows.push(win); return win; },
        sdkRequests: () => requests.filter((request) => request.url === SDK_URL)
    };
}

const outcome = (promise) => promise.then(() => ({ ok: true }), (error) => ({ error }));

test('主窗口与独立设置窗口各自初始化，重复激活共享就绪结果', async (t) => {
    const f = fixture(t);
    const child = f.child();
    const first = f.manager.activate(settings);
    const duplicate = f.manager.activate(settings);
    await Promise.all([first, duplicate, f.manager.activate(settings, child)]);
    const initialRequests = f.sdkRequests().length;
    assert.ok(initialRequests > 0);
    assert.notEqual(f.main.immersiveTranslateConfig, child.immersiveTranslateConfig);
    assert.notEqual(f.main.GM_fetch, child.GM_fetch);
    for (const win of [f.main, child]) {
        assert.ok(win.document.getElementById('immersive-translate-ball'));
        assert.equal(win.runtimes.length, 1);
        assert.equal(win.runtimes[0].mounted, true);
        await f.manager.activate(settings, win);
    }
    assert.equal(f.sdkRequests().length, initialRequests);
});

test('SDK下载完成仍等待实际面板挂载，挂载后才报告初始化成功', async (t) => {
    const f = fixture(t);
    const child = f.child({ autoMount: false });
    let completed = false;
    const ready = f.manager.activate(settings, child).then(() => { completed = true; });
    await settle();
    assert.equal(child.runtimes.length, 1);
    assert.equal(completed, false);
    child.runtimes[0].mount();
    await ready;
    assert.equal(completed, true);
    assert.equal(child.observers.size, 0);
    assert.equal(child.timers.size, 0);
});

for (const failure of [new Error('download rejected'), { status: 503, text: '' }]) {
    test(`SDK${failure instanceof Error ? '网络失败' : '非成功状态'}后可重试，其他窗口保持可用`, async (t) => {
        let fail = false;
        const f = fixture(t, { fetchSdk: async () => {
            if (fail) { if (failure instanceof Error) throw failure; return failure; }
            return { status: 200, text: SDK_SOURCE };
        } });
        await f.manager.activate(settings);
        const child = f.child();
        fail = true;
        await assert.rejects(f.manager.activate(settings, child), failure instanceof Error ? failure : /503/);
        assert.equal(child.runtimes.length, 0);
        assert.equal(child.document.getElementById('immersive-translate-ball'), null);
        assert.equal(child.immersiveTranslateConfig, undefined);
        assert.ok(f.main.document.getElementById('immersive-translate-ball'));
        fail = false;
        await f.manager.activate(settings, child);
        assert.equal(child.runtimes.length, 1);
    });
}

test('SDK执行错误清理本窗口资源并允许重试', async (t) => {
    const f = fixture(t);
    const child = f.child({ scriptError: true });
    await assert.rejects(f.manager.activate(settings, child), /执行失败/);
    assert.equal(child.document.getElementById('immersive-translate-ball'), null);
    assert.equal(child.document.listenerCount(), 0);
    child.scriptError = false;
    await f.manager.activate(settings, child);
    assert.equal(child.runtimes[1].mounted, true);
});

test('加载超时后拒绝初始化，迟到的下载结果不会执行SDK', async (t) => {
    const download = deferred();
    const f = fixture(t, { fetchSdk: () => download.promise });
    const result = outcome(f.manager.activate(settings));
    await settle();
    f.main.runTimers();
    assert.match((await result).error.message, /超时/);
    download.resolve({ status: 200, text: SDK_SOURCE });
    await settle();
    assert.equal(f.main.runtimes.length, 0);
    assert.equal(f.main.document.getElementById('immersive-translate-ball'), null);
});

test('下载期间停用，响应到达后不会执行SDK或重新挂载界面', async (t) => {
    const download = deferred();
    const f = fixture(t, { fetchSdk: () => download.promise });
    const result = outcome(f.manager.activate(settings));
    await settle();
    const stopped = f.manager.deactivate();
    download.resolve({ status: 200, text: SDK_SOURCE });
    await stopped;
    assert.match((await result).error.message, /取消|停用/);
    assert.equal(f.main.runtimes.length, 0);
    assert.equal(f.main.GM_fetch, undefined);
    assert.equal(f.main.document.getElementById('immersive-translate-ball'), null);
});

test('已执行但尚未挂载时停用，等待旧SDK退出后才允许同窗口重启', async (t) => {
    const f = fixture(t);
    const child = f.child({ autoMount: false });
    const oldResult = outcome(f.manager.activate(settings, child));
    await settle();
    const old = child.runtimes[0];
    const stopped = f.manager.deactivate(child);
    assert.equal(child.document.getElementById('immersive-translate-ball').style.display, 'none');
    const restarted = f.manager.activate(settings, child);
    await settle();
    assert.equal(child.runtimes.length, 1, '旧实例清理前不能执行第二份SDK');
    child.autoMount = true;
    old.mount();
    await stopped;
    await restarted;
    assert.match((await oldResult).error.message, /停用|取消/);
    assert.equal(old.stopped, true);
    assert.equal(child.runtimes.length, 2);
    assert.ok(child.trace.indexOf('stop:1') < child.trace.indexOf('execute:2'));
    assert.equal(child.document.listenerCount('fixture-sdk-handshake'), 1);
    child.document.fire('fixture-sdk-handshake');
    assert.equal(child.runtimes[0].mounted, true);
    assert.equal(child.runtimes[1].mounted, true);
});

test('停用恢复原文并移除SDK握手监听，恢复原有配置和请求桥接', async (t) => {
    const f = fixture(t);
    const child = f.child();
    const previousConfig = { existing: true };
    const previousFetch = () => 'existing';
    const previousGM = { existing: true };
    const previousApi = { existing: true };
    const previousServices = class {};
    child.GM = previousGM;
    child.immersiveTranslateBrowserAPI = previousApi;
    child.TranslationServicesClass = previousServices;
    child.immersiveTranslateConfig = previousConfig;
    child.GM_fetch = previousFetch;
    await f.manager.activate(settings, child);
    await f.manager.deactivate(child);
    assert.deepEqual(child.trace.slice(-3), ['switch:1:original', 'destroy:1', 'stop:1']);
    assert.equal(child.immersiveTranslateConfig, previousConfig);
    assert.equal(child.GM_fetch, previousFetch);
    assert.equal(child.GM, previousGM);
    assert.equal(child.immersiveTranslateBrowserAPI, previousApi);
    assert.equal(child.TranslationServicesClass, previousServices);
    assert.equal(child.initImmersiveTranslate, undefined);
    assert.equal(child.destroyImmersiveTranslate, undefined);
    assert.equal(child.immersiveTranslateSwitchTranslateState, undefined);
    assert.equal(child.document.listenerCount(), 0);
    assert.equal(child.listenerCount(), 0);
    assert.equal(child.document.getElementById('immersive-translate-ball'), null);
    assert.equal(child.document.querySelector('script'), null);
    assert.equal(child.reloads, 0);
    assert.ok(child.document.events.find((event) => event.type === STOP_EVENT) instanceof child.CustomEvent);
});

test('停用指定子窗口不影响主窗口，无参停用才清理全部会话', async (t) => {
    const f = fixture(t);
    const child = f.child();
    await Promise.all([f.manager.activate(settings), f.manager.activate(settings, child)]);
    await f.manager.deactivate(child);
    assert.ok(f.main.document.getElementById('immersive-translate-ball'));
    assert.equal(child.document.getElementById('immersive-translate-ball'), null);
    for (const name of ['GM_fetch', 'GM', 'immersiveTranslateBrowserAPI', 'TranslationServicesClass']) {
        assert.equal(Object.hasOwn(child, name), false, `${name} 必须恢复为未定义属性`);
    }
    await f.manager.deactivate();
    assert.equal(f.main.document.getElementById('immersive-translate-ball'), null);
    assert.equal(f.main.document.listenerCount(), 0);
});

test('子窗口点击与拖拽使用其自身Node、文档和视口', async (t) => {
    const f = fixture(t);
    const child = f.child();
    child.innerHeight = 200;
    await f.manager.activate(settings, child);
    const ball = child.document.getElementById('immersive-translate-ball');
    const panel = child.document.getElementById('immersive-translate-panel');
    const widget = child.runtimes[0].widget;
    assert.equal(widget instanceof f.main.Node, false, '替身需保留跨realm差异');
    ball.fire('click', { target: widget });
    assert.equal(panel.style.display, 'none');
    ball.fire('click');
    assert.equal(panel.style.display, 'flex');
    ball.fire('mousedown', { button: 0, clientY: 10 });
    f.main.document.fire('mousemove', { clientY: 500 });
    assert.equal(ball.style.top, undefined);
    child.document.fire('mousemove', { clientY: 500 });
    assert.equal(ball.style.top, '168px');
    child.document.fire('mouseup');
    child.document.fire('mousemove', { clientY: 0 });
    assert.equal(ball.style.top, '168px');
    await f.manager.deactivate(child);
    assert.equal(child.document.listenerCount(), 0);
    assert.equal(ball.listenerCount(), 0);
});

test('保存的位置按各窗口可移动高度恢复，缩放窗口不写配置且保持比例', async (t) => {
    const f = fixture(t);
    const child = f.child();
    child.innerHeight = 200;
    const saved = [];
    const config = { ...settings, imtBallPosition: 0.5 };
    await Promise.all([
        f.manager.activate(config, f.main, (position) => saved.push(position)),
        f.manager.activate(config, child, (position) => saved.push(position))
    ]);
    const mainBall = f.main.document.getElementById('immersive-translate-ball');
    const childBall = child.document.getElementById('immersive-translate-ball');
    assert.equal(mainBall.style.top, '384px');
    assert.equal(childBall.style.top, '84px');

    child.innerHeight = 432;
    child.fire('resize');
    assert.equal(childBall.style.top, '200px');
    assert.equal(mainBall.style.top, '384px');
    assert.deepEqual(saved, []);

    await f.manager.deactivate(child);
    assert.equal(child.listenerCount('resize'), 0);
    child.innerHeight = 100;
    child.fire('resize');
    assert.equal(childBall.style.top, '200px');
});

test('只在拖动结束保存一次，新窗口和重新启用使用最后位置', async (t) => {
    const f = fixture(t);
    const child = f.child();
    child.innerHeight = 232;
    const config = { ...settings, imtBallPosition: null };
    const saved = [];
    const save = (position) => { saved.push(position); config.imtBallPosition = position; };
    await f.manager.activate(config, child, save);
    const ball = child.document.getElementById('immersive-translate-ball');
    const widget = child.runtimes[0].widget;
    assert.equal(ball.style.top, undefined, '未保存位置时保留 CSS 默认值');
    ball.fire('mousedown', { button: 0, clientY: 10 });
    child.document.fire('mouseup');
    ball.fire('mousedown', { button: 0, clientY: 10, target: widget });
    child.document.fire('mousemove', { clientY: 80 });
    child.document.fire('mouseup');
    assert.deepEqual(saved, [], '普通点击和面板交互不保存位置');

    ball.fire('mousedown', { button: 0, clientY: 10 });
    child.document.fire('mousemove', { clientY: 40 });
    child.document.fire('mousemove', { clientY: 80 });
    assert.deepEqual(saved, [], '拖动中不写配置');
    child.document.fire('mouseup');
    child.document.fire('mouseup');
    await settle();
    assert.deepEqual(saved, [0.5]);
    assert.equal(ball.style.top, '100px');
    child.innerHeight = 432;
    child.fire('resize');
    assert.equal(ball.style.top, '200px', '缩放使用拖动后的比例');

    await f.manager.deactivate(child);
    await f.manager.activate(config, child, save);
    assert.equal(child.document.getElementById('immersive-translate-ball').style.top, '200px');
    const reopened = f.child();
    reopened.innerHeight = 632;
    await f.manager.activate(config, reopened, save);
    assert.equal(reopened.document.getElementById('immersive-translate-ball').style.top, '300px');
    assert.deepEqual(saved, [0.5]);
});

test('越界位置夹取，非法旧值保留默认位置，小窗口缩放后仍恢复比例', async (t) => {
    const f = fixture(t);
    for (const [position, expected] of [[-1, '0px'], [2, '768px'], [NaN, undefined], [Infinity, undefined], ['0.5', undefined], [null, undefined]]) {
        const child = f.child();
        await f.manager.activate({ ...settings, imtBallPosition: position }, child);
        assert.equal(child.document.getElementById('immersive-translate-ball').style.top, expected);
    }
    const small = f.child();
    small.innerHeight = 16;
    await f.manager.activate({ ...settings, imtBallPosition: 0.5 }, small);
    const ball = small.document.getElementById('immersive-translate-ball');
    assert.equal(ball.style.top, '0px');
    small.innerHeight = 232;
    small.fire('resize');
    assert.equal(ball.style.top, '100px');
});

test('停用立即移除拖动和缩放监听，不等待 SDK 恢复原文', async (t) => {
    const f = fixture(t);
    const child = f.child();
    const restore = deferred();
    const saved = [];
    await f.manager.activate({ ...settings, imtBallPosition: 0.5 }, child, (position) => saved.push(position));
    child.immersiveTranslateSwitchTranslateState = () => restore.promise;
    const ball = child.document.getElementById('immersive-translate-ball');
    ball.fire('mousedown', { button: 0, clientY: 10 });
    const stopped = f.manager.deactivate(child);
    try {
        assert.equal(ball.listenerCount('mousedown'), 0);
        assert.equal(child.document.listenerCount('mousemove'), 0);
        assert.equal(child.document.listenerCount('mouseup'), 0);
        assert.equal(child.listenerCount('resize'), 0);
        child.document.fire('mousemove', { clientY: 100 });
        child.document.fire('mouseup');
        assert.deepEqual(saved, []);
    } finally {
        restore.resolve();
        await stopped;
    }
});

for (const asynchronous of [false, true]) {
    test(`${asynchronous ? '异步' : '同步'}保存位置失败被处理，后续仍可拖动保存`, async (t) => {
        const f = fixture(t);
        const child = f.child();
        child.innerHeight = 232;
        const error = new Error('position save failed');
        let saves = 0;
        const save = () => {
            if (++saves > 1) return;
            if (asynchronous) return Promise.reject(error);
            throw error;
        };
        const errors = t.mock.method(console, 'error', () => {});
        await f.manager.activate(settings, child, save);
        const ball = child.document.getElementById('immersive-translate-ball');
        for (const y of [80, 100]) {
            ball.fire('mousedown', { button: 0, clientY: 10 });
            child.document.fire('mousemove', { clientY: y });
            child.document.fire('mouseup');
            await settle();
        }
        assert.equal(saves, 2);
        assert.equal(errors.mock.callCount(), 1);
        assert.equal(errors.mock.calls[0].arguments.at(-1), error);
        assert.equal(ball.style.top, '190px');
    });
}

test('子窗口GM_fetch保留URLSearchParams、响应数据与不区分大小写的头部契约', async (t) => {
    const f = fixture(t);
    const child = f.child();
    await f.manager.activate(settings, child);
    const body = new child.URLSearchParams({ query: 'hello world' });
    assert.equal(body instanceof f.main.URLSearchParams, false, '替身需保留跨realm差异');
    const response = await child.GM_fetch({ url: 'https://translation.invalid/test' }, { method: 'POST', headers: { Accept: 'application/json' }, body });
    const request = f.requests.at(-1);
    assert.equal(request.body, 'query=hello+world');
    assert.equal(request.headers['Content-Type'], 'application/x-www-form-urlencoded;charset=UTF-8');
    assert.equal(request.throw, false);
    assert.equal(response.ok, true);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('missing'), null);
    assert.deepEqual(await response.json(), { translated: true });
    assert.equal(await response.text(), '{"translated":true}');
    assert.equal((await response.arrayBuffer()).byteLength, 2);
    assert.equal(response.clone(), response);
});

test('已有其他SDK实例时拒绝覆盖其配置、接口和监听', async (t) => {
    const f = fixture(t);
    const child = f.child();
    const init = async () => {};
    const destroy = () => {};
    const previous = { existing: true };
    child.initImmersiveTranslate = init;
    child.destroyImmersiveTranslate = destroy;
    child.immersiveTranslateConfig = previous;
    await assert.rejects(f.manager.activate(settings, child), /其他沉浸式翻译实例/);
    assert.equal(child.initImmersiveTranslate, init);
    assert.equal(child.destroyImmersiveTranslate, destroy);
    assert.equal(child.immersiveTranslateConfig, previous);
    assert.equal(f.sdkRequests().length, 0);
});


test('连续停用和启用始终等待最早的SDK原文恢复完成', async (t) => {
    const f = fixture(t);
    const child = f.child();
    await f.manager.activate(settings, child);
    const restore = deferred();
    child.immersiveTranslateSwitchTranslateState = () => restore.promise;
    const firstStop = f.manager.deactivate(child);
    await settle();
    const second = outcome(f.manager.activate(settings, child));
    const secondStop = f.manager.deactivate(child);
    const third = outcome(f.manager.activate(settings, child));
    await settle();
    assert.equal(child.runtimes.length, 1, '旧SDK恢复期间不能执行后续脚本');
    restore.resolve();
    await Promise.all([firstStop, secondStop]);
    const secondResult = await second;
    const thirdResult = await third;
    assert.match(secondResult.error.message, /停用|关闭|取消/);
    assert.equal(thirdResult.error, undefined, '末次启用必须等待旧SDK退出后成功');
    assert.equal(child.runtimes.length, 2);
    assert.equal(child.runtimes[0].stopped, true);
    assert.equal(child.runtimes[1].mounted, true);
    assert.equal(child.document.listenerCount('fixture-sdk-handshake'), 1);
});


test('SDK已执行未挂载时pagehide立即结束初始化和清理，不等待超时', async (t) => {
    const f = fixture(t);
    const child = f.child({ autoMount: false });
    let result;
    const ready = outcome(f.manager.activate(settings, child)).then((value) => { result = value; });
    await settle();
    assert.equal(child.runtimes.length, 1);
    assert.equal(child.runtimes[0].mounted, false);
    // pagehide发生时浏览器的closed仍可能为false，必须按文档销毁处理。
    assert.equal(child.closed, false);
    child.fire('pagehide');
    await settle();
    assert.ok(result?.error, 'pagehide后ready必须及时结束');
    await ready;
    await f.manager.deactivate(child);
    assert.equal(child.observers.size, 0);
    assert.equal(child.timers.size, 0);
    assert.equal(child.listenerCount(), 0);
    assert.equal(child.document.listenerCount('mousemove'), 0);
    assert.equal(child.document.listenerCount('mouseup'), 0);
    assert.equal(child.document.getElementById('immersive-translate-ball'), null);
    assert.equal(child.document.querySelector('script'), null);
});

test('停用恢复SDK覆盖的onerror和原有switch属性descriptor', async (t) => {
    const f = fixture(t);
    const child = f.child();
    const previousOnError = () => 'previous';
    const previousSwitch = async () => {};
    child.onerror = previousOnError;
    Object.defineProperty(child, 'immersiveTranslateSwitchTranslateState', {
        value: previousSwitch, writable: true, configurable: true, enumerable: false
    });
    const originalDescriptor = Object.getOwnPropertyDescriptor(child, 'immersiveTranslateSwitchTranslateState');
    await f.manager.activate(settings, child);
    assert.equal(child.onerror, child.runtimes[0].onerror);
    await f.manager.deactivate(child);
    assert.equal(child.onerror, previousOnError);
    assert.deepEqual(Object.getOwnPropertyDescriptor(child, 'immersiveTranslateSwitchTranslateState'), originalDescriptor);
});

test('停用保留其他插件后来写入的onerror处理器', async (t) => {
    const f = fixture(t);
    const child = f.child();
    const previousOnError = () => 'previous';
    const laterOnError = () => 'later';
    child.onerror = previousOnError;
    await f.manager.activate(settings, child);
    assert.equal(child.onerror, child.runtimes[0].onerror);
    child.onerror = laterOnError;
    await f.manager.deactivate(child);
    assert.equal(child.onerror, laterOnError);
    assert.equal(Object.hasOwn(child, 'immersiveTranslateSwitchTranslateState'), false);
});
