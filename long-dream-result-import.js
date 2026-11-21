import {
    LONG_DREAM_DRAFT_STATUS, LONG_DREAM_STATUS, normalizeLongDreamRecord,
    saveLongDreamDraft, appendLongDreamDraftCandidate,
} from './long-dream.js';
import { displayedContinuationVersion } from './continuation-session.js';

const openImports = new WeakSet();

// Resolve metadata against the displayed HTML, never against stale lastGeneratedText
// or the direction currently being typed for the next generation.
export function displayedDreamImportSource(runtime) {
    const html = runtime.currentDisplayHtml || runtime.lastGeneratedHtml;
    if (!String(html || '').trim()) return null;
    const version = displayedContinuationVersion(runtime.continuationSession, html);
    const item = version
        || (runtime.currentGenerationResult?.html === html ? runtime.currentGenerationResult : null)
        || runtime.recentCache?.find(item => item.html === html)
        || runtime.historyCache?.find(item => item.html === html)
        || (runtime.retainedResultSource?.html === html ? runtime.retainedResultSource : null);
    const text = String(version?.text || runtime.htmlToPlainText(html) || '');
    return { html, text, mode: item?.mode || runtime.currentOutputMode || 'html', instruction: String(item?.instruction || '') };
}

// Use the existing review/promote path, so confirmation, memory invalidation,
// retained versions, exports and subsequent chapters keep one storage format.
export function importResultAsDreamCandidate(record, source, { title = '', fallbackHtml, extractText, now = new Date() } = {}) {
    let next = normalizeLongDreamRecord(record);
    if (!next) throw new Error('没有找到这部长梦');
    if (next.status === LONG_DREAM_STATUS.COMPLETE) throw new Error('这部长梦已完结，请先恢复连载');
    if (!String(source?.text || '').trim() || !String(source?.html || '').trim()) throw new Error('当前结果没有可保存的正文');
    if (next.chapters.some(chapter => chapter.html === source.html || chapter.text.trim() === source.text.trim())) {
        throw new Error('这段正文已经是本卷的正式章节，请勿重复保存');
    }
    const draft = next.draft;
    const candidates = (draft?.candidates || []).map(candidate => ({ ...candidate, retained: true }));
    if (candidates.some(candidate => candidate.html === source.html || candidate.text.trim() === source.text.trim())) {
        throw new Error('这段正文已在本章候选中，请到长梦查看');
    }
    // A failed long-dream attempt can have unfinished text but no review candidate.
    // Preserve that text as another retained version instead of overwriting it.
    if (draft?.status === LONG_DREAM_DRAFT_STATUS.WRITING && (draft.text.trim() || draft.html.trim())) {
        const text = draft.text.trim() ? draft.text : String(extractText?.(draft.html) || '');
        const html = draft.html || fallbackHtml?.(text);
        if (!text.trim() || !html) throw new Error('旧草稿无法保留，请先处理长梦中的草稿');
        if (!candidates.some(candidate => candidate.text === text && (!draft.html || candidate.html === html))) {
            candidates.push({ ...draft, text, html, mode: draft.html ? draft.mode : 'text', retained: true,
            versionNumber: Math.max(0, ...candidates.map(candidate => candidate.versionNumber || 1)) + 1 });
        }
    }
    next = saveLongDreamDraft(next, {
        ...draft, status: LONG_DREAM_DRAFT_STATUS.WRITING,
        instruction: draft?.instruction || source.instruction || '',
        text: draft?.text || source.text, html: draft?.html || '', candidates,
    }, now);
    return appendLongDreamDraftCandidate(next, {
        text: source.text, html: source.html, mode: source.mode,
        instruction: source.instruction || '', title: title.trim() || `第 ${next.chapters.length + 1} 章`,
        retained: true,
    }, now);
}

function busy(runtime) {
    return runtime.isGenerating || runtime.isPreparingGeneration || runtime.resultEditSnapshot
        || runtime.longDreamGenerationController?.active || runtime.longDreamChapterEditController
        || runtime.longDreamCandidateSavePending || runtime.refreshingLongDreamWorldBooks;
}

export async function saveDisplayedResultToDream(runtime, readingItem = null) {
    if (openImports.has(runtime)) return;
    if (busy(runtime)) { toastr.warning('请先完成当前生成、编辑或保存'); return; }
    if (runtime.storageReadErrors?.dreams) { toastr.warning('长梦存档尚未读取成功，请重新打开插件后再试'); return; }
    const source = readingItem ? {
        html: readingItem.html, text: runtime.htmlToPlainText(readingItem.html),
        instruction: readingItem.instruction || '', mode: readingItem.mode || 'html',
    } : displayedDreamImportSource(runtime);
    if (!source?.text.trim()) { toastr.warning('没有可存入长梦的正文'); return; }
    const dreams = runtime.longDreamCache.filter(dream => dream.status !== LONG_DREAM_STATUS.COMPLETE);
    if (!dreams.length) { toastr.info('请先在“长梦”创建作品，再把续写结果存入下一章'); return; }
    openImports.add(runtime);
    try {
        const { Popup, POPUP_TYPE } = SillyTavern.getContext();
        const popup = new Popup(`<div class="theater-popup theater-compact-popup theater-dream-import-popup rabbit-save-sheet" data-skin="${runtime.esc(runtime.settings.skinMode || 'default')}">
            <header class="theater-popup-header"><h3 class="theater-title">存入长梦</h3></header>
            <div class="rabbit-import-fields">
            <label class="theater-label" for="theater-dream-import-target">选择作品</label>
            <select class="theater-input" id="theater-dream-import-target">${dreams.map(dream => `<option value="${runtime.esc(dream.id)}"${String(dream.id) === String(runtime.activeLongDreamId) ? ' selected' : ''}>${runtime.esc(dream.title)} · 第 ${dream.chapters.length + 1} 章</option>`).join('')}</select>
            <label class="theater-label" for="theater-dream-import-title">章节标题（可留空）</label>
            <input class="theater-input" id="theater-dream-import-title" maxlength="80" placeholder="留空使用章节编号">
            <p class="theater-hint">本次只保存当前正文与排版。到下一章的待确认区点「用这版继续」，即可收入长卷。</p>
            <p class="theater-hint">原有草稿和候选会保留。请确认当前正文只包含新章节。</p>
            </div>
        </div>`, POPUP_TYPE.CONFIRM, '', { wide: false, okButton: '保存候选', cancelButton: '取消', allowVerticalScrolling: true });
        const shown = popup.show();
        const select = popup.dlg.querySelector('#theater-dream-import-target');
        const title = popup.dlg.querySelector('#theater-dream-import-title');
        if (!await shown) return;
        if (busy(runtime)) { toastr.warning('当前任务状态已变化，请稍后再存入'); return; }
        const original = dreams.find(dream => String(dream.id) === select.value);
        const current = runtime.longDreamCache.find(dream => String(dream.id) === select.value);
        if (!original || current !== original) { toastr.warning('作品已变化，请重新选择并保存'); return; }
        if (current.memory?.status === 'weaving' || runtime.refreshingLongDreamSummaries?.has(String(current.id))
            || runtime.queuedLongDreamMemoryIds?.has(String(current.id))) {
            toastr.warning('这部长梦正在整理记忆，请完成后再保存'); return;
        }
        runtime.longDreamCandidateSavePending = true;
        let saved;
        try {
            saved = await runtime.longDreamPut(importResultAsDreamCandidate(current, source, {
                title: title.value, fallbackHtml: text => runtime.textFallbackHtml(text),
                extractText: html => runtime.htmlToPlainText(html),
            }));
        } finally { runtime.longDreamCandidateSavePending = false; }
        if (!saved) { toastr.warning('存入失败，生成结果仍保留，请重试'); return; }
        runtime.rememberLongDreamComposerDraft();
        runtime.activeLongDreamId = saved.id;
        runtime.longDreamWorkspaceSection = 'continue';
        runtime.longDreamView = 'detail';
        runtime.longDreamWorkLevel = 'detail';
        runtime.activeLongDreamChapterId = null;
        runtime.rememberLongDreamNavigation();
        runtime.renderLongDreamPanel();
        runtime.activateTheaterTab('long-dream');
        toastr.success(`已保存为《${saved.title}》第 ${saved.chapters.length + 1} 章候选，核对后点“用这版继续”`);
    } catch (error) {
        toastr.warning(`存入长梦失败：${error?.message || error}`);
    } finally { openImports.delete(runtime); }
}

export function bindDreamResultImport(runtime, $d) {
    $d.off('click.tdreamresultimport').on('click.tdreamresultimport', '#theater-save-dream-btn', () => saveDisplayedResultToDream(runtime));
}
