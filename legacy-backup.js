import { BACKUP_FORMAT, BACKUP_MANIFEST, MAX_BACKUP_BYTES, createCompleteBackup, digest, normalizeBackupData, parseCompleteBackup } from './backup-data.js';
import { HISTORY_ARCHIVE_MANIFEST, historyItemsFromArchive, normalizeHistoryBackup } from './history-backup.js';
import { LONG_DREAM_ARCHIVE_MANIFEST, parseLongDreamArchive } from './long-dream-archive.js';
import { parseLongDreamBackup } from './long-dream-backup.js';
import { parseInstructionBackup } from './instruction-backup.js';

function readJson(text) {
    try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch { throw new Error('备份 JSON 无法读取，请重新选择完整的导出文件。'); }
}

async function readZip(file, loadZip, progress) {
    progress('zipLibrary');
    const JSZip = await loadZip();
    progress('zipRead');
    let zip;
    try { zip = await JSZip.loadAsync(file); }
    catch { throw new Error('ZIP 无法打开，请检查下载是否完整。'); }

    const entries = Object.values(zip.files).filter(entry => !entry.dir);
    const bytes = entries.reduce((sum, entry) => sum + Number(entry._data?.uncompressedSize || 0), 0);
    if (entries.length > 5000 || bytes > MAX_BACKUP_BYTES) throw new Error('解压后的备份过大，请从旧插件分项导出。');
    progress('manifest');
    const find = name => entries.find(entry => entry.name.split('/').pop().toLowerCase() === name);
    const complete = find(BACKUP_MANIFEST);
    if (complete) return readJson(await complete.async('string'));
    const manifest = find(LONG_DREAM_ARCHIVE_MANIFEST) || find(HISTORY_ARCHIVE_MANIFEST);
    if (!manifest && find('manifest.json') && find('index.js')) throw new Error('这是插件安装包。请在千夜浮梦的「设置 → 备份与恢复」下载作品备份，再选择那个文件。');
    const prefix = manifest ? manifest.name.slice(0, manifest.name.lastIndexOf('/') + 1) : '';
    const files = entries.filter(entry => entry.name.startsWith(prefix));
    if (manifest?.name.toLowerCase().endsWith(LONG_DREAM_ARCHIVE_MANIFEST)) {
        const meta = readJson(await manifest.async('string'));
        const chapters = await Promise.all(files.filter(entry => /\.(txt|html?)$/i.test(entry.name)).map(async entry => ({
            name: entry.name.slice(prefix.length), content: await entry.async('string'),
        })));
        return { dreams: parseLongDreamArchive(meta, chapters) };
    }
    const meta = manifest ? readJson(await manifest.async('string')) : null;
    const html = await Promise.all(files.filter(entry => /\.html?$/i.test(entry.name)).map(async entry => ({
        name: entry.name.slice(prefix.length), html: await entry.async('string'),
    })));
    const history = historyItemsFromArchive(meta, html);
    if (meta && (!Array.isArray(meta.items) || history.length !== meta.items.length)) throw new Error('书架 ZIP 的清单与正文数量不一致，请重新导出完整备份。');
    return { history, folders: meta?.folders || [] };
}

// Older SillyTavern settings backups may still hold works in the plugin's fallback arrays.
function oldSettingsData(data) {
    const settings = data?.extension_settings?.theater_generator ?? data?.theater_generator ??
        (Array.isArray(data?.longDreams) || Array.isArray(data?.instructionTemplates) || Array.isArray(data?.recentGenerations) || data?.currentGenerationResult ? data : null);
    if (!settings) return null;
    return {
        history: settings.history, folders: settings.historyCollections,
        dreams: (Array.isArray(settings.longDreams) ? settings.longDreams : []).filter(Boolean).map(dream => ({
            ...dream, createdAt: dream.createdAt || dream.updatedAt || '1970-01-01T00:00:00.000Z',
            composerDraft: settings.longDreamComposerDrafts?.[dream.id] ?? dream.composerDraft,
        })),
        current: settings.currentGenerationResult, recent: settings.recentGenerations,
        instructions: settings.instructionTemplates, instructionTags: settings.instructionTags,
    };
}

export async function decodeBackupFile(file, scope, loadZip, progress = () => {}) {
    if (file.size > MAX_BACKUP_BYTES) throw new Error('备份文件超过 128 MB，请分项导入。');
    let data;
    if (/\.zip$/i.test(file.name)) data = await readZip(file, loadZip, progress);
    else if (/\.html?$/i.test(file.name) && ['history', 'all'].includes(scope)) {
        data = { history: [{ title: file.name.replace(/\.html?$/i, ''), html: await file.text(), mode: 'html' }] };
    } else data = readJson(await file.text());
    progress('validate');
    if (data?.format === BACKUP_FORMAT) return parseCompleteBackup(data);
    progress('normalize');
    let content = oldSettingsData(data);
    if (!content) {
        if (data?.format === 'st-theater-instructions') {
            const parsed = parseInstructionBackup(data);
            if (parsed) content = { instructions: parsed.templates, instructionTags: parsed.tags };
        } else if (data?.format === 'st-theater-long-dream') content = { dreams: parseLongDreamBackup(data) };
        else if (Array.isArray(data?.dreams)) content = { dreams: data.dreams };
        else content = { history: normalizeHistoryBackup(data), folders: data?.folders || [] };
    }
    const normalized = normalizeBackupData(content || {});
    if (!(normalized.history.length || normalized.dreams.length || normalized.instructions.length || normalized.current ||
        normalized.recent.length || normalized.folders.length || normalized.instructionTags.length)) {
        throw new Error('文件里没有可恢复的作品或指令。请在原酒馆地址打开千夜浮梦，下载完整备份，或查找本机旧存档。');
    }
    return createCompleteBackup(normalized, { sourceId: (await digest(normalized)).slice(0, 32), deviceName: '旧版备份' });
}
