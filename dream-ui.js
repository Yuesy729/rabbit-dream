// Navigation keeps the original panel keys so saved tabs and programmatic jumps still work.
export const rabbitMark = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 15C3 3 7-1 13 13l4-.3C18 0 25 0 22 15c8 7 4 13-6 13S2 23 9 15Z"/><path d="M12 20h.2m7 0h.2"/></svg>';

export function homeTab(tab) {
    if (['setting', 'dialogue', 'rules'].includes(tab)) return 'generate';
    if (['theme', 'diagnostics'].includes(tab)) return 'config';
    return tab;
}

export function navigation(tab) {
    const items = [['generate','pen','写梦'],['long-dream','book-open','长梦'],['history','book','书架'],['config','sliders','设置']];
    return items.map(([key, icon, name]) => {
        const selected = homeTab(tab) === key;
        return `<button type="button" class="theater-tab rabbit-home" data-tab="${key}" aria-current="${selected ? 'page' : 'false'}"><i class="fa-solid fa-${icon}" aria-hidden="true"></i><span>${name}</span></button>`;
    }).join('');
}

export function toolRow(tab, icon, title, detail, target = '') {
    return `<button type="button" class="rabbit-row" data-rabbit-tab="${tab}" data-rabbit-target="${target}"><i class="fa-solid fa-${icon}" aria-hidden="true"></i><span><b>${title}</b><small>${detail}</small></span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`;
}

export function writingTools() {
    return '<section class="rabbit-tools"><h3>创作工具</h3><div class="rabbit-list">'
        + toolRow('rules','tags','指令库','收藏、抽取或导入指令','theater-inst-toggle')
        + toolRow('generate','ruler','篇幅与补写','设置本篇目标字数','theater-manual-target-control')
        + toolRow('setting','layer-group','角色与世界书','选择这次创作要参考的资料','theater-wb-books')
        + toolRow('dialogue','comments','聊天前文与记忆','选择带入哪些聊天楼层')
        + toolRow('setting','feather','预设与文风','调整生成预设与补充要求','theater-preset-name-select')
        + toolRow('rules','palette','排版与互动模板','编辑 HTML 或自定义模板','theater-render-select')
        + '</div></section>';
}

function resultRow(action, icon, title, detail, reader) {
    return `<button type="button" class="rabbit-row" ${reader ? 'data-reader-action' : 'data-rabbit-result'}="${action}"><i class="fa-solid fa-${icon}" aria-hidden="true"></i><span><b>${title}</b><small>${detail}</small></span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`;
}

export function resultTools(reader = false) {
    return `            <section class="rabbit-tools rabbit-result-tools"><h3>接下来怎么写</h3><div class="rabbit-list">
                ${resultRow('continue','pen','接着这版写','从当前显示的结尾继续。',reader)}
                ${resultRow('rewrite','rotate-right','重写本段','为当前续写段落生成另一版。',reader)}
                ${resultRow('new','file','另写一篇','回到创作指令，开始独立的新篇。',reader)}
            </div><h3>这版存到哪</h3><div class="rabbit-list">
                ${resultRow('save','bookmark','存到书架','给这版起名，保存到普通作品。',reader)}
                ${resultRow('dream','book-open','加入长梦候选','选择长梦，确认后作为下一章候选。',reader)}
            </div></section>`;
}

export async function startNewStory(runtime) {
    if (runtime.isGenerating || runtime.isPreparingGeneration || runtime.resultEditSnapshot) {
        toastr.info('请先完成当前生成或编辑'); return;
    }
    if (runtime.continuationSession) {
        const session = runtime.continuationSession;
        const ok = await SillyTavern.getContext().Popup.show.confirm('退出本段续写并另写一篇？','想回看的临时版本可以先存到书架。');
        if (!ok || session !== runtime.continuationSession || runtime.isGenerating || runtime.isPreparingGeneration) return;
        runtime.clearContinueMode({silent:true});
    }
    runtime.switchResultWorkspace('generate');
    const input = document.getElementById('theater-instruction');
    if (input) {
        input.value = '';
        input.dispatchEvent(new Event('input',{bubbles:true}));
        input.scrollIntoView({block:'center'});
        input.focus({preventScroll:true});
    }
}
