// Standalone test: replicates discoverSystemOverrideTitles without pulling
// in better-sqlite3 (which has a native-module version mismatch outside
// Electron). Proves that the HTML-scrape + per-plugin JSON walk finds the
// plugin shadow titles we expect.

const fetch = require('node-fetch');

const REMOTE = 'https://yhtiddly.fun';

async function fetchWikiHtml() {
    const res = await fetch(REMOTE + '/', {
        headers: { 'Accept': 'text/html', 'X-Requested-With': 'TiddlyWiki' },
        timeout: 60000
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
}

function extractPluginRootsFromHtml(html) {
    const roots = new Set();
    const re = /\$:\/plugins\/[A-Za-z0-9_\-.]+\/[A-Za-z0-9_\-.]+/g;
    let m;
    while ((m = re.exec(html)) !== null) roots.add(m[0]);
    return Array.from(roots);
}

async function fetchRemoteTiddler(title) {
    const url = REMOTE + '/recipes/default/tiddlers/' + encodeURIComponent(title);
    const res = await fetch(url, { headers: { 'Accept': 'application/json' }, timeout: 30000 });
    if (!res.ok) return null;
    return res.json();
}

(async () => {
    console.log('Fetching wiki HTML …');
    const html = await fetchWikiHtml();
    console.log('  HTML size:', html.length, 'chars');

    const roots = extractPluginRootsFromHtml(html);
    console.log('\nPlugin roots found:', roots.length);
    roots.slice(0, 20).forEach(r => console.log(' ', r));

    const titles = new Set();
    console.log('\nFetching plugin manifests …');
    for (const pluginTitle of roots) {
        try {
            const data = await fetchRemoteTiddler(pluginTitle);
            if (!data || !data.text) { console.log('  [skip]', pluginTitle, '(no text)'); continue; }
            let plug;
            try { plug = JSON.parse(data.text); } catch (e) { continue; }
            if (plug && plug.tiddlers && typeof plug.tiddlers === 'object') {
                const names = Object.keys(plug.tiddlers);
                console.log('  [' + names.length + ']', pluginTitle);
                for (const k of names) if (k && k.startsWith('$:/')) titles.add(k);
            }
        } catch (e) {
            console.log('  [err]', pluginTitle, e.message);
        }
    }

    const all = Array.from(titles).sort();
    console.log('\nTotal candidate override titles (unfiltered):', all.length);

    // Mirror the filter from sync.js so we can eyeball the reduction.
    function isLikelyOverrideTarget(title) {
        if (!title || !title.startsWith('$:/')) return false;
        if (/\/(readme|license|icon|styles?|stylesheet|toolbar-button|result-panel|language|languages)$/i.test(title)) return false;
        if (/\.js$/i.test(title)) return false;
        if (/\.(css|png|jpg|jpeg|svg|gif|woff2?)$/i.test(title)) return false;
        if (/\/(templates?|ui|macros?|widgets?|filters?|parsers?)\//i.test(title)) return false;
        if (/\/(config|settings?|preferences?|state|status|options?)(\/|$)/i.test(title)) return true;
        if (title.startsWith('$:/config/')) return true;
        if (title.startsWith('$:/state/')) return true;
        if (/\/(api[-_]?(key|url|token|endpoint|base)|token|secret|model|endpoint|url|host|user(name)?|password)$/i.test(title)) return true;
        return false;
    }

    const filtered = all.filter(isLikelyOverrideTarget);
    console.log('After filter (likely override targets):', filtered.length);
    console.log('\nSample of kept titles:');
    filtered.slice(0, 30).forEach(t => console.log('  KEEP', t));

    console.log('\nSample of rejected (first 20):');
    all.filter(t => !isLikelyOverrideTarget(t)).slice(0, 20).forEach(t => console.log('  drop', t));

    // Ensure ai-normalize configs survived:
    const aiKept = filtered.filter(t => t.includes('ai-normalize'));
    console.log('\nai-normalize kept (' + aiKept.length + '):');
    aiKept.forEach(t => console.log('  ', t));
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
