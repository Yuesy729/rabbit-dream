import { extensionDirectory } from './extension-location.js';
export function compareVersion(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n) || 0);
    const pb = String(b).split('.').map(n => parseInt(n) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x > y) return 1;
        if (x < y) return -1;
    }
    // Preview letters are revisions after the same numeric release: a..z, aa..
    const suffix = value => String(value ?? '').trim().match(/^\d+(?:\.\d+)*([a-z]+)$/i)?.[1].toLowerCase() || '';
    const sa = suffix(a), sb = suffix(b);
    if (sa === sb) return 0;
    if (sa.length !== sb.length) return sa.length > sb.length ? 1 : -1;
    return sa > sb ? 1 : -1;
}

export async function fetchInstalledExtensionStatus({
    extensionName = extensionDirectory,
    headers = { 'Content-Type': 'application/json' },
    fetchImpl = fetch,
    timeoutMs = 7000,
} = {}) {
    const controller = new AbortController();
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            controller.abort();
            reject(new Error(`installed branch check timeout ${timeoutMs}ms`));
        }, timeoutMs);
    });
    const check = (async () => {
        const request = global => fetchImpl('/api/extensions/version', {
            method: 'POST',
            headers,
            body: JSON.stringify({ extensionName, global }),
            signal: controller.signal,
        });

        let response = await request(false);
        if (!response.ok && (response.status === 400 || response.status === 404)) {
            response = await request(true);
        }
        if (!response.ok) {
            let detail = '';
            try { detail = await response.text(); } catch {}
            throw new Error(`installed branch check failed (${response.status || 0})${detail ? `: ${detail.slice(0, 160)}` : ''}`);
        }
        const data = await response.json();
        if (!data?.currentBranchName || !data?.currentCommitHash || typeof data?.isUpToDate !== 'boolean') {
            throw new Error('installed branch check returned invalid data');
        }
        return {
            branch: String(data.currentBranchName),
            commit: String(data.currentCommitHash),
            isUpToDate: data.isUpToDate,
        };
    })();

    try {
        return await Promise.race([check, timeout]);
    } finally {
        clearTimeout(timeoutId);
    }
}

export function formatVersionCheckError(error) {
    return Array.isArray(error?.errors)
        ? error.errors.map(er => er?.message || String(er)).join(' | ')
        : (error?.message || String(error));
}
