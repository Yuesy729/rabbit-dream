import test from 'node:test';
import assert from 'node:assert/strict';
import { createLongDreamRecord, saveLongDreamDraft, normalizeLongDreamRecord, promoteLongDreamDraft } from '../long-dream.js';
import { createLongDreamBackup, parseLongDreamBackup } from '../long-dream-backup.js';
import { createLongDreamArchive, parseLongDreamArchive } from '../long-dream-archive.js';
import { displayedDreamImportSource, importResultAsDreamCandidate, saveDisplayedResultToDream } from '../long-dream-result-import.js';

const textFallback = text => `<article>${text}</article>`;
const source = { text: '第二章完整正文', html: '<article class="old-layout">第二章完整正文</article>', mode: 'html', instruction: '这一章的要求' };
function dream() {
    return { ...createLongDreamRecord({ source: { text: '首章正文', html: '<p>首章正文</p>' }, title: '测试长梦' }), id: 7 };
}

test('普通续写保存为第二章候选，确认后成为正式第二章，正文与HTML原样保存', () => {
    const before = dream(), snapshot = JSON.stringify(before);
    const next = importResultAsDreamCandidate(before, source, { title: '新的章节' });
    assert.equal(next.chapters.length, 1);
    assert.equal(next.draft.chapterNumber, 2);
    assert.equal(next.draft.status, 'review');
    const saved = promoteLongDreamDraft(next);
    assert.equal(saved.chapters.length, 2);
    assert.equal(saved.chapters[1].text, source.text);
    assert.equal(saved.chapters[1].html, source.html);
    assert.equal(saved.chapters[1].title, '新的章节');
    assert.equal(saved.chapters[1].instruction, source.instruction);
    assert.ok(saved.memory.pendingChapterNumbers.includes(2));
    assert.equal(saved.draft, null);
    assert.equal(JSON.stringify(before), snapshot);
});

test('失败草稿和三版旧候选均保留，确认后旧稿进入同章其他版本', () => {
    const before = saveLongDreamDraft(dream(), {
        status: 'writing', text: '生成中断留下的正文', instruction: '旧要求', title: '旧标题',
        candidates: [1, 2, 3].map(n => ({ text: `旧候选${n}`, html: `<p>旧候选${n}</p>`, versionNumber: n })),
    });
    const next = importResultAsDreamCandidate(before, source, { fallbackHtml: textFallback });
    assert.equal(next.draft.candidates.length, 5);
    assert.ok(next.draft.candidates.every(candidate => candidate.retained));
    assert.equal(next.draft.candidates[3].text, before.draft.text);
    assert.equal(next.draft.candidates[3].mode, 'text');
    assert.equal(next.draft.selectedCandidateIndex, 4);
    const saved = promoteLongDreamDraft(next);
    assert.equal(saved.chapters[1].retainedVersions.length, 4);
    assert.equal(saved.chapters[1].text, source.text);
});

test('已有review候选不淘汰，新版成功进入待确认区', () => {
    const before = saveLongDreamDraft(dream(), { status: 'review', candidates: [1, 2, 3].map(n => ({ text: `版本${n}`, html: `<p>版本${n}</p>` })) });
    const snapshot = JSON.stringify(before);
    const next = importResultAsDreamCandidate(before, source);
    assert.equal(next.draft.candidates.length, 4);
    assert.equal(next.draft.text, source.text);
    assert.equal(JSON.stringify(before), snapshot);
});

test('旧备份只有HTML的未完成稿原样保留，无法提取时拒绝覆盖', () => {
    const before = saveLongDreamDraft(dream(), { status: 'writing', text: '', html: '<article>旧HTML草稿</article>', mode: 'html' });
    const snapshot = JSON.stringify(before);
    assert.throws(() => importResultAsDreamCandidate(before, source), /旧草稿/);
    const next = importResultAsDreamCandidate(before, source, { extractText: html => html.replace(/<[^>]*>/g, '') });
    assert.equal(next.draft.candidates[0].html, before.draft.html);
    assert.equal(next.draft.candidates[0].text, '旧HTML草稿');
    assert.equal(next.draft.candidates[0].retained, true);
    assert.equal(JSON.stringify(before), snapshot);
});

test('重复存入、空正文、已完结和无法保留旧草稿时不改原记录', () => {
    const base = dream();
    assert.throws(() => importResultAsDreamCandidate(base, { ...source, text: '' }), /正文/);
    assert.throws(() => importResultAsDreamCandidate({ ...base, status: 'complete' }, source), /完结/);
    assert.throws(() => importResultAsDreamCandidate(base, { ...source, html: base.chapters[0].html }), /正式章节/);
    const imported = importResultAsDreamCandidate(base, source);
    assert.throws(() => importResultAsDreamCandidate(imported, source), /候选/);
    const failed = saveLongDreamDraft(base, { text: '未完成正文', status: 'writing' });
    assert.throws(() => importResultAsDreamCandidate(failed, source), /旧草稿/);
});

test('待确认候选和正式章节都能经过JSON与ZIP备份规范化恢复', () => {
    const imported = importResultAsDreamCandidate(dream(), source);
    for (const record of [imported, promoteLongDreamDraft(imported)]) {
        const fromJson = parseLongDreamBackup(createLongDreamBackup([record]))[0];
        const archive = createLongDreamArchive([record]);
        const fromZip = parseLongDreamArchive(archive.manifest, archive.files)[0];
        for (const restored of [fromJson, fromZip]) {
            const chapter = restored.draft || restored.chapters[1];
            assert.equal(chapter.text, source.text);
            assert.equal(chapter.html, source.html);
        }
    }
});

test('切换旧结果只提取当前显示页，不串上一次正文、输入框或续写前情轮次', () => {
    const runtime = { currentDisplayHtml: '<p>正在看的第二章</p>', lastGeneratedHtml: '<p>过期结果</p>', lastGeneratedText: '不该保存的正文',
        recentCache: [{ html: '<p>正在看的第二章</p>', instruction: '本章要求', continuationRounds: ['第一章', '第二章'] }],
        htmlToPlainText: html => html.replace(/<[^>]*>/g, '') };
    const result = displayedDreamImportSource(runtime);
    assert.equal(result.text, '正在看的第二章');
    assert.equal(result.instruction, '本章要求');
    assert.ok(!result.text.includes('第一章'));
    runtime.continuationSession = { selected: 0, versions: [{ html: runtime.currentDisplayHtml, text: '候选精确正文', instruction: '候选要求' }] };
    assert.equal(displayedDreamImportSource(runtime).text, '候选精确正文');
});

function uiHarness(t, { confirm = true, fail = false, mutate, held = false } = {}) {
    const notices = [], writes = [], navigation = [], base = dream();
    const runtime = { longDreamCache: [base], currentDisplayHtml: source.html, currentOutputMode: 'html', settings: {},
        currentGenerationResult: source, htmlToPlainText: () => source.text, textFallbackHtml: textFallback, esc: text => String(text),
        longDreamPut: async record => { writes.push(record); if (fail) return false; const saved = normalizeLongDreamRecord(record); runtime.longDreamCache = [saved]; return saved; },
        rememberLongDreamComposerDraft() {}, rememberLongDreamNavigation() {}, renderLongDreamPanel() {}, activateTheaterTab: tab => navigation.push(tab) };
    let release;
    const pending = held ? new Promise(resolve => { release = resolve; }) : null;
    const previous = { toastr: globalThis.toastr, SillyTavern: globalThis.SillyTavern };
    globalThis.toastr = Object.fromEntries(['warning', 'info', 'success'].map(kind => [kind, text => notices.push({ kind, text })]));
    globalThis.SillyTavern = { getContext: () => ({ POPUP_TYPE: { CONFIRM: 1 }, Popup: class {
        dlg = { querySelector: selector => ({ value: selector.endsWith('target') ? '7' : '自定标题' }) };
        async show() { if (pending) await pending; mutate?.(runtime); return confirm; }
    } }) };
    t.after(() => Object.assign(globalThis, previous));
    return { runtime, writes, notices, navigation, release };
}

test('保存成功才跳长梦，结果仍保留，保存不调用创作或记忆API', async t => {
    const h = uiHarness(t);
    await saveDisplayedResultToDream(h.runtime);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].draft.title, '自定标题');
    assert.deepEqual(h.navigation, ['long-dream']);
    assert.equal(h.runtime.currentDisplayHtml, source.html);
    assert.equal(h.runtime.longDreamCandidateSavePending, false);
});

test('取消与存储失败不会跳转或丢失生成结果', async t => {
    for (const opts of [{ confirm: false }, { fail: true }]) {
        const h = uiHarness(t, opts), before = JSON.stringify(h.runtime.longDreamCache);
        await saveDisplayedResultToDream(h.runtime);
        assert.equal(h.writes.length, opts.fail ? 1 : 0);
        assert.deepEqual(h.navigation, []);
        assert.equal(JSON.stringify(h.runtime.longDreamCache), before);
        assert.equal(h.runtime.currentDisplayHtml, source.html);
    }
});

test('弹窗期间变更作品、生成启动或梦脉正在更新时拒绝覆盖', async t => {
    for (const mutate of [runtime => { runtime.longDreamCache = [{ ...runtime.longDreamCache[0], title: '并发修改' }]; },
        runtime => { runtime.isGenerating = true; }, runtime => { runtime.longDreamCache[0].memory.status = 'weaving'; },
        runtime => { runtime.refreshingLongDreamSummaries = new Set(['7']); }]) {
        const h = uiHarness(t, { mutate });
        await saveDisplayedResultToDream(h.runtime);
        assert.equal(h.writes.length, 0);
        assert.deepEqual(h.navigation, []);
    }
});

test('连续点击只开一个保存流程，不会重复新增章候选', async t => {
    const h = uiHarness(t, { held: true });
    const first = saveDisplayedResultToDream(h.runtime);
    await saveDisplayedResultToDream(h.runtime);
    h.release();
    await first;
    assert.equal(h.writes.length, 1);
});
