import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBackupFile } from '../legacy-backup.js';
import { normalizeBackupData, planBackupRestore } from '../backup-data.js';
import { createHistoryArchive } from '../history-backup.js';

const settings = {
    history: [{ id: '1', title: '小剧场', html: '<p>旧正文</p>' }],
    historyCollections: [{ id: 's', title: '系列', itemIds: ['1'] }],
    longDreams: [{ id: 8, title: '长梦', chapters: [{ text: '一章' }] }],
    longDreamComposerDrafts: { 8: { instruction: '未提交的续写' } },
    instructionTemplates: [{ name: '场景', content: '日常' }],
    currentGenerationResult: { text: '上次的结果' }, apiKey: 'PRIVATE',
};
const file = value => ({ name: 'settings.json', text: async () => JSON.stringify(value) });
const read = value => decodeBackupFile(file(value), 'all');
const categories = ['history', 'dreams', 'instructions', 'recent'];
test('旧酒馆设置仅提取作品、文件夹、续写与指令；重复导入保留现有记录', async () => {
    const packet = await read({ extension_settings: { theater_generator: settings } });
    assert(!JSON.stringify(packet).includes('PRIVATE'));
    const original = normalizeBackupData({ history: [{ id: 'abc', html: '今天写的' }], current: { text: '现在的结果' } });
    const plan = await planBackupRestore(original, packet, categories, 'local');
    assert.equal(plan.next.history.length, 2);
    assert.equal(plan.next.folders[0].itemIds[0], plan.additions.history[0].id);
    assert.equal(plan.additions.dreams[0].composerDraft.instruction, '未提交的续写');
    assert.equal(plan.next.current.text, '现在的结果');
    assert.equal(plan.next.recovered[0].text, '上次的结果');
    assert.equal(plan.next.instructions[0].name, '场景');
    const second = await read({ extension_settings: { theater_generator: settings } });
    assert.equal((await planBackupRestore(normalizeBackupData(plan.next), second, categories, 'local')).changed, 0);
});
test('仅剩当前续写的旧设置也能恢复，空设置和损坏 JSON 有明确提示', async () => {
    assert.equal((await read({ theater_generator: { currentGenerationResult: { text: '续写' } } })).data.current.text, '续写');
    await assert.rejects(read({ extension_settings: { theater_generator: {} } }), /没有可恢复/);
    await assert.rejects(decodeBackupFile({ name: 'broken.json', text: async () => '{' }, 'all'), /JSON 无法读取/);
});
test('带上层目录的书架 ZIP 保留清单标题和系列，缺正文时阻止残缺恢复', async () => {
    const archive = createHistoryArchive(settings.history, settings.historyCollections);
    const files = {};
    const add = (name, content) => { files[name] = { name, async: async () => content }; };
    add('backups/theater-history.json', JSON.stringify(archive.manifest));
    const name = 'backups/' + archive.files[0].name;
    add(name, archive.files[0].html);
    const open = () => decodeBackupFile({ name: 'legacy.zip' }, 'all', async () => ({ loadAsync: async () => ({ files }) }));
    const packet = await open();
    assert.equal(packet.data.history[0].title, '小剧场');
    assert.deepEqual(packet.data.folders[0].itemIds, ['1']);
    delete files[name];
    await assert.rejects(open(), /正文数量不一致/);
});
