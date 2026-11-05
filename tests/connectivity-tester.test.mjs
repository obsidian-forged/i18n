import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const silentConsole = { log() {}, warn() {} };

function loadModule(relativePath, imports = {}) {
    const filename = path.join(projectRoot, relativePath);
    const compiled = transformSync(fs.readFileSync(filename, 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'node20'
    }).code;
    const module = { exports: {} };
    const requireSource = (id) => {
        assert.ok(Object.hasOwn(imports, id), `未预期的模块: ${id}`);
        return imports[id];
    };
    new Function('require', 'module', 'exports', 'console', compiled)(
        requireSource, module, module.exports, silentConsole
    );
    return module.exports;
}

const parser = loadModule('src/utils/ai/response-parser.ts');
const urlHelper = loadModule('src/utils/ai/url-helper.ts');

function response(status, json) {
    return { status, json, text: JSON.stringify(json), headers: {} };
}

function fixture(reject, reasoningEffort = 'none') {
    const requests = [];
    const requestUrl = async (options) => {
        const body = options.body ? JSON.parse(options.body) : undefined;
        const request = { ...options, body };
        requests.push(request);
        const rejected = reject?.(request);
        if (rejected) return rejected;
        if (options.method === 'GET') return response(200, { data: [{ id: 'fixture-model' }] });
        const prompt = body.messages[0].content;
        let content = 'OK';
        if (prompt.startsWith('You are a translator.')) {
            content = JSON.stringify([{ i: 1, t: '${filename} 的设置' }, { i: 2, t: '✨ 闪亮' }]);
        } else if (prompt.startsWith('You are a Translation Repair Specialist.')) {
            content = '保存更改';
        } else if (body.response_format) {
            content = '{"ok":true}';
        }
        return response(200, {
            choices: [{ message: { content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 20 }
        });
    };
    const { ConnectivityTester } = loadModule('src/utils/ai/connectivity-tester.ts', {
        obsidian: { requestUrl },
        'src/locales': { t: (key) => key },
        './url-helper': urlHelper,
        './response-parser': parser
    });
    const tester = new ConnectivityTester(
        'https://fixture.invalid/v1', 'fixture-key', 'fixture-model',
        'openai', 'text', 60000, '简体中文', 'Technical', reasoningEffort
    );
    return { tester, requests };
}

for (const status of [400, 422]) {
    test(`HTTP ${status} 明确拒绝推理参数时重试，同轮后续检测不再发送该参数`, async () => {
        const f = fixture(({ body }) => body?.reasoning_effort
            ? response(status, { error: { message: 'Unknown parameter: reasoning_effort' } })
            : undefined);
        const report = await f.tester.runDeepDiagnostic();
        assert.equal(report.overallStatus, 'healthy');
        assert.equal(report.translation.status, 'pass');
        assert.equal(report.translationFix.status, 'pass');
        const rejectedIndex = f.requests.findIndex(({ body }) => body?.reasoning_effort);
        assert.ok(rejectedIndex >= 0);
        const original = f.requests[rejectedIndex];
        const retry = f.requests[rejectedIndex + 1];
        const { reasoning_effort, ...expectedBody } = original.body;
        assert.equal(reasoning_effort, 'none');
        assert.equal(retry.url, original.url);
        assert.equal(retry.method, original.method);
        assert.deepEqual(retry.headers, original.headers);
        assert.deepEqual(retry.body, expectedBody);
        assert.ok(f.requests.slice(rejectedIndex + 1).every(({ body }) =>
            !body || !Object.hasOwn(body, 'reasoning_effort')));
    });
}

test('同一实例重新诊断时重新探测推理参数，拒绝状态不跨轮保留', async () => {
    const f = fixture(({ body }) => body?.reasoning_effort
        ? response(400, { error: { message: "Unsupported parameter: 'reasoning_effort'" } })
        : undefined);
    await f.tester.runDeepDiagnostic();
    const firstRunLength = f.requests.length;
    const report = await f.tester.runDeepDiagnostic();
    assert.equal(report.overallStatus, 'healthy');
    assert.equal(f.requests.slice(0, firstRunLength).filter(({ body }) => body?.reasoning_effort).length, 1);
    assert.equal(f.requests.slice(firstRunLength).filter(({ body }) => body?.reasoning_effort).length, 1);
});

test('自动推理配置不注入参数，也不因错误报文提及参数而重试', async () => {
    const f = fixture(({ body }) => body?.response_format
        ? response(400, { error: { message: 'Unknown parameter: reasoning_effort' } })
        : undefined, 'auto');
    const report = await f.tester.runDeepDiagnostic();
    assert.equal(report.translation.status, 'pass');
    assert.ok(f.requests.every(({ body }) => !body || !Object.hasOwn(body, 'reasoning_effort')));
    assert.equal(f.requests.filter(({ body }) => body?.response_format).length, 2);
});

for (const message of [
    'Unknown parameter: response_format; reasoning_effort is accepted.',
    'Invalid model. Unsupported reasoning_effort appears only in the documentation.'
]) {
    test(`不因无关错误中提及参数而降级: ${message}`, async () => {
        const f = fixture(() => response(400, { error: { message } }));
        const result = await f.tester.safeRequest('https://fixture.invalid/v1/chat/completions', 'POST', true, {
            model: 'fixture-model', reasoning_effort: 'none'
        });
        assert.equal(result.status, 400);
        assert.equal(f.requests.length, 1);
    });
}

test('非 400/422 错误保留，不重试不支持参数的报文', async () => {
    const f = fixture(() => response(500, { error: { message: 'Unknown parameter: reasoning_effort' } }));
    const result = await f.tester.safeRequest('https://fixture.invalid/v1/chat/completions', 'POST', true, {
        reasoning_effort: 'none'
    });
    assert.equal(result.status, 500);
    assert.equal(f.requests.length, 1);
});

test('移除参数后的请求仍失败时保留响应，最多回退一次', async () => {
    const f = fixture(() => response(422, { error: { message: 'Unknown parameter: reasoning_effort' } }));
    const result = await f.tester.safeRequest('https://fixture.invalid/v1/chat/completions', 'POST', true, {
        model: 'fixture-model', reasoning_effort: 'none'
    });
    assert.equal(result.status, 422);
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].body.reasoning_effort, undefined);
});

test('结构化错误明确标识推理参数不受支持时允许回退', async () => {
    const f = fixture(({ body }) => body?.reasoning_effort
        ? response(400, { error: { code: 'unsupported_parameter', param: 'reasoning_effort', message: 'Unsupported option' } })
        : undefined);
    const report = await f.tester.runDeepDiagnostic();
    assert.equal(report.overallStatus, 'healthy');
    assert.equal(f.requests.filter(({ body }) => body?.reasoning_effort).length, 1);
});

for (const message of [
    "Unsupported parameter: 'reasoning_effort' is not supported with this model.",
    "Parameter 'reasoning_effort' is not supported.",
    'Unrecognized request argument supplied: reasoning_effort',
    'Invalid parameter: reasoning_effort'
]) {
    test(`明确指向推理参数的拒绝文字允许回退: ${message}`, async () => {
        const f = fixture(({ body }) => body?.reasoning_effort
            ? response(400, { error: { message } })
            : undefined);
        const report = await f.tester.runDeepDiagnostic();
        assert.equal(report.overallStatus, 'healthy');
        assert.equal(f.requests.filter(({ body }) => body?.reasoning_effort).length, 1);
    });
}
