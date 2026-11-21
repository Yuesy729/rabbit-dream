import { redactRuntimeSecrets } from './runtime-log.js';

export const MAX_ERROR_DETAIL_CHARS = 65536;

// Keep diagnostic wording and request paths; remove credentials even when a
// gateway echoes headers, a credential file, or a URL in its error response.
export function redactErrorText(value, secrets = []) {
    let text = redactRuntimeSecrets(String(value ?? ''));
    for (const secret of secrets) {
        if (String(secret || '').length >= 4) text = text.split(String(secret)).join('[REDACTED]');
    }
    return text
        .replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?-----END [\w ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
        .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
        .replace(/((?:["']?)(?:authorization|x[-_]?csrf[-_]?token|csrf[-_]?token|x[-_]?(?:goog[-_]?)?api[-_]?key|api[-_]?key|apikey|key|access[-_]?token|refresh[-_]?token|private[-_]?key|client[-_]?secret|password|credential|secret)(?:["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1"[REDACTED]"')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
        .replace(/\b(?:https?|wss?):\/\/[^\s<>"'`]+/gi, raw => {
            try { const url = new URL(raw); return url.origin + url.pathname; } catch { return '[URL]'; }
        });
}

export function requestCredentialValues(headers) {
    const values = [];
    try {
        new Headers(headers).forEach((value, key) => {
            if (/^(?:authorization|x-csrf-token|csrf-token|x-api-key|x-goog-api-key|api-key|apikey)$/i.test(key)) {
                values.push(value, value.replace(/^(?:Bearer|Basic)\s+/i, ''));
            }
        });
    } catch { /* Invalid headers are reported by the existing request path. */ }
    return values;
}

function bounded(value, limit, secrets) {
    const text = redactErrorText(value, secrets);
    return text.length > limit ? text.slice(0, limit) + `\n[详情超过 ${limit} 字符，已截断]` : text;
}

export function attachErrorDetails(error, details = {}) {
    if (!error || typeof error !== 'object' || error.name === 'AbortError') return error;
    const secrets = details.secrets || [];
    const previous = error.diagnosticDetails || {};
    const fields = { ...previous, ...details };
    const safe = {};
    for (const key of ['origin', 'phase', 'transport', 'model', 'endpoint', 'providerMessage', 'originalMessage', 'responseBody', 'requestId', 'contentType', 'httpStatus', 'technicalCode', 'stack']) {
        if (fields[key] == null || fields[key] === '') continue;
        if (key === 'httpStatus') {
            const status = Number(fields[key]);
            if (Number.isInteger(status) && status >= 100 && status <= 599) safe.httpStatus = status;
        } else safe[key] = bounded(fields[key], key === 'responseBody' ? MAX_ERROR_DETAIL_CHARS : key === 'stack' ? 8000 : 4000, secrets);
    }
    try {
        // Explicit UI/report access only: avoid accidental body dumps when other
        // features stringify Error objects in logs or store a failed request.
        Object.defineProperty(error, 'diagnosticDetails', { value: safe, configurable: true });
    } catch { /* A host may supply a frozen Error; its original message is still available. */ }
    return error;
}

export function attachErrorResponse(error, response, extra = {}) {
    const headers = response?.headers;
    return attachErrorDetails(error, {
        httpStatus: response?.status,
        contentType: headers?.get?.('content-type') || '',
        requestId: headers?.get?.('x-request-id') || headers?.get?.('request-id') || headers?.get?.('cf-ray') || '',
        ...extra,
    });
}

export function collectErrorDetails(error) {
    const original = error?.diagnosticDetails || {};
    const failure = error?.theaterFailure || {};
    const message = String(error?.message || (typeof error === 'string' ? error : '') || '');
    const wrapped = attachErrorDetails(new Error(), {
        origin: original.origin || (error?.diagnosticSignal ? 'plugin' : 'unknown'),
        phase: failure.phase || '', transport: failure.transport || '',
        technicalCode: error?.code || '',
        originalMessage: message && message !== error?.diagnosticSignal ? message : '',
        stack: error?.stack || '',
        ...original,
        httpStatus: original.httpStatus || failure.status || error?.status || error?.statusCode || error?.apiResponseSummary?.httpStatus,
    });
    return wrapped.diagnosticDetails || {};
}

export function errorSourceLabel(details = {}) {
    return ({ response: '渠道响应', host: '酒馆主 API 转交的异常', network: '浏览器网络或响应读取', plugin: '插件本地检查', unknown: '异常来源未确认' })[details.origin] || '异常来源未确认';
}

export function formatRequestIssue(issue) {
    if (!issue) return '';
    const details = issue.errorDetails || {};
    const phase = ({ body: '响应内容处理', main: '酒馆主 API 调用', 'awaiting-response': '等待响应头', 'reading-body': '读取响应体', 'reading-stream': '读取流式响应' })[details.phase] || details.phase;
    return redactErrorText([
        `${issue.signal || ''} · ${issue.title || ''}`,
        `出错任务：${issue.stage || '请求处理'}`,
        `信息来源：${errorSourceLabel(details)}`,
        phase ? `出错环节：${phase}` : '',
        issue.httpStatus ? `HTTP：${issue.httpStatus}` : 'HTTP：未取得或上层未提供',
        details.transport ? `协议/调用路径：${details.transport}` : '',
        details.endpoint ? `请求位置：${details.endpoint}` : '',
        details.model ? `请求模型：${details.model}` : '',
        details.requestId ? `请求编号：${details.requestId}` : '',
        details.contentType ? `响应类型：${details.contentType}` : '',
        details.technicalCode ? `技术错误码：${details.technicalCode}` : '',
        details.providerMessage ? `渠道错误信息：${details.providerMessage}` : '',
        details.originalMessage ? `底层异常信息：${details.originalMessage}` : '',
        details.responseBody ? `\n渠道返回原文（凭证已脱敏）：\n${details.responseBody}`
            : '\n未取得渠道原始错误正文；以上为已收到的异常或插件检查结果，不能据此认定渠道返回了这些文字。',
        details.stack ? `\n技术位置：\n${details.stack}` : '',
        issue.action ? `\n处理建议：${issue.action}` : '',
        issue.retained ? '此前已收到的正文已保留。' : '',
    ].filter(Boolean).join('\n'));
}
