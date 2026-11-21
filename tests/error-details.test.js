import test from 'node:test';
import assert from 'node:assert/strict';
import { statusError, readNonStreamingResponse, readSSEStream, normalizeFetchError } from '../api-response.js';
import { requestCustomApi, throwFriendlyMainApi } from '../api-runtime.js';
import { classifyRequestFailure, createDiagnosticError } from '../request-diagnostics.js';
import { attachErrorDetails, collectErrorDetails, formatRequestIssue, redactErrorText, requestCredentialValues, MAX_ERROR_DETAIL_CHARS } from '../error-details.js';
import { errorHelpHTML } from '../error-help-ui.js';
import { theaterError } from '../notify.js';
import { createTheaterDiagnostics } from '../theater-diagnostics.js';
import { createLongDreamRecord, normalizeLongDreamRecord } from '../long-dream.js';
import { refreshLongDreamSummary } from '../long-dream-summary.js';
import { setRuntimeLogSecretProvider } from '../runtime-log.js';

const providerBody = JSON.stringify({ error: { message: 'Requested model rabbit-2 is unavailable in this channel', code: 'model_not_found' }, request_id: 'req-rabbit' });
const config = { apiUrl: 'https://fixture.invalid/v1', apiKey: 'opaque-test-credential', apiModel: 'rabbit-2', apiProtocol: 'openai', maxOutputTokens: 4096 };

test('HTTP报错保留渠道原文、状态、请求编号及任务阶段，分类兼容', () => {
    const response = new Response(providerBody, { status: 403, headers: { 'content-type': 'application/json', 'x-request-id': 'req-rabbit' } });
    const error = statusError(403, providerBody, { response, phase: 'body', transport: 'openai' });
    const issue = classifyRequestFailure(error, { stage: '长梦第二章' });
    assert.equal(issue.httpStatus, 403);
    assert.equal(issue.errorDetails.responseBody, providerBody);
    assert.equal(issue.errorDetails.requestId, 'req-rabbit');
    assert.equal(issue.errorDetails.origin, 'response');
    assert.match(formatRequestIssue(issue), /长梦第二章|Requested model rabbit-2/);
    assert.ok(!JSON.stringify(error).includes('Requested model'));
});

test('HTTP 429、输入限制及网关HTML同样保留原文，不改变原分类', () => {
    for (const [status, body, signal] of [[429, 'Quota temporarily unavailable', 'T-HTTP-429'],
        [400, 'input is too long', 'T-API-INPUT-LIMIT'], [502, '<html><h1>Bad gateway</h1></html>', 'T-HTTP-502']]) {
        const issue = classifyRequestFailure(statusError(status, body));
        assert.equal(issue.signal, signal);
        assert.equal(issue.errorDetails.responseBody, body);
    }
});

test('HTTP200非流式错误JSON保留原报错和实际HTTP200', async () => {
    await assert.rejects(readNonStreamingResponse(new Response(providerBody, { headers: { 'content-type': 'application/json' } })), error => {
        const issue = classifyRequestFailure(error);
        assert.equal(issue.httpStatus, 200);
        assert.equal(issue.errorDetails.responseBody, providerBody);
        assert.equal(issue.errorDetails.transport, 'non_stream');
        return true;
    });
});

for (const [protocol, payload] of [
    ['openai', { error: { message: 'provider original openai failure' } }],
    ['anthropic', { type: 'error', error: { type: 'overloaded_error', message: 'provider original anthropic failure' } }],
    ['openai', { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'provider original nested responses failure' } } }],
]) test(`${protocol} 流式错误保留出错事件原文，不把事件当故事正文`, async () => {
    const raw = JSON.stringify(payload), chunks = [];
    const response = new Response(`data: ${raw}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    await assert.rejects(readSSEStream(response, text => chunks.push(text), protocol), error => {
        const issue = classifyRequestFailure(error);
        assert.equal(issue.httpStatus, 200);
        assert.equal(issue.errorDetails.responseBody, raw);
        assert.match(issue.errorDetails.providerMessage, /provider original/);
        return true;
    });
    assert.deepEqual(chunks, []);
});

test('只有error.code的JSON和嵌套Responses失败保留原文，错误分类沿用原流程', async () => {
    for (const payload of [{ error: { code: 'model_unavailable' } }, { type: 'response.failed', response: { status: 'failed', error: { message: 'nested failure' } } }]) {
        const raw = JSON.stringify(payload);
        await assert.rejects(readNonStreamingResponse(new Response(raw, { headers: { 'content-type': 'application/json' } })), error => {
            const issue = classifyRequestFailure(error);
            assert.equal(issue.signal, 'T-API-EMPTY');
            assert.equal(issue.errorDetails.responseBody, raw);
            return true;
        });
    }
});

test('独立请求错误带实际端点和模型，仍只发送一次，凭证不进入详情', async () => {
    let calls = 0;
    await assert.rejects(requestCustomApi({ config, shouldStream: false, userPrompt: '不应进入错误报告的创作正文', fetchImpl: async () => {
        calls++;
        return new Response(providerBody + '\ncredential=' + config.apiKey, { status: 403 });
    } }), error => {
        const details = collectErrorDetails(error);
        assert.equal(details.endpoint, 'https://fixture.invalid/v1/chat/completions');
        assert.equal(details.model, 'rabbit-2');
        assert.doesNotMatch(JSON.stringify(details), /opaque-test-credential|不应进入错误报告的创作正文/);
        assert.match(details.responseBody, /Requested model rabbit-2/);
        return true;
    });
    assert.equal(calls, 1);
});

test('没有响应时保留浏览器异常，明确不冒充渠道原文且不伪造HTTP0', () => {
    const error = normalizeFetchError(new TypeError('Failed to fetch: connection reset'), { phase: 'awaiting-response', transport: 'openai' });
    const issue = classifyRequestFailure(error);
    assert.equal(issue.httpStatus, null);
    assert.equal(issue.errorDetails.origin, 'network');
    assert.match(formatRequestIssue(issue), /Failed to fetch: connection reset/);
    assert.match(formatRequestIssue(issue), /未取得渠道原始错误正文/);
    assert.match(formatRequestIssue(issue), /等待响应头/);
});

test('酒馆主API错误在友好分类后保留底层原文和技术位置', () => {
    const original = Object.assign(new Error('HTTP 502 upstream overloaded at host adapter'), { status: 502 });
    assert.throws(() => throwFriendlyMainApi(original), error => {
        const issue = classifyRequestFailure(error, { stage: '普通续写' });
        assert.equal(issue.httpStatus, 502);
        assert.equal(issue.errorDetails.origin, 'host');
        assert.equal(issue.errorDetails.transport, 'TavernHelper');
        assert.equal(issue.errorDetails.originalMessage, original.message);
        assert.match(issue.errorDetails.stack, /error-details.test.js/);
        assert.ok(!issue.errorDetails.responseBody);
        return true;
    });
});

test('不把正常正文、只有思考的成功响应或未知空结构整段存进错误详情', async () => {
    const result = await readNonStreamingResponse(new Response(JSON.stringify({ choices: [{ message: { content: '正常正文' } }] }), { headers: { 'content-type': 'application/json' } }));
    assert.equal(result.text, '正常正文');
    for (const payload of [{ choices: [{ message: { reasoning_content: 'PRIVATE_THOUGHT', content: '' } }] }, { choices: [], echoed_prompt: 'PRIVATE_PROMPT' }]) {
        await assert.rejects(readNonStreamingResponse(new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })), error => {
            const issue = classifyRequestFailure(error);
            assert.equal(issue.httpStatus, 200);
            assert.doesNotMatch(JSON.stringify(issue), /PRIVATE_THOUGHT|PRIVATE_PROMPT/);
            assert.ok(!issue.errorDetails.responseBody);
            return true;
        });
    }
});

test('脱敏覆盖明文头、JSON多行私钥、URL鉴权、已保存及本次请求密钥', t => {
    setRuntimeLogSecretProvider(() => ['opaque-known-credential']);
    t.after(() => setRuntimeLogSecretProvider(() => []));
    const raw = 'Authorization: Bearer bare-token-secret\n' + JSON.stringify({ apiKey: 'json-secret', private_key: 'multi\nline-private-value', message: 'opaque-known-credential' })
        + '\nhttps://alice:password@fixture.invalid/v1/messages?api_key=query-secret#fragment\nx-goog-api-key: google-secret';
    const safe = redactErrorText(raw);
    assert.doesNotMatch(safe, /bare-token-secret|json-secret|line-private-value|opaque-known-credential|alice|password@|query-secret|google-secret/);
    assert.match(safe, /https:\/\/fixture.invalid\/v1\/messages/);
    const error = attachErrorDetails(new Error('redaction fixture'), { responseBody: 'opaque-request-credential', secrets: ['opaque-request-credential'] });
    assert.equal(error.diagnosticDetails.responseBody, '[REDACTED]');
});

test('原文长度有界且明确截断，超长错误不会撑爆报错框', () => {
    const issue = classifyRequestFailure(statusError(500, 'x'.repeat(MAX_ERROR_DETAIL_CHARS + 1000)));
    assert.ok(issue.errorDetails.responseBody.length < MAX_ERROR_DETAIL_CHARS + 100);
    assert.match(issue.errorDetails.responseBody, /已截断/);
});

test('酒馆CSRF凭证在明文头、JSON和无标签回显里均脱敏，Header不被存入详情', () => {
    const csrf = 'session-csrf-fixture';
    const raw = `X-CSRF-Token: ${csrf}\n` + JSON.stringify({ headers: { 'X-CSRF-Token': csrf } });
    assert.doesNotMatch(redactErrorText(raw), /session-csrf-fixture/);
    const secrets = requestCredentialValues({ 'X-CSRF-Token': csrf, Authorization: 'Bearer auth-fixture', 'Content-Type': 'application/json' });
    assert.ok(secrets.includes(csrf));
    assert.ok(secrets.includes('auth-fixture'));
    const error = attachErrorDetails(statusError(500, `gateway echoed ${csrf}`), { secrets });
    const details = collectErrorDetails(error);
    assert.doesNotMatch(JSON.stringify(details), /session-csrf-fixture|auth-fixture|"headers"|"secrets"/);
    assert.match(details.responseBody, /REDACTED/);
});

test('HTML渠道错误只作为转义文本展示，原始详情能在报错框展开', () => {
    const issue = classifyRequestFailure(statusError(500, '<img src=x onerror=alert(1)><script>boom()</script>'));
    const html = errorHelpHTML(issue, { actions: true });
    assert.doesNotMatch(html, /<img|<script>/);
    assert.match(html, /&lt;img/);
    assert.match(html, /查看原始详情与出错位置/);
    assert.match(html, /data-error-copy/);
    assert.match(html, /插件提示/);
});

test('概要包装请求失败时不丢渠道详情，保存失败保留本地异常且不覆盖章节', async () => {
    let record = createLongDreamRecord({ source: { text: '第一章正文', html: '<p>第一章正文</p>' } });
    record = normalizeLongDreamRecord({ ...record, memory: { ...record.memory, processedThroughChapter: 1, pendingChapterNumbers: [], status: 'ready' } });
    const snapshot = JSON.stringify(record);
    await assert.rejects(refreshLongDreamSummary({ record, readLatest: () => record, save: () => assert.fail('unexpected write'), request: async () => { throw statusError(403, providerBody); } }), error => {
        assert.equal(error.code, 'LONG_DREAM_SUMMARY_REQUEST_FAILED');
        assert.equal(classifyRequestFailure(error).errorDetails.responseBody, providerBody);
        return true;
    });
    await assert.rejects(refreshLongDreamSummary({ record, readLatest: () => record, request: async () => JSON.stringify({ storyEntries: [{ chapterNumber: 1, text: '有效概要' }] }), save: () => { throw new Error('QuotaExceededError at local store'); } }), error => {
        const details = collectErrorDetails(error);
        assert.equal(details.origin, 'plugin');
        assert.equal(details.phase, 'save');
        assert.match(details.originalMessage, /QuotaExceededError/);
        return true;
    });
    assert.equal(JSON.stringify(record), snapshot);
});

test('复制问题信息包含渠道原文及位置，并且脱敏', async t => {
    const previous = { document: globalThis.document, toastr: globalThis.toastr };
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const listeners = {}, status = {}, copied = [];
    const root = { classList: { add() {} }, parentElement: { classList: { add() {} } },
        querySelector: selector => selector === '[data-error-status]' ? status : { setAttribute() {}, addEventListener: (_, fn) => { listeners[selector] = fn; } }, querySelectorAll: () => [] };
    globalThis.document = { querySelectorAll: () => [], body: {} };
    globalThis.toastr = { error: () => [root] };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => copied.push(text) } } });
    t.mock.method(console, 'error', () => {});
    t.after(() => { Object.assign(globalThis, previous); if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else delete globalThis.navigator; });
    const issue = classifyRequestFailure(statusError(403, providerBody + '\napi_key="secret-in-copy"'), { stage: '长梦续章' });
    theaterError('生成失败', '', { requestIssue: issue });
    await listeners['[data-error-copy]']({ stopPropagation() {} });
    assert.match(copied[0], /Requested model rabbit-2|长梦续章|HTTP：403/);
    assert.doesNotMatch(copied[0], /secret-in-copy/);
});

test('诊断页及导出报告保留原始错误详情，不只显示通用错误码', t => {
    const previous = { $: globalThis.$, window: globalThis.window };
    globalThis.$ = () => ({ val: () => '' }); globalThis.window = { indexedDB: {} };
    t.after(() => Object.assign(globalThis, previous));
    const downloaded = [];
    const runtime = { settings: { ...config, renderTemplates: [] }, VERSION: '4.4.8', requestMetricsLog: [], recentCache: [], historyCache: [], wbEntries: [],
        formatRequestContextSummary: () => '测试请求', renderSelectionMeta: () => ({ name: '纯文字' }),
        lastRequestIssue: classifyRequestFailure(attachErrorDetails(statusError(403, providerBody), { endpoint: 'https://fixture.invalid/v1/chat/completions' })), downloadTextContent: text => downloaded.push(text) };
    const diagnostics = createTheaterDiagnostics(runtime);
    assert.match(diagnostics.buildDiagnostics().text, /Requested model rabbit-2/);
    diagnostics.exportDiagnosticsText();
    assert.match(downloaded[0], /Requested model rabbit-2/);
    assert.match(downloaded[0], /原始错误详情与出错位置/);
    assert.match(downloaded[0], /https:\/\/fixture.invalid\/v1\/chat\/completions/);
});
