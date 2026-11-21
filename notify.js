import { errorHelpHTML } from './error-help-ui.js';
import { formatRequestIssue } from './error-details.js';
let dialogToastSequence = 0;
export function theaterError(message, title = '', opts = {}) {
    const text = String(message || '');
    const { requestIssue, retained, openDiagnostics, ...toastOptions } = opts;
    const dialog = requestIssue ? [...document.querySelectorAll('dialog[open]')].at(-1) : null;
    const dialogOptions = requestIssue ? { target: dialog || document.body, containerId: dialog
        ? dialog.dataset.theaterErrorToastId || (dialog.dataset.theaterErrorToastId = 'theater-error-toasts-' + ++dialogToastSequence)
        : 'theater-error-toasts-body', positionClass: 'theater-error-toast-layer' } : {};
    const toast = toastr.error(requestIssue ? errorHelpHTML(requestIssue, { retained, actions: true }) : text, title,
        { timeOut: requestIssue ? 0 : 7000, extendedTimeOut: requestIssue ? 0 : 2000, closeButton: !!requestIssue, tapToDismiss: !requestIssue, escapeHtml: false, ...toastOptions, ...dialogOptions });
    if (requestIssue && toast?.[0]) {
        const root=toast[0];root.classList.add('theater-request-error-toast');
        root.parentElement.classList.add('theater-error-toast-layer');
        root.querySelector('.toast-close-button')?.setAttribute('aria-label', '关闭报错提示');
        root.querySelector('[data-error-diagnostics]')?.addEventListener('click', event => { event.stopPropagation(); openDiagnostics?.(); });
        root.querySelector('[data-error-copy]')?.addEventListener('click', async event => {
            event.stopPropagation();const status=root.querySelector('[data-error-status]');
            try { await navigator.clipboard.writeText(formatRequestIssue(requestIssue));status.textContent='已复制错误原文与位置（凭证已脱敏；转发前请检查渠道是否回显了请求内容）'; }
            catch { status.textContent='复制未完成，可在诊断页导出报告。'; }
        });
        root.querySelectorAll('details').forEach(details=>details.addEventListener('click',event=>event.stopPropagation()));
    }
    console.error('[Theater]', title || 'Error', text);
}
