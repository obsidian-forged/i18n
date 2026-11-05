import { requestUrl, RequestUrlResponse } from "obsidian";
import { t } from "src/locales";
import { normalizeOpenAIUrl } from "./url-helper";
import { parseTranslationResponse } from "./response-parser";

export interface DiagItem {
    status: 'pass' | 'fail' | 'warn' | 'na' | 'testing';
    value: string;
    latency?: number;
    tip?: string;
    rawResponse?: string;
    usage?: { prompt: number; completion: number };
}

export interface DiagnosticLog {
    stage: string;
    message: string;
    level: 'info' | 'warn' | 'error';
    details?: string;
}

export interface DeepDiagnosticReport {
    overallStatus: 'healthy' | 'warning' | 'degraded' | 'failed';
    endpoint: DiagItem;
    auth: DiagItem;
    model: DiagItem;
    systemRole: DiagItem;
    jsonMode: DiagItem;
    jsonSchema: DiagItem;
    translation: DiagItem;
    translationFix?: DiagItem;
    concurrency?: DiagItem;
    logs: DiagnosticLog[];
}

export class ConnectivityTester {
    private url: string;
    private key: string;
    private model: string;
    private engine: 'openai' | 'gemini' | 'ollama';
    private responseFormat: string;
    private reasoningEffort: string;
    private reasoningRejected = false;
    private timeout: number;
    private language: string;
    private style: string;
    private logs: DiagnosticLog[] = [];

    constructor(url: string, key: string, model: string, engine?: 'openai' | 'gemini' | 'ollama', responseFormat?: string, timeout?: number, language?: string, style?: string, reasoningEffort?: string) {
        this.url = (url || '').trim();
        this.key = (key || '').trim();
        this.model = (model || '').trim();
        this.engine = engine || 'openai';
        this.responseFormat = responseFormat || 'text';
        this.reasoningEffort = reasoningEffort || 'none';
        this.timeout = timeout || 60000;
        this.language = language || '简体中文';
        this.style = style || 'Technical';
    }

    /** 把推理强度合入请求体；'auto' 表示不干预服务商默认行为 */
    private withReasoning(body: Record<string, any>): Record<string, any> {
        if (!this.reasoningRejected && this.reasoningEffort && this.reasoningEffort !== 'auto') {
            body.reasoning_effort = this.reasoningEffort;
        }
        return body;
    }

    private addLog(stage: string, message: string, level: 'info' | 'warn' | 'error' = 'info', details?: string) {
        this.logs.push({ stage, message, level, details });
        console.log(`[Diagnostic][${stage}] ${message}${details ? ' | Details: ' + details : ''}`);
    }

    public getInitialReport(): DeepDiagnosticReport {
        return {
            overallStatus: 'warning',
            endpoint: { status: 'na', value: this.url },
            auth: { status: 'na', value: '***' },
            model: { status: 'na', value: this.model || 'N/A' },
            systemRole: { status: 'na', value: '等待中' },
            jsonMode: { status: 'na', value: '等待中' },
            jsonSchema: { status: 'na', value: '等待中' },
            translation: { status: 'na', value: '等待中' },
            translationFix: { status: 'na', value: '等待中' },
            concurrency: { status: 'na', value: '等待中' },
            logs: this.logs
        };
    }

    async runDeepDiagnostic(onProgress?: (report: DeepDiagnosticReport) => void): Promise<DeepDiagnosticReport> {
        this.logs = [];
        this.reasoningRejected = false;
        const report: DeepDiagnosticReport = {
            overallStatus: 'healthy',
            endpoint: { status: 'na', value: this.url },
            auth: { status: 'na', value: '***' },
            model: { status: 'na', value: this.model || 'N/A' },
            systemRole: { status: 'na', value: '未连通' },
            jsonMode: { status: 'na', value: '未连通' },
            jsonSchema: { status: 'na', value: '未连通' },
            translation: { status: 'na', value: '未连通' },
            translationFix: { status: 'na', value: '未连通' },
            concurrency: { status: 'na', value: '未连通' },
            logs: this.logs
        };

        // --- Stage 1: Endpoint & Basic Network ---
        report.endpoint.status = 'testing';
        onProgress?.(report);
        this.addLog('Endpoint', `正在测试到 ${this.url} 的连通性 (引擎: ${this.engine})`);

        const startTime = Date.now();
        const baseUrl = normalizeOpenAIUrl(this.url);
        // 根据引擎类型选择默认测试地址
        const defaultUrls: Record<string, string> = {
            openai: 'https://api.openai.com/v1',
            gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
            ollama: 'http://localhost:11434/v1'
        };
        const testUrl = baseUrl || defaultUrls[this.engine] || defaultUrls.openai;

        try {
            // 启发式检查
            if (this.url && !this.url.match(/^https?:\/\//)) {
                report.endpoint.status = 'warn';
                report.endpoint.tip = 'URL 必须以 http:// 或 https:// 开头';
                this.addLog('Endpoint', '协议异常 (请检查 http/https 头)', 'warn');
            }

            // Ollama 本地服务不走 /models 探测，而是直接 ping 根路径
            const probeUrl = this.engine === 'ollama' ? `${testUrl.replace(/\/v1$/, '')}/api/tags` : `${testUrl}/models`;
            const res = await this.safeRequest(probeUrl, 'GET', this.engine !== 'ollama');
            const latency = Date.now() - startTime;
            report.endpoint.latency = latency;

            if (res.status >= 200 && res.status < 300 || [401, 403, 405, 429].includes(res.status)) {
                report.endpoint.status = report.endpoint.status === 'warn' ? 'warn' : 'pass';
                report.endpoint.value = `${testUrl} (${res.status})`;
                this.addLog('Endpoint', `成功连通 (耗时: ${latency}ms, 状态码: ${res.status})`);
            } else if (res.status === 404) {
                report.endpoint.status = 'warn';
                report.endpoint.value = `${testUrl} (${res.status})`;
                const tip404 = this.engine === 'gemini'
                    ? '端点返回 404，Gemini 使用 /v1beta 路径，请确认接口地址正确'
                    : (t('Settings.Ai.TestFail404') || '端点未找到，将继续后续测试...');
                report.endpoint.tip = tip404;
                this.addLog('Endpoint', `探测端点返回 404，忽略并继续...`, 'warn');
            } else if (res.status === 406) {
                report.endpoint.status = 'fail';
                report.endpoint.tip = '检测到非 API 响应（收到 HTML 网页）。这通常是因为：\n1. 误填了服务商官网地址（如 https://openai.com）\n2. 接口路径不完整（确保包含 /v1 或对应后缀）\n3. 代理服务器（如 Clash）拦截并返回了登录/验证页面';
                report.endpoint.value = `响应格式冲突 (${res.status})`;
                report.endpoint.rawResponse = res.text?.substring(0, 800);
                report.overallStatus = 'failed';
                this.addLog('Endpoint', `检测到 HTML 网页内容，请检查接口地址是否配置为官网主页`, 'error');
                onProgress?.(report);
                return report;
            } else {
                report.endpoint.status = 'fail';
                report.endpoint.tip = res.status === 404 ? '接口路径未找到 (404)。请确认地址是否包含 /v1 或服务商要求的特定后缀。' : `服务器返回异常状态码: ${res.status}`;
                report.endpoint.value = `HTTP ${res.status}`;
                report.endpoint.rawResponse = res.text?.substring(0, 800);
                report.overallStatus = 'failed';
                this.addLog('Endpoint', `请求失败，服务器返回状态码: ${res.status}`, 'error', res.text?.substring(0, 800));
                onProgress?.(report);
                return report;
            }
        } catch (err: any) {
            report.endpoint.status = 'fail';
            report.overallStatus = 'failed';
            // 精细化网络错误诊断
            const msg = err.message || '';
            if (msg.includes('ECONNREFUSED') || msg.includes('ERR_CONNECTION_REFUSED')) {
                report.endpoint.tip = this.engine === 'ollama'
                    ? 'Ollama 服务连接失败。请确认 Ollama 已启动（ollama serve）且监听端口正确。'
                    : '目标服务器拒绝连接。请检查：\n1. 接口地址和端口是否正确\n2. 如果使用了代理（如 Clash/V2Ray），请确认其工作正常\n3. 检查插件内的“网络代理”设置是否配置正确';
                report.endpoint.value = '连接被拒绝';
                report.endpoint.rawResponse = msg;
                this.addLog('Endpoint', `连接被拒绝 (ECONNREFUSED): ${msg}`, 'error');
            } else if (msg.includes('ENOTFOUND') || msg.includes('ERR_NAME_NOT_RESOLVED') || msg.includes('getaddrinfo')) {
                report.endpoint.tip = '域名解析失败。请检查：\n1. 地址拼写是否正确\n2. 当前网络或代理环境是否可以解析该域名';
                report.endpoint.value = 'DNS 解析失败';
                report.endpoint.rawResponse = msg;
                this.addLog('Endpoint', `DNS 解析失败: ${msg}`, 'error');
            } else if (msg.includes('ETIMEDOUT') || msg.includes('timeout')) {
                report.endpoint.tip = '请求超时。可能原因：\n1. 需配置系统代理或插件内部代理\n2. 服务商由于地理位置原因无法直接访问\n3. 代理节点响应过慢';
                report.endpoint.value = '连接超时';
                report.endpoint.rawResponse = msg;
                this.addLog('Endpoint', `连接超时: ${msg}`, 'error');
            } else if (msg.includes('ERR_TLS') || msg.includes('CERT') || msg.includes('SSL')) {
                report.endpoint.tip = '证书校验失败（SSL/TLS）。这通常是因为：\n1. 开启了代理软件的“HTTPS 劫持/解析”功能\n2. 使用了自签名证书的中转接口\n3. 系统根证书库缺失';
                report.endpoint.value = '安全证书错误';
                report.endpoint.rawResponse = msg;
                this.addLog('Endpoint', `TLS 证书握手失败: ${msg}`, 'error');
            } else {
                report.endpoint.tip = `底层网络异常: ${msg}。建议检查网络环境或尝试更换代理节点。`;
                report.endpoint.value = '网络异常';
                report.endpoint.rawResponse = err instanceof Error ? (err.stack || msg) : msg;
                this.addLog('Endpoint', `底层网络异常: ${msg}`, 'error', err instanceof Error ? err.stack : undefined);
            }
            onProgress?.(report);
            return report;
        }
        onProgress?.(report);

        // --- Stage 2: Auth ---
        report.auth.status = 'testing';
        onProgress?.(report);
        this.addLog('Auth', '尝试验证 API Key / Token 可用性');

        // Ollama 本地部署通常无需鉴权，直接跳过
        if (this.engine === 'ollama') {
            report.auth.status = 'pass';
            report.auth.value = '本地服务 (免鉴权)';
            report.auth.latency = 0;
            this.addLog('Auth', 'Ollama 本地引擎，跳过 API Key 鉴权');
        } else {
            const authStartTime = Date.now();
            const authProbeUrl = `${testUrl}/models`;
            const authRes = await this.safeRequest(authProbeUrl, 'GET', true);
            report.auth.latency = Date.now() - authStartTime;

            if (authRes.status === 200) {
                report.auth.status = 'pass';
                report.auth.value = '有效';
                this.addLog('Auth', 'API Key 校验通过');
            } else if (authRes.status === 404 && report.endpoint.status === 'warn') {
                report.auth.status = 'warn';
                report.auth.value = '跳过 (404)';
                report.auth.tip = '鉴权端点不可用，将在后续对话测试中验证密钥有效性';
                this.addLog('Auth', '缺少 /models 端点，跳过鉴权，将在后续步骤中补偿', 'warn');
            } else {
                report.auth.status = 'fail';
                report.auth.value = `HTTP ${authRes.status}`;
                if (authRes.status === 401) {
                    report.auth.tip = '鉴权失败 (401)。请检查：\n1. API Key 填写是否正确（注意不要包含多余空格）\n2. 该密钥是否已被禁用或额度已用尽';
                } else if (authRes.status === 403) {
                    report.auth.tip = '访问受限 (403)。请检查：\n1. 该密钥是否有权访问对应模型\n2. 账号是否存在地区访问限制（需配合代理）';
                } else if (authRes.status === 429) {
                    report.auth.tip = '配额耗尽或频率受限 (429)。请确认您的账户余额或降低并发请求数。';
                } else {
                    report.auth.tip = `鉴权端点返回意外状态码: ${authRes.status}`;
                }
                report.auth.rawResponse = authRes.text?.substring(0, 1000);
                report.overallStatus = 'failed';
                this.addLog('Auth', `身份鉴权失败，状态码: ${authRes.status}`, 'error', authRes.text?.substring(0, 1000));
                onProgress?.(report);
                return report;
            }
        }
        onProgress?.(report);

        // --- Stage 3: Model Availability ---
        if (!this.model) {
            report.model.status = 'warn';
            report.model.tip = '未填写模型名称，跳过模型可用性检测';
            this.addLog('Model', '未填写模型名称，跳过模型可用性检测', 'warn');
            return report;
        }

        report.model.status = 'testing';
        onProgress?.(report);
        this.addLog('Model', `探测所选模型服务节点: [${this.model}]`);

        const modelStartTime = Date.now();
        const modelRes = await this.safeRequest(`${testUrl}/chat/completions`, 'POST', true, {
            model: this.model,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1
        });
        report.model.latency = Date.now() - modelStartTime;

        if (modelRes.status === 200) {
            report.model.status = 'pass';
            this.addLog('Model', `模型 ${this.model} 通道畅通，已能够生成对话`);
        } else {
            report.model.status = 'fail';
            report.model.value = `HTTP ${modelRes.status}`;
            if (modelRes.status === 404) {
                report.model.tip = `找不到模型 "${this.model}" (404)。请确模型名称拼写无误，且您的账号有权通过 API 访问该模型。`;
            } else if (modelRes.status === 400) {
                report.model.tip = '请求格式错误 (400)。可能原因：\n1. 模型名称不正确\n2. 该模型不支持 /chat/completions 接口';
            } else {
                report.model.tip = `模型探针返回错误码: ${modelRes.status}`;
            }
            report.model.rawResponse = modelRes.text?.substring(0, 1000);
            report.overallStatus = 'failed';
            this.addLog('Model', `向模型发送探针被拒绝或找不到该模型，状态码 ${modelRes.status}`, 'error', modelRes.text?.substring(0, 1000));
            onProgress?.(report);
            return report;
        }
        onProgress?.(report);

        // --- Stage 3.5: System Role Support ---
        report.systemRole.status = 'testing';
        onProgress?.(report);
        this.addLog('SystemRole', '投递包含 system 前置角色的对白以测试其服从度');

        const sysRoleStartTime = Date.now();
        const sysRoleRes = await this.safeRequest(`${testUrl}/chat/completions`, 'POST', true, {
            model: this.model,
            messages: [
                { role: 'system', content: 'You are a helpful assistant. Reply only with: OK' },
                { role: 'user', content: 'hi' }
            ],
            max_tokens: 5
        });
        report.systemRole.latency = Date.now() - sysRoleStartTime;

        if (sysRoleRes.status === 200) {
            report.systemRole.status = 'pass';
            report.systemRole.value = '已支持';
            this.addLog('SystemRole', 'System 身份槽响应正常，允许承载系统提示词');
        } else {
            report.systemRole.status = 'fail';
            report.systemRole.tip = t('Settings.Ai.DiagTipSystemRole');
            report.overallStatus = report.overallStatus === 'healthy' ? 'warning' : report.overallStatus;
            this.addLog('SystemRole', `模型拒绝了 system 角色扮演输入 (${sysRoleRes.status})`, 'warn');
        }
        onProgress?.(report);

        // --- Stage 4: JSON Mode Test ---
        report.jsonMode.status = 'testing';
        onProgress?.(report);
        this.addLog('Capabilities', '探测原生 JSON_OBJECT 强制输出特性适配程度');
        const jsonModeRes = await this.safeRequest(`${testUrl}/chat/completions`, 'POST', true, this.withReasoning({
            model: this.model,
            messages: [{ role: 'user', content: 'respond with json: {"ok":true}' }],
            response_format: { type: 'json_object' },
            max_tokens: 128
        }));
        if (jsonModeRes.status === 200) {
            report.jsonMode.status = 'pass';
            report.jsonMode.value = '已支持';
            this.addLog('Capabilities', '探测通过：原生 JSON_OBJECT 强制输出工作正常');
        } else {
            report.jsonMode.status = 'warn';
            report.jsonMode.tip = '该模型不支持原生 JSON_OBJECT，建议在“响应格式”中回退为 Text';
            report.overallStatus = report.overallStatus === 'healthy' ? 'warning' : report.overallStatus;
            this.addLog('Capabilities', `模型明确拒绝或不支持 JSON 模式强制约束，状态码: ${jsonModeRes.status}`, 'warn');
        }
        onProgress?.(report);

        // --- Stage 5: Structured Outputs (JSON Schema) Test ---
        report.jsonSchema.status = 'testing';
        onProgress?.(report);
        this.addLog('Capabilities', '探测高级特性：结构化输出 (JSON Schema 严格遵循)');
        const jsonSchemaRes = await this.safeRequest(`${testUrl}/chat/completions`, 'POST', true, this.withReasoning({
            model: this.model,
            messages: [{ role: 'user', content: 'respond with schema' }],
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: "test",
                    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
                    strict: true
                }
            },
            max_tokens: 128
        }));
        if (jsonSchemaRes.status === 200) {
            report.jsonSchema.status = 'pass';
            report.jsonSchema.value = '已支持';
            this.addLog('Capabilities', '探测通过：基于 JSON Schema 的高度结构化约束功能完好');
        } else if (this.responseFormat !== 'json_schema') {
            // 模型没有该能力，但用户当前并未选用它 —— 纯信息提示，不构成问题
            report.jsonSchema.status = 'na';
            report.jsonSchema.value = '未使用';
            report.jsonSchema.tip = `该模型不支持原生 JSON_SCHEMA（HTTP ${jsonSchemaRes.status}）。你当前的响应格式是 "${this.responseFormat}"，并不依赖这项能力，可以忽略本条。`;
            this.addLog('Capabilities', `模型未实现 JSON Schema 严格约束；当前响应格式为 "${this.responseFormat}"，不受影响`, 'info');
        } else {
            report.jsonSchema.status = 'warn';
            report.jsonSchema.tip = '该模型不支持原生 JSON_SCHEMA，而你的响应格式正设为 json_schema，翻译请求会被直接拒绝。请改为 Text 或 JSON Object 后重试。';
            report.overallStatus = report.overallStatus === 'healthy' ? 'warning' : report.overallStatus;
            this.addLog('Capabilities', `高级结构化输出功能遭拒或未实现，状态码: ${jsonSchemaRes.status}`, 'warn');
        }
        onProgress?.(report);

        // --- Stage 6: Translation Simulation (End-to-End) ---
        report.translation.status = 'testing';
        onProgress?.(report);
        this.addLog('Translation', '发起微型翻译沙盒进行 E2E 全链路终极模拟...');

        const translationBody: any = {
            model: this.model,
            messages: [
                {
                    role: 'system',
                    content: `You are a translator. Translate the input JSON array. Each object has "i" (id, keep unchanged) and "s" (source text). Return a JSON array where each object has "i" and "t" (translated text). Target language: ${this.language}. Style: ${this.style}. ONLY return the JSON array, no other text.`
                },
                {
                    role: 'user',
                    content: JSON.stringify([
                        { i: 1, s: "Settings for ${filename}" },
                        { i: 2, s: "✨ Shiny" }
                    ])
                }
            ],
            max_tokens: 1024,
            temperature: 0.3,
        };

        // 使用用户实际选择的 response_format
        if (this.responseFormat === 'json_object') {
            translationBody.response_format = { type: 'json_object' };
        } else if (this.responseFormat === 'json_schema') {
            translationBody.response_format = {
                type: 'json_schema',
                json_schema: {
                    name: "translation_result",
                    schema: {
                        type: "object",
                        properties: {
                            items: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: { i: { type: "number" }, t: { type: "string" } },
                                    required: ["i", "t"],
                                    additionalProperties: false
                                }
                            }
                        },
                        required: ["items"],
                        additionalProperties: false
                    },
                    strict: true
                }
            };
        }
        // 'text' 模式不设置 response_format

        // 注入推理强度：关闭后翻译不再被思维链抢占输出额度
        this.withReasoning(translationBody);

        const transStartTime = Date.now();
        try {
            const transRes = await this.safeRequest(`${testUrl}/chat/completions`, 'POST', true, translationBody);
            const transLatency = Date.now() - transStartTime;
            report.translation.latency = transLatency;

            if (transRes.status !== 200) {
                report.translation.status = 'fail';
                report.translation.value = `HTTP ${transRes.status}`;
                let errBody: any = null;
                try { errBody = typeof transRes.json === 'object' ? transRes.json : JSON.parse(transRes.text); } catch { }
                const errMsg = errBody?.error?.message || errBody?.message || '';

                if (transRes.status === 400 && this.responseFormat !== 'text') {
                    report.translation.tip = `请求被拒绝 (400)。极大概率是该模型不支持 "${this.responseFormat}" 响应格式。建议将其改为 Text 模式重试。` + (errMsg ? `\n详情: ${errMsg}` : '');
                } else {
                    report.translation.tip = `翻译请求失败 (${transRes.status})。` + (errMsg ? `说明: ${errMsg}` : '请检查网络或模型配额。');
                }
                report.translation.rawResponse = transRes.text?.substring(0, 1000);
                report.overallStatus = 'failed';
                this.addLog('Translation', `翻译模拟请求失败，状态码: ${transRes.status}`, 'error', transRes.text?.substring(0, 1000));
            } else {
                let parseSuccess = false;
                let emptyReason = '';
                let reasoningTokens = 0;
                try {
                    const body = typeof transRes.json === 'object' ? transRes.json : JSON.parse(transRes.text);
                    const choice = body?.choices?.[0];
                    const content = choice?.message?.content;
                    const finish = choice?.finish_reason;
                    reasoningTokens = body?.usage?.completion_tokens_details?.reasoning_tokens || 0;
                    if (content) {
                        let resultArray: any[] = [];
                        try {
                            resultArray = parseTranslationResponse(content);
                        } catch (e: any) {
                            this.addLog('Translation', `格式修复引擎通报：检测到非标准响应载荷，正在尝试强制抢救...`, 'warn');
                        }

                        if (resultArray && resultArray.length > 0) {
                            const hasCorrectFields = resultArray.every((item: any) =>
                                typeof item.i === 'number' && typeof item.t === 'string'
                            );
                            const idsMatch = resultArray.some((item: any) => item.i === 1 || item.i === 2);

                            if (hasCorrectFields && idsMatch) {
                                parseSuccess = true;
                                report.translation.status = 'pass';
                                report.translation.value = `✔ 通过 (${transLatency}ms)`;
                                this.addLog('Translation', `✔ 沙盒全链路通过：成功捕获并重组出 ${resultArray.length} 条元数据，响应耗时 ${transLatency}ms`);

                                if (transRes.json?.usage) {
                                    report.translation.usage = {
                                        prompt: transRes.json.usage.prompt_tokens,
                                        completion: transRes.json.usage.completion_tokens
                                    };
                                }
                            }
                        }
                    } else if (finish === 'length' && reasoningTokens > 0) {
                        emptyReason = `模型的思维链吃光了整份输出额度（推理占用 ${reasoningTokens} tokens，finish_reason=length），正式回答区 content 为空。这是"推理模型"的通病：翻译任务并不需要推理，开启它只会挤占输出空间。`;
                    } else if (finish === 'length') {
                        emptyReason = `输出被 max_tokens 截断（finish_reason=length），正式回答区为空。`;
                    } else {
                        emptyReason = `响应中没有 content 字段（finish_reason=${finish || '未知'}）。`;
                    }
                } catch (e: any) {
                    this.addLog('Translation', `底层提取内容时发生解析错: ${e.message}`, 'error');
                }

                if (!parseSuccess) {
                    report.translation.status = 'fail';
                    report.translation.value = '格式解析失败';
                    const rawBody = typeof transRes.json === 'object' ? JSON.stringify(transRes.json, null, 2) : transRes.text;
                    let contentPreview = '';
                    try {
                        const body = typeof transRes.json === 'object' ? transRes.json : JSON.parse(transRes.text);
                        contentPreview = body?.choices?.[0]?.message?.content || '';
                    } catch { }

                    const lines = [`模型返回了无法被解析的内容。当前选择格式: "${this.responseFormat}"。`];
                    if (emptyReason) lines.push(`原因: ${emptyReason}`);
                    if (contentPreview) lines.push(`模型实际输出预览: "${contentPreview.substring(0, 200)}"`);

                    if (reasoningTokens > 0) {
                        lines.push(`建议: 该模型是推理模型。把「推理强度」设为"关闭推理"（或换成非推理模型）后重试，翻译不需要思维链。`);
                    } else if (contentPreview) {
                        lines.push(`建议: 模型输出了非 JSON 文字。可在「响应格式」中改用 JSON Object，或检查系统提示词是否被模型忽略。`);
                    } else {
                        lines.push(`建议: 响应体里没有正文。请检查服务商是否返回了内容审核拦截、或该模型的接口形态是否为标准 /chat/completions。`);
                    }

                    report.translation.tip = lines.join('\n');
                    report.translation.rawResponse = rawBody;
                    report.overallStatus = 'failed';
                    this.addLog('Translation', '模型生成的内容无法解析，请检查服务商返回的数据或响应格式是否正确。', 'error', rawBody);
                }

                if (parseSuccess && transLatency > this.timeout * 0.8) {
                    report.translation.status = 'warn';
                    report.translation.tip = t('Settings.Ai.DiagTipLatencyWarn');
                    report.overallStatus = report.overallStatus === 'healthy' ? 'warning' : report.overallStatus;
                    this.addLog('Translation', `速率警报：模拟请求已消耗 ${transLatency}ms，逼近超时极值 ${this.timeout}ms。`, 'warn');
                }
            }
        } catch (err: any) {
            report.translation.status = 'fail';
            report.translation.latency = Date.now() - transStartTime;
            const msg = err.message || '';
            if (msg.includes('timeout')) {
                report.translation.tip = `翻译模拟请求超时 (${this.timeout}ms)。可能是网络链路过慢或服务器响应迟钝。`;
                report.translation.value = '超时';
            } else {
                report.translation.tip = `请求过程发生异常: ${msg}`;
                report.translation.value = '异常';
            }
            report.translation.rawResponse = err instanceof Error ? (err.stack || msg) : msg;
            report.overallStatus = 'failed';
            this.addLog('Translation', `全链路测试直接抛出底层请求错误: ${err.message}`, 'error');
        }
        onProgress?.(report);

        // --- Stage 6.5: Fix Function Simulation ---
        report.translationFix!.status = 'testing';
        onProgress?.(report);
        this.addLog('Fix', '探测单条翻译修复（Fix API）链路响应质量');

        const fixStartTime = Date.now();
        const fixBody = this.withReasoning({
            model: this.model,
            messages: [
                {
                    role: 'system',
                    content: `You are a Translation Repair Specialist. Return ONLY the fixed translation string for ${this.language}. No explanations.`
                },
                {
                    role: 'user',
                    content: 'Source: "Save changes"; Broken: "保存 [错误]"; Error: "Bracket mismatch"'
                }
            ],
            max_tokens: 256,
            temperature: 0.3
        });

        try {
            const fixRes = await this.safeRequest(`${testUrl}/chat/completions`, 'POST', true, fixBody);
            report.translationFix!.latency = Date.now() - fixStartTime;
            if (fixRes.status === 200) {
                const content = (fixRes.json?.choices?.[0]?.message?.content || fixRes.text || '').trim();
                if (content && content.length < 100) {
                    report.translationFix!.status = 'pass';
                    report.translationFix!.value = `✔ 通过 (${report.translationFix!.latency}ms)`;
                    this.addLog('Fix', '修复链路握手成功，模型能够产出纯净的单条修正建议');
                } else {
                    report.translationFix!.status = 'warn';
                    report.translationFix!.tip = '修复链路返回内容过多或格式不纯。这可能会影响翻译修复的准确度。';
                    this.addLog('Fix', '修复链路响应异常，建议检查 Prompt 是否被模型误解', 'warn');
                }
            } else {
                report.translationFix!.status = 'fail';
                report.translationFix!.tip = `修复请求失败 (${fixRes.status})。请确认模型是否支持短文本对答。`;
                this.addLog('Fix', `修复链路测试失败，状态码: ${fixRes.status}`, 'error');
            }
        } catch (err: any) {
            report.translationFix!.status = 'fail';
            this.addLog('Fix', `修复链路请求崩溃: ${err.message}`, 'error');
        }
        onProgress?.(report);

        // --- Stage 7: Concurrency Burst Test ---
        if (report.translation.status === 'pass') {
            report.concurrency!.status = 'testing';
            onProgress?.(report);
            this.addLog('Concurrency', '正在模拟并发连发以探测频率限制...');

            const burstCount = 3;
            const burstStart = Date.now();
            try {
                const burstBody = {
                    model: this.model,
                    messages: [{ role: 'user', content: 'hi' }],
                    max_tokens: 1
                };
                const burstPromises = Array.from({ length: burstCount }, () =>
                    this.safeRequest(`${testUrl}/chat/completions`, 'POST', true, burstBody)
                );
                const burstResults = await Promise.all(burstPromises);
                report.concurrency!.latency = Date.now() - burstStart;

                const has429 = burstResults.some(r => r.status === 429);
                const allOk = burstResults.every(r => r.status === 200);

                if (allOk) {
                    report.concurrency!.status = 'pass';
                    report.concurrency!.value = `${burstCount} 并发全部通过`;
                    this.addLog('Concurrency', `${burstCount} 个并发请求全部成功 (${report.concurrency!.latency}ms)`);
                } else if (has429) {
                    report.concurrency!.status = 'warn';
                    report.concurrency!.value = '触发频率限制 (429)';
                    report.concurrency!.tip = t('Settings.Ai.DiagTipConcurrency');
                    report.overallStatus = report.overallStatus === 'healthy' ? 'warning' : report.overallStatus;
                    this.addLog('Concurrency', `${burstCount} 并发中检测到 429 频率限制，建议降低并发数`, 'warn');
                } else {
                    const statuses = burstResults.map(r => r.status).join(', ');
                    report.concurrency!.status = 'warn';
                    report.concurrency!.value = `部分异常 (${statuses})`;
                    report.concurrency!.tip = '并发请求部分失败，批量翻译可能不稳定';
                    report.overallStatus = report.overallStatus === 'healthy' ? 'warning' : report.overallStatus;
                    this.addLog('Concurrency', `并发测试返回混合状态: ${statuses}`, 'warn');
                }
            } catch (err: any) {
                report.concurrency!.status = 'warn';
                report.concurrency!.value = '测试异常';
                report.concurrency!.tip = '并发测试过程中出错，无法判定频率限制情况';
                report.concurrency!.latency = Date.now() - burstStart;
                this.addLog('Concurrency', `并发测试异常: ${err.message}`, 'warn');
            }
            onProgress?.(report);
        }

        return report;
    }

    /** 只接受明确针对推理参数的拒绝，避免把其他请求错误误判为能力限制。 */
    private rejectsReasoning(res: { json: unknown; text: string }): boolean {
        let payload: unknown;
        try { payload = res.json; } catch { payload = undefined; }
        if (!payload) {
            try { payload = JSON.parse(res.text); } catch { payload = undefined; }
        }
        const responseError = payload && typeof payload === 'object' && 'error' in payload ? payload.error : payload;
        const error = responseError && typeof responseError === 'object'
            ? responseError as { param?: unknown; code?: unknown; message?: unknown }
            : undefined;
        if (error?.param === 'reasoning_effort' && typeof error.code === 'string' &&
            /^(unknown|unrecognized|unsupported|unexpected|invalid|extra)_(parameter|argument|field|value)$/.test(error.code)) {
            return true;
        }
        const message = typeof error?.message === 'string' ? error.message : (res.text || '');
        return /\b(unknown|unrecognized|unsupported|unexpected|invalid|extra)\s+(request\s+)?(parameter|argument|field|input)(\s+(supplied|provided))?\s*:?\s*['"`]?reasoning_effort\b/i.test(message) ||
            /\breasoning_effort['"`]?\s*(:\s*)?(is\s+)?(not\s+(supported|allowed|permitted)|unsupported|unexpected)\b/i.test(message);
    }

    private async safeRequest(url: string, method: string, includeAuth = false, body?: any): Promise<RequestUrlResponse> {
        const headers: Record<string, string> = {};
        if (includeAuth) headers['Authorization'] = `Bearer ${this.key}`;
        if (body) headers['Content-Type'] = 'application/json';

        try {
            const res = await requestUrl({
                url,
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined,
                throw: false
            });

            if (!this.reasoningRejected && body?.reasoning_effort &&
                (res.status === 400 || res.status === 422) && this.rejectsReasoning(res)) {
                this.reasoningRejected = true;
                const retryBody = { ...body };
                delete retryBody.reasoning_effort;
                this.addLog('Capabilities', '服务商不接受 reasoning_effort 参数，已移除并重试，本轮后续检测不再发送该参数。', 'info');
                return this.safeRequest(url, method, includeAuth, retryBody);
            }

            // 安全防御：如果接口返回的是带有 HTML 的网页文件，说明填错了基础地址（比如误填了官网主页）
            if (res.status >= 200 && res.status < 300 && res.text) {
                const head = res.text.trim().toLowerCase();
                if (head.startsWith('<!doctype') || head.startsWith('<html')) {
                    this.addLog('Network', `安全降级拦截：向 ${url} 请求时收到 HTML 载荷。判断为接口地址配置错误（可能误填为官网主页），已自动阻断后续无效请求。`, 'warn');
                    return { status: 406, text: res.text, json: undefined } as any;
                }
            }

            return res;
        } catch (err: any) {
            if (err.message?.includes('timeout')) return { status: 408 } as any;
            throw err;
        }
    }
}
