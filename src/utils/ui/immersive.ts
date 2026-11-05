/**
 * 按窗口管理沉浸式翻译的加载、原文恢复与界面资源。
 */
import { I18nSettings } from 'src/settings/data';
import Url from 'src/constants/url';
import { requestUrl } from 'obsidian';

declare global {
    interface Window {
        immersiveTranslateConfig?: immersiveTranslateConfig;
        GM_fetch?: any;
        initImmersiveTranslate?: (config: immersiveTranslateConfig) => Promise<void>;
        destroyImmersiveTranslate?: () => void;
        immersiveTranslateSwitchTranslateState?: (state: 'original') => Promise<void>;
    }
}

type ImmersiveWindow = Window & typeof globalThis;
type FetchOptions = { method?: string; headers?: Record<string, string>; body?: unknown };

interface WindowSession {
    window: ImmersiveWindow;
    config: immersiveTranslateConfig;
    previousConfig: Window['immersiveTranslateConfig'];
    previousFetch: Window['GM_fetch'];
    previousInit: Window['initImmersiveTranslate'];
    previousDestroy: Window['destroyImmersiveTranslate'];
    previousSwitch: Window['immersiveTranslateSwitchTranslateState'];
    previousSwitchDescriptor?: PropertyDescriptor;
    switchGetter?: () => Window['immersiveTranslateSwitchTranslateState'];
    switchSetter?: (value: Window['immersiveTranslateSwitchTranslateState']) => void;
    sdkSwitch?: Window['immersiveTranslateSwitchTranslateState'];
    previousOnError: Window['onerror'];
    sdkOnError?: Window['onerror'];
    bridge: Window['GM_fetch'];
    sdkInit?: Window['initImmersiveTranslate'];
    sdkDestroy?: Window['destroyImmersiveTranslate'];
    sdkFetch?: Window['GM_fetch'];
    previousGlobals: Map<string, { existed: boolean; value: unknown }>;
    sdkGlobals: Map<string, unknown>;
    ball: HTMLElement | null;
    panel: HTMLElement | null;
    ballPosition: number | null;
    onBallPositionChange?: (position: number) => void | Promise<void>;
    stopDragging?: () => void;
    script: HTMLScriptElement | null;
    cleanups: Array<() => void>;
    cancelled: boolean;
    closing: boolean;
    executed: boolean;
    ready: Promise<void>;
    loaded: Promise<void>;
    finishLoading: () => void;
    cancelLoading?: () => void;
    disposal?: Promise<void>;
    previousCleanup?: Promise<void>;
}

const LOAD_TIMEOUT = 30000;
const SDK_GLOBALS = ['GM', 'immersiveTranslateBrowserAPI', 'TranslationServicesClass'];
// SDK 的 destroy 不释放握手监听；使用 SDK 自身的停止通知完成同窗口清理。
const SDK_STOP_EVENT = 'immersiveTranslateDocumentMessageTypeStopJsSDK';

export class ImmersiveTranslate {
    private static instance: ImmersiveTranslate | null = null;
    private sessions = new Map<Window, WindowSession>();
    private cleanups = new Map<Window, Promise<void>>();

    private constructor() {}

    public static getInstance(): ImmersiveTranslate {
        if (!ImmersiveTranslate.instance) ImmersiveTranslate.instance = new ImmersiveTranslate();
        return ImmersiveTranslate.instance;
    }

    public activate(
        settings: I18nSettings,
        targetWindow: Window = window,
        onBallPositionChange?: (position: number) => void | Promise<void>
    ): Promise<void> {
        const existing = this.sessions.get(targetWindow);
        if (existing && !existing.cancelled) return existing.ready;

        const win = targetWindow as ImmersiveWindow;
        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const config: immersiveTranslateConfig = {
            partnerId: 'immersive-translate-sdk',
            mountPoint: { selector: `#immersive-translate-panel[data-i18n-imt-session="${id}"]`, action: 'child' },
            disclaimerPoint: { selector: `#immersive-translate-disc[data-i18n-imt-session="${id}"]`, action: 'child' },
            pageRule: {
                mainFrameSelector: settings.imtPagerule.mainFrameSelector,
                selectors: settings.imtPagerule.selectors,
                excludeSelectors: settings.imtPagerule.excludeSelectors,
                stayOriginalSelectors: settings.imtPagerule.stayOriginalSelectors,
                extraBlockSelectors: settings.imtPagerule.extraBlockSelectors,
                extraInlineSelectors: settings.imtPagerule.extraInlineSelectors,
                translationClasses: settings.imtPagerule.translationClasses,
                injectedCss: settings.imtPagerule.injectedCss
            }
        };
        let finishLoading = () => {};
        const loaded = new Promise<void>((resolve) => { finishLoading = resolve; });
        const session: WindowSession = {
            window: win, config,
            previousConfig: undefined, previousFetch: undefined,
            previousInit: undefined, previousDestroy: undefined, previousSwitch: undefined,
            previousOnError: null,
            bridge: undefined, previousGlobals: new Map(), sdkGlobals: new Map(),
            ball: null, panel: null, script: null,
            ballPosition: typeof settings.imtBallPosition === 'number' && Number.isFinite(settings.imtBallPosition)
                ? Math.max(0, Math.min(1, settings.imtBallPosition)) : null,
            onBallPositionChange,
            cleanups: [], cancelled: false, closing: false, executed: false,
            ready: Promise.resolve(), loaded, finishLoading
        };
        session.previousCleanup = this.cleanups.get(targetWindow);
        this.sessions.set(targetWindow, session);
        session.ready = this.initialize(session, id);
        return session.ready;
    }

    private async initialize(session: WindowSession, id: string) {
        try {
            await session.previousCleanup?.catch(console.error);
            if (session.cancelled || session.window.closed) throw new Error('沉浸式翻译窗口已关闭或已停用');
            const win = session.window;
            if (win.initImmersiveTranslate || win.destroyImmersiveTranslate) {
                throw new Error('当前窗口已存在其他沉浸式翻译实例，请先关闭该实例');
            }
            session.previousConfig = win.immersiveTranslateConfig;
            session.previousFetch = win.GM_fetch;
            session.previousInit = win.initImmersiveTranslate;
            session.previousDestroy = win.destroyImmersiveTranslate;
            session.previousSwitch = win.immersiveTranslateSwitchTranslateState;
            this.createBall(session, id);
            win.immersiveTranslateConfig = session.config;
            session.bridge = this.createFetchBridge(win);
            win.GM_fetch = session.bridge;
            const onClose = () => {
                session.closing = true;
                session.cancelLoading?.();
                void this.dispose(session).catch(console.error);
            };
            win.addEventListener('pagehide', onClose);
            session.cleanups.push(() => win.removeEventListener('pagehide', onClose));
            await this.loadSdk(session);
            if (session.cancelled) throw new Error('沉浸式翻译已停用');
        } catch (error) {
            session.finishLoading();
            await this.dispose(session).catch(console.error);
            throw error;
        }
    }

    private createBall(session: WindowSession, id: string): void {
        const win = session.window;
        const doc = win.document;
        const ball = doc.createElement('div');
        ball.id = 'immersive-translate-ball';
        ball.innerHTML = '<svg t="1759459310417" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="1662" width="20" height="20"><path d="M213.333333 640v85.333333a85.333333 85.333333 0 0 0 78.933334 85.12L298.666667 810.666667h128v85.333333H298.666667a170.666667 170.666667 0 0 1-170.666667-170.666667v-85.333333h85.333333z m554.666667-213.333333l187.733333 469.333333h-91.946666l-51.242667-128h-174.506667l-51.157333 128h-91.904L682.666667 426.666667h85.333333z m-42.666667 123.093333L672.128 682.666667h106.325333L725.333333 549.76zM341.333333 85.333333v85.333334h170.666667v298.666666H341.333333v128H256v-128H85.333333V170.666667h170.666667V85.333333h85.333333z m384 42.666667a170.666667 170.666667 0 0 1 170.666667 170.666667v85.333333h-85.333333V298.666667a85.333333 85.333333 0 0 0-85.333334-85.333334h-128V128h128zM256 256H170.666667v128h85.333333V256z m170.666667 0H341.333333v128h85.333334V256z" fill="currentColor"  p-id="1663"></path></svg>';
        const panel = doc.createElement('div');
        panel.id = 'immersive-translate-panel';
        panel.dataset.i18nImtSession = id;
        panel.style.display = 'none';
        const disc = doc.createElement('div');
        disc.id = 'immersive-translate-disc';
        disc.dataset.i18nImtSession = id;
        ball.append(panel, disc);
        session.ball = ball;
        session.panel = panel;
        const onClick = (event: MouseEvent) => {
            if (event.target instanceof win.Node && panel.contains(event.target)) return;
            panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
        };
        ball.addEventListener('click', onClick);
        session.cleanups.push(() => ball.removeEventListener('click', onClick));
        doc.body.appendChild(ball);
        this.makeDraggable(session, ball, panel);
    }

    private makeDraggable(session: WindowSession, element: HTMLElement, panel: HTMLElement): void {
        const win = session.window;
        const doc = win.document;
        let dragging = false;
        let moved = false;
        let startY = 0;
        let initialTop = 0;
        let position = session.ballPosition;
        const availableHeight = () => Math.max(0, win.innerHeight - element.offsetHeight);
        const placeBall = () => {
            if (position === null) return;
            element.style.top = `${position * availableHeight()}px`;
            element.style.bottom = 'auto';
            element.style.right = '0px';
        };
        placeBall();
        const onDown = (event: MouseEvent) => {
            if (event.button !== 0 || (event.target instanceof win.Node && panel.contains(event.target))) return;
            event.preventDefault();
            dragging = true;
            moved = false;
            startY = event.clientY;
            initialTop = element.getBoundingClientRect().top;
        };
        const onMove = (event: MouseEvent) => {
            if (!dragging || (!moved && event.clientY === startY)) return;
            event.preventDefault();
            moved = true;
            const height = availableHeight();
            const top = Math.max(0, Math.min(initialTop + event.clientY - startY, height));
            position = height > 0 ? top / height : 0;
            placeBall();
        };
        const onUp = async () => {
            if (!dragging) return;
            dragging = false;
            if (!moved || position === null) return;
            try {
                await session.onBallPositionChange?.(position);
            } catch (error) {
                console.error('沉浸式翻译悬浮球位置保存失败', error);
            }
        };
        element.addEventListener('mousedown', onDown);
        doc.addEventListener('mousemove', onMove);
        doc.addEventListener('mouseup', onUp);
        win.addEventListener('resize', placeBall);
        session.stopDragging = () => {
            dragging = false;
            element.removeEventListener('mousedown', onDown);
            doc.removeEventListener('mousemove', onMove);
            doc.removeEventListener('mouseup', onUp);
            win.removeEventListener('resize', placeBall);
        };
        session.cleanups.push(session.stopDragging);
    }

    private createFetchBridge(win: ImmersiveWindow) {
        return async (url: string | { url: string }, options: FetchOptions = {}) => {
            const urlString = typeof url === 'string' ? url : url.url;
            const method = options.method || 'GET';
            const headers = { ...options.headers };
            let body: string | undefined;
            if (options.body && !['GET', 'HEAD'].includes(method.toUpperCase())) {
                if (options.body instanceof win.URLSearchParams || options.body instanceof URLSearchParams) {
                    body = options.body.toString();
                    headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
                } else {
                    body = String(options.body);
                }
            }
            const response = await requestUrl({ url: urlString, method, headers, body, throw: false });
            return {
                ok: response.status >= 200 && response.status < 300,
                status: response.status,
                statusText: '',
                headers: {
                    get: (name: string) => {
                        const key = Object.keys(response.headers).find((item) => item.toLowerCase() === name.toLowerCase());
                        return key ? response.headers[key] : null;
                    },
                    forEach: (callback: (value: string, key: string) => void) => {
                        Object.entries(response.headers).forEach(([key, value]) => callback(value, key));
                    }
                },
                url: urlString,
                json: async () => response.json,
                text: async () => response.text,
                arrayBuffer: async () => response.arrayBuffer,
                clone: function () { return this; }
            };
        };
    }

    private loadSdk(session: WindowSession): Promise<void> {
        const win = session.window;
        const panel = session.panel;
        if (!panel) return Promise.reject(new Error('沉浸式翻译面板不存在'));
        return new Promise<void>((resolve, reject) => {
            let finished = false;
            const observer = new win.MutationObserver(() => checkReady());
            const finish = (error?: Error) => {
                if (finished) return;
                finished = true;
                win.clearTimeout(timer);
                observer?.disconnect();
                session.finishLoading();
                error ? reject(error) : resolve();
            };
            const checkReady = () => { if (panel.childElementCount > 0) finish(); };
            const timer = win.setTimeout(() => finish(new Error('沉浸式翻译 SDK 加载超时，请重试')), LOAD_TIMEOUT);
            observer.observe(panel, { childList: true, subtree: true });
            session.cancelLoading = () => finish(new Error('沉浸式翻译加载已取消'));
            // 先获取文本，确认会话仍有效后再执行，避免已移除的外链脚本晚到后复活界面。
            void requestUrl({ url: Url.SDK_URL, throw: false }).then((response) => {
                if (session.cancelled || win.closed || finished) return;
                if (response.status < 200 || response.status >= 300) throw new Error(`沉浸式翻译 SDK 加载失败 (${response.status})`);
                if (win.initImmersiveTranslate || win.destroyImmersiveTranslate ||
                    win.immersiveTranslateConfig !== session.config || win.GM_fetch !== session.bridge) {
                    throw new Error('当前窗口的沉浸式翻译环境已被其他实例替换');
                }
                for (const name of SDK_GLOBALS) {
                    session.previousGlobals.set(name, { existed: Reflect.has(win, name), value: Reflect.get(win, name) });
                }
                this.trackSdkSwitch(session);
                const script = win.document.createElement('script');
                session.script = script;
                script.addEventListener('error', () => finish(new Error('沉浸式翻译 SDK 执行失败')), { once: true });
                script.textContent = response.text;
                session.executed = true;
                try {
                    win.document.body.appendChild(script);
                } finally {
                    session.sdkInit = win.initImmersiveTranslate;
                    session.sdkDestroy = win.destroyImmersiveTranslate;
                    session.sdkFetch = win.GM_fetch;
                    for (const name of SDK_GLOBALS) session.sdkGlobals.set(name, Reflect.get(win, name));
                }
                if (!session.sdkInit || !session.sdkDestroy) throw new Error('沉浸式翻译 SDK 执行失败');
                checkReady();
            }).catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
        });
    }

    private trackSdkSwitch(session: WindowSession): void {
        const win = session.window;
        session.previousSwitch = win.immersiveTranslateSwitchTranslateState;
        session.previousSwitchDescriptor = Object.getOwnPropertyDescriptor(win, 'immersiveTranslateSwitchTranslateState');
        session.previousOnError = win.onerror;
        let current = session.previousSwitch;
        session.switchGetter = () => current;
        session.switchSetter = (value) => {
            current = value;
            session.sdkSwitch = value;
            // SDK 创建翻译引擎时先设置 onerror，再同步导出切换函数；只记录这次赋值的归属。
            session.sdkOnError = win.onerror;
        };
        Object.defineProperty(win, 'immersiveTranslateSwitchTranslateState', {
            configurable: true, enumerable: true,
            get: session.switchGetter, set: session.switchSetter
        });
    }

    public async deactivate(targetWindow?: Window): Promise<void> {
        const sessions = targetWindow ? [this.sessions.get(targetWindow)].filter((session): session is WindowSession => !!session) : [...this.sessions.values()];
        await Promise.all(sessions.map((session) => this.dispose(session)));
        if (targetWindow) await this.cleanups.get(targetWindow);
        else await Promise.all([...this.cleanups.values()]);
    }

    private dispose(session: WindowSession): Promise<void> {
        if (session.disposal) return session.disposal;
        session.cancelled = true;
        session.stopDragging?.();
        if (session.ball) session.ball.style.display = 'none';
        if (!session.executed || session.closing || session.window.closed) session.cancelLoading?.();
        // 未执行的会话也要串入旧清理链，避免快速开关时越过仍在恢复的 SDK。
        const disposal = (async () => {
            await session.previousCleanup?.catch(console.error);
            await this.cleanupSession(session);
        })();
        session.disposal = disposal;
        this.cleanups.set(session.window, disposal);
        void disposal.finally(() => {
            if (this.cleanups.get(session.window) === disposal) this.cleanups.delete(session.window);
        }).catch(console.error);
        return disposal;
    }

    private async cleanupSession(session: WindowSession): Promise<void> {
        const win = session.window;
        try {
            if (session.executed && !session.closing && !win.closed) {
                await session.loaded;
                const owned = win.initImmersiveTranslate === session.sdkInit && win.destroyImmersiveTranslate === session.sdkDestroy;
                if (owned) {
                    try {
                        const switchState = win.immersiveTranslateSwitchTranslateState;
                        if (switchState === session.sdkSwitch) await switchState?.('original');
                    } finally {
                        // 先恢复并释放翻译引擎，再通知 SDK 退出握手，避免恢复操作被转交给已退出的实例。
                        try {
                            session.sdkDestroy?.();
                        } finally {
                            win.document.dispatchEvent(new win.CustomEvent(SDK_STOP_EVENT));
                        }
                    }
                }
            }
        } finally {
            session.cleanups.forEach((cleanup) => cleanup());
            session.script?.remove();
            session.ball?.remove();
            if (win.immersiveTranslateConfig === session.config) {
                if (session.previousConfig === undefined) delete win.immersiveTranslateConfig;
                else win.immersiveTranslateConfig = session.previousConfig;
            }
            if (win.GM_fetch === session.bridge || (session.executed && win.GM_fetch === session.sdkFetch)) {
                if (session.previousFetch === undefined) delete win.GM_fetch;
                else win.GM_fetch = session.previousFetch;
            }
            if (session.executed && win.initImmersiveTranslate === session.sdkInit) {
                if (session.previousInit === undefined) delete win.initImmersiveTranslate;
                else win.initImmersiveTranslate = session.previousInit;
            }
            if (session.executed && win.destroyImmersiveTranslate === session.sdkDestroy) {
                if (session.previousDestroy === undefined) delete win.destroyImmersiveTranslate;
                else win.destroyImmersiveTranslate = session.previousDestroy;
            }
            if (session.sdkSwitch && win.onerror === session.sdkOnError) win.onerror = session.previousOnError;
            const switchDescriptor = Object.getOwnPropertyDescriptor(win, 'immersiveTranslateSwitchTranslateState');
            if (session.switchGetter && switchDescriptor?.get === session.switchGetter &&
                switchDescriptor.set === session.switchSetter) {
                if (session.previousSwitchDescriptor) {
                    Object.defineProperty(win, 'immersiveTranslateSwitchTranslateState', session.previousSwitchDescriptor);
                } else {
                    delete win.immersiveTranslateSwitchTranslateState;
                }
            }
            for (const [name, value] of session.sdkGlobals) {
                if (Reflect.get(win, name) !== value) continue;
                const previous = session.previousGlobals.get(name);
                if (previous?.existed) Reflect.set(win, name, previous.value);
                else Reflect.deleteProperty(win, name);
            }
            if (this.sessions.get(win) === session) this.sessions.delete(win);
        }
    }
}

const immersiveTranslate = ImmersiveTranslate.getInstance();
export default immersiveTranslate;

const activateIMT = immersiveTranslate.activate.bind(immersiveTranslate);
const deactivateIMT = immersiveTranslate.deactivate.bind(immersiveTranslate);
export { activateIMT, deactivateIMT };

export interface immersiveTranslateConfig {
    // 联盟 id
    partnerId: string,
    // 翻译按钮挂载点
    mountPoint: {
        selector: string;
        action: 'append' | 'child' | 'before' | 'replace';
    },
    // 翻译结果声明挂载点（可选）默认跟在翻译按钮后面
    disclaimerPoint: {
        selector: string;
        action: 'append' | 'child' | 'before' | 'replace';
    },
    pageRule: pageRule
}

export interface pageRule {
    mainFrameSelector?: string | string[];              // 翻译的根节点范围
    selectors?: string | string[];                      // 仅翻译匹配到的元素
    excludeSelectors?: string | string[];               // 排除元素，不翻译匹配的元素
    stayOriginalSelectors?: string | string[];          // 匹配的元素将保持原样。常用于论坛网站的标签。
    extraBlockSelectors?: string | string[];            // 额外的选择器，匹配的元素将作为 block 元素，独占一行。
    extraInlineSelectors?: string | string[];           // 额外的选择器，匹配的元素将作为 inline 元素。
    translationClasses?: string | string | string[];    // 为译文添加额外的 Class
    injectedCss?: string | string[];                    // 嵌入 CSS 样式
}
