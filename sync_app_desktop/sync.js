// sync.js - Background sync with remote TiddlyWiki server
//
// Push phase: send all locally-dirty tiddlers to remote (PUT or DELETE).
// Pull phase: fetch remote tiddler list, compare by `modified` timestamp,
//             pull updated tiddlers, detect remote deletions.
//
// Conflict resolution: newer `modified` timestamp wins. If local is dirty
// AND remote is newer, local wins (so user's unsaved changes aren't stomped
// by a stale remote push — last-write-wins with local priority).

const fetch = require('node-fetch');
const https = require('https');
const http = require('http');
const db = require('./db');
const config = require('./config');
const events = require('./events');

// Reuse TCP + TLS connections across the many probes we fire in the
// system-override phase. Without this, each GET pays a fresh handshake,
// turning a 305-probe cycle into a ~2-minute operation.
const keepAliveAgent = {
    http:  new http.Agent({ keepAlive: true, maxSockets: 25 }),
    https: new https.Agent({ keepAlive: true, maxSockets: 25 })
};
function agentFor(url) {
    return url.startsWith('https:') ? keepAliveAgent.https : keepAliveAgent.http;
}

let syncing = false;
let timer = null;
let listeners = [];

// ---- Status emitter (so UI / tray can show sync state) ----

function on(fn) { listeners.push(fn); }
function emit(status) { for (const fn of listeners) { try { fn(status); } catch (e) {} } }

// ---- HTTP helpers ----

function authHeader() {
    const cfg = config.get();
    if (cfg.username && cfg.password) {
        const b64 = Buffer.from(cfg.username + ':' + cfg.password).toString('base64');
        return 'Basic ' + b64;
    }
    return null;
}

function remoteUrl(path) {
    return config.get().remoteUrl + path;
}

function defaultHeaders(extra = {}) {
    const h = Object.assign({
        'Accept': 'application/json',
        'X-Requested-With': 'TiddlyWiki'
    }, extra);
    const a = authHeader();
    if (a) h['Authorization'] = a;
    return h;
}

async function fetchRemoteSkinnyList() {
    const url = remoteUrl('/recipes/default/tiddlers.json');
    const res = await fetch(url, { headers: defaultHeaders(), timeout: 60000 });
    if (!res.ok) throw new Error('list: HTTP ' + res.status);
    return res.json();  // array of {title, modified, revision, ...}
}

function normalizeTiddlerResponse(data, knownTitle, revisionOverride) {
    if (!data) return null;
    let fields;
    let revision = revisionOverride || data.revision || null;

    if (data.title) {
        // Standard flat response (most servers, including yhtiddly.fun).
        // Some TiddlyWeb implementations also attach a nested `fields` sub-object
        // containing non-standard field names. Merge those in WITHOUT overwriting
        // the top-level fields, which are authoritative.
        fields = Object.assign({}, data);
        if (data.fields && typeof data.fields === 'object' && !Array.isArray(data.fields)) {
            for (const [k, v] of Object.entries(data.fields)) {
                if (!(k in fields)) fields[k] = v;
            }
        }
        // Strip server-only meta keys that are not tiddler fields.
        delete fields.bag;
        delete fields.revision;
        delete fields.fields;   // already merged above
    } else if (data.fields && typeof data.fields === 'object' && !Array.isArray(data.fields)) {
        // Old-style wrapped response: { fields: { title:…, text:…, … }, bag:…, revision:… }
        fields = Object.assign({}, data.fields);
    } else if (typeof data === 'object') {
        fields = Object.assign({}, data);
        delete fields.bag;
        delete fields.revision;
    } else {
        return null;
    }

    // Strip garbled numeric-index keys that arise when a plain object is
    // accidentally spread into a fields map (e.g. "[object Object]" → 0..14).
    // Tiddler field names cannot legally start with a digit.
    for (const k of Object.keys(fields)) {
        if (/^\d+$/.test(k)) delete fields[k];
    }

    if (!fields.title) fields.title = knownTitle;
    return { revision, fields };
}

// Parse TW modified timestamp to epoch ms. Handles both formats:
//   - TW compact: "20240101120000000" (YYYYMMDDHHmmssSSS)
//   - ISO 8601:   "2024-01-01T12:00:00.000Z"
// Returns 0 for missing/unparseable values (so they sort as "oldest").
function parseModified(s) {
    if (!s) return 0;
    const str = String(s);
    const m = str.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})?$/);
    if (m) {
        return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] || 0));
    }
    const t = Date.parse(str);
    return isNaN(t) ? 0 : t;
}

function revisionFromEtag(etag) {
    if (!etag) return null;
    const m = etag.match(/"[^/]+\/[^/]+\/(\d+):/);
    return m ? m[1] : null;
}

async function fetchRemoteTiddlerOnce(title) {
    const url = remoteUrl('/recipes/default/tiddlers/' + encodeURIComponent(title));
    const res = await fetch(url, { headers: defaultHeaders(), timeout: 30000, agent: agentFor(url) });
    if (res.status === 404) {
        const bagUrl = remoteUrl('/bags/default/tiddlers/' + encodeURIComponent(title));
        const bagRes = await fetch(bagUrl, { headers: defaultHeaders(), timeout: 30000, agent: agentFor(bagUrl) });
        if (bagRes.status === 404) return null;
        if (!bagRes.ok) throw new Error('HTTP ' + bagRes.status + ' (bag fallback)');
        const bagText = await bagRes.text();
        const rev = revisionFromEtag(bagRes.headers.get('etag'));
        try { return normalizeTiddlerResponse(JSON.parse(bagText), title, rev); }
        catch (e) { throw new Error('bad JSON (bag): ' + bagText.slice(0, 80)); }
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rev = revisionFromEtag(res.headers.get('etag'));
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error('bad JSON: ' + text.slice(0, 80)); }
    return normalizeTiddlerResponse(data, title, rev);
}

// Wrap with retries (3 attempts, exponential backoff)
async function fetchRemoteTiddler(title) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await fetchRemoteTiddlerOnce(title);
        } catch (e) {
            lastErr = e;
            if (attempt < 2) {
                // backoff 500ms, 1500ms
                await new Promise(r => setTimeout(r, 500 * (1 + attempt * 2)));
            }
        }
    }
    throw lastErr;
}

async function pushTiddler(title, fields) {
    if (!fields) throw new Error('pushTiddler: fields is null for ' + title);
    const url = remoteUrl('/recipes/default/tiddlers/' + encodeURIComponent(title));
    const body = JSON.stringify(fields);
    const res = await fetch(url, {
        method: 'PUT',
        headers: defaultHeaders({ 'Content-Type': 'application/json', 'X-Requested-With': 'TiddlyWiki' }),
        body
    });
    if (!res.ok) throw new Error('put ' + title + ': HTTP ' + res.status);
    // Remote returns new revision in Etag header
    const etag = res.headers.get('etag') || '';
    const m = etag.match(/"[^/]+\/[^/]+\/(\d+):/);
    return m ? m[1] : null;
}

async function pushDeletion(title) {
    const url = remoteUrl('/bags/default/tiddlers/' + encodeURIComponent(title));
    const res = await fetch(url, {
        method: 'DELETE',
        headers: defaultHeaders({ 'X-Requested-With': 'TiddlyWiki' })
    });
    if (!res.ok && res.status !== 404) throw new Error('delete ' + title + ': HTTP ' + res.status);
    return true;
}

// ---- Initial full sync (on first run) ----

// Try the /bulk-tiddlers/ endpoint (if the remote server has the custom route
// installed). Returns array of tiddlers with text, or null if the endpoint
// isn't available — caller will then fall back to per-tiddler fetches.
async function tryBulkFetch(progressCb) {
    const PAGE_SIZE = 1000;
    let all = [];
    let offset = 0;
    while (true) {
        const url = remoteUrl('/bulk-tiddlers/?offset=' + offset + '&limit=' + PAGE_SIZE);
        const res = await fetch(url, { headers: defaultHeaders() });
        if (!res.ok) {
            if (offset === 0) return null;  // endpoint absent → signal fallback
            throw new Error('bulk: HTTP ' + res.status);
        }
        const data = await res.json();
        if (!data || !Array.isArray(data.tiddlers)) return null;

        all = all.concat(data.tiddlers);
        if (progressCb) progressCb({ done: all.length, total: data.total });
        emit({ phase: 'initial', status: 'bulk-fetching', done: all.length, total: data.total });

        offset += PAGE_SIZE;
        if (offset >= data.total) break;
    }
    return all;
}

async function initialFullSync(progressCb) {
    emit({ phase: 'initial', status: 'starting' });

    // Strategy 1: try bulk endpoint first (much faster if available)
    try {
        const bulk = await tryBulkFetch(progressCb);
        if (bulk && bulk.length) {
            // Commit in chunks to avoid holding huge tx in memory
            const CHUNK = 500;
            for (let i = 0; i < bulk.length; i += CHUNK) {
                db.bulkPutRemote(bulk.slice(i, i + CHUNK));
            }
            db.setMeta('initial-sync-complete', '1');
            db.setMeta('last-sync', String(Date.now()));
            emit({ phase: 'initial', status: 'done', done: bulk.length, total: bulk.length });
            console.log('[sync] initial (bulk): saved', bulk.length);
            return;
        }
    } catch (e) {
        console.warn('[sync] bulk fetch failed, falling back to per-tiddler:', e.message);
    }

    // Strategy 2: fallback — per-tiddler fetch with concurrency
    const list = await fetchRemoteSkinnyList();
    const total = list.length;
    console.log('[sync] initial (per-tiddler): remote has', total, 'tiddlers');

    const CONCURRENCY = 15;
    const BATCH_SIZE = 200;
    let done = 0;
    let buffer = [];

    async function worker(queue) {
        while (queue.length > 0) {
            const item = queue.shift();
            if (!item) continue;
            try {
                const full = await fetchRemoteTiddler(item.title);
                if (full && full.fields) buffer.push(full.fields);
            } catch (e) {
                console.warn('[sync] failed to fetch', item.title, e.message);
            }
            done++;
            if (buffer.length >= BATCH_SIZE) {
                db.bulkPutRemote(buffer);
                buffer = [];
            }
            if (progressCb) progressCb({ done, total });
            emit({ phase: 'initial', status: 'fetching', done, total });
        }
    }

    const queue = list.slice();
    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker(queue));
    await Promise.all(workers);

    if (buffer.length) db.bulkPutRemote(buffer);
    db.setMeta('initial-sync-complete', '1');
    db.setMeta('last-sync', String(Date.now()));
    emit({ phase: 'initial', status: 'done', done, total });
    console.log('[sync] initial: done, saved', done);
}

function isInitialSyncDone() {
    return db.getMeta('initial-sync-complete') === '1';
}

// ---- System-tiddler override discovery -----------------------------------
//
// Why this exists: when a TW5 wiki sets `$:/config/SyncSystemTiddlersFromServer`
// to "no" (the safe default — preserves user-customised system tiddlers from
// being wiped by incomplete server responses), the server appends
// `+[!is[system]]` to every filter on `/recipes/default/tiddlers.json` (see
// TW5 core-server/server/routes/get-tiddlers-json.js:31). That hides every
// `$:/...` tiddler from the skinny list — including user *overrides* of
// plugin shadow tiddlers such as `$:/plugins/<author>/<plugin>/config/...`,
// which are the tiddlers the user edits through a plugin's control-panel UI.
//
// Workaround: we can still fetch each override tiddler individually
// (/recipes/default/tiddlers/<title> returns 200 with the full fields even
// when the skinny list hides it). So we build a candidate title list from
// the wiki's plugin manifests and probe each candidate on every sync cycle.
// Plugins are read out of the wiki's index HTML (they appear as
// `$:/plugins/<author>/<plugin>` paths). For each plugin, the plugin tiddler's
// `text` is a JSON blob `{tiddlers: {<shadow-title>: {...}, ...}}` whose keys
// enumerate every shadow tiddler that user can override.
//
// The expensive HTML-scrape + per-plugin GETs are cached for 1 hour in the
// meta table; the per-title probe still runs every sync (it's cheap — ~100
// parallel conditional GETs).

const OVERRIDE_DISCOVERY_TTL_MS = 60 * 60 * 1000;

// A typical 100-plugin wiki exposes ~1500 shadow tiddlers. Probing all of
// them every sync is wasteful — most are code/UI/styles that the user will
// never override. Filter down to tiddlers that a user might realistically
// set from a control-panel UI: config values, preferences, state, and the
// like. This doesn't lose correctness (we can always widen the filter) —
// anything rejected just won't auto-pull, and the user can still edit it
// locally, which triggers the normal dirty-push path.
function isLikelyOverrideTarget(title) {
    if (!title || !title.startsWith('$:/')) return false;
    // Plugin metadata / code / UI assets — never user-overridden at runtime.
    if (/\/(readme|license|icon|styles?|stylesheet|toolbar-button|result-panel|language|languages)$/i.test(title)) return false;
    if (/\.js$/i.test(title)) return false;
    if (/\.(css|png|jpg|jpeg|svg|gif|woff2?)$/i.test(title)) return false;
    if (/\/(templates?|ui|macros?|widgets?|filters?|parsers?)\//i.test(title)) return false;
    // Configurable surface: explicit config paths, state, preferences, plugin settings.
    if (/\/(config|settings?|preferences?|state|status|options?)(\/|$)/i.test(title)) return true;
    if (title.startsWith('$:/config/')) return true;
    if (title.startsWith('$:/state/')) return true;
    // For plugin-namespaced tiddlers, include any tiddler whose LAST segment
    // hints at a user-facing knob (api-key, model, endpoint, url, key…).
    if (/\/(api[-_]?(key|url|token|endpoint|base)|token|secret|model|endpoint|url|host|user(name)?|password)$/i.test(title)) return true;
    return false;
}

async function fetchWikiHtml() {
    const res = await fetch(remoteUrl('/'), {
        headers: defaultHeaders({ 'Accept': 'text/html' }),
        timeout: 60000
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
}

// Scrape plugin root paths (4-segment `$:/plugins/<author>/<name>`) out of
// the wiki's index HTML. Captures any plugin path, then dedupes to the root.
function extractPluginRootsFromHtml(html) {
    const roots = new Set();
    const re = /\$:\/plugins\/[A-Za-z0-9_\-.]+\/[A-Za-z0-9_\-.]+/g;
    let m;
    while ((m = re.exec(html)) !== null) roots.add(m[0]);
    return Array.from(roots);
}

async function discoverSystemOverrideTitles() {
    const META_KEY = 'override-titles-cache';
    const cachedRaw = db.getMeta(META_KEY);
    if (cachedRaw) {
        try {
            const c = JSON.parse(cachedRaw);
            if (c && Array.isArray(c.titles) && (Date.now() - c.ts) < OVERRIDE_DISCOVERY_TTL_MS) {
                return c.titles;
            }
        } catch (e) { /* corrupt cache entry — fall through to re-discover */ }
    }

    let html;
    try { html = await fetchWikiHtml(); }
    catch (e) {
        console.warn('[sync] override discovery: HTML fetch failed:', e.message);
        return [];
    }

    const roots = extractPluginRootsFromHtml(html);
    const titles = new Set();
    const queue = roots.slice();
    const CONC = 6;

    async function worker() {
        while (queue.length > 0) {
            const pluginTitle = queue.shift();
            if (!pluginTitle) continue;
            try {
                const full = await fetchRemoteTiddler(pluginTitle);
                if (!full || !full.fields || !full.fields.text) continue;
                let plug;
                try { plug = JSON.parse(full.fields.text); }
                catch (e) { continue; }  // not a plugin-shaped tiddler
                if (plug && plug.tiddlers && typeof plug.tiddlers === 'object') {
                    for (const k of Object.keys(plug.tiddlers)) {
                        if (k && k.startsWith('$:/') && isLikelyOverrideTarget(k)) {
                            titles.add(k);
                        }
                    }
                }
            } catch (e) { /* 404 / network — skip */ }
        }
    }
    const workers = [];
    for (let i = 0; i < CONC; i++) workers.push(worker());
    await Promise.all(workers);

    const out = Array.from(titles);
    db.setMeta(META_KEY, JSON.stringify({ ts: Date.now(), titles: out }));
    console.log('[sync] override discovery:', out.length, 'candidate titles across', roots.length, 'plugins');
    return out;
}

// Probe each candidate system-tiddler title on the remote and ingest any that
// exist (i.e. the user has a real override stored on the server). `putTiddler`
// with source='remote' already guards local dirty edits, so races with a
// concurrent local save are handled correctly.
async function pullSystemOverrides(titles, report) {
    if (!titles || !titles.length) return;
    const localMap = db.getModifiedMap();
    const queue = titles.filter(t => t && t.startsWith('$:/'));
    // Higher concurrency here than in the main pull loop: each probe is a
    // short GET with most responses being 404 (no override present). The
    // keepAliveAgent pools connections so the cost per probe is tiny.
    const CONC = 20;
    let pulled = 0, probed = 0, deleted = 0;

    async function worker() {
        while (queue.length > 0) {
            const title = queue.shift();
            if (!title) continue;
            probed++;

            // Snapshot local state from the cached modified-map. We don't
            // re-query mid-loop; a concurrent local edit that races us is
            // still protected by putTiddler's `preserveLocal` clause and by
            // deleteTiddler honouring the dirty flag.
            const local = localMap[title];

            let full;
            try { full = await fetchRemoteTiddler(title); }
            catch (e) {
                // Network error / non-404 HTTP failure — don't interpret as
                // "gone". Leave local state alone and retry next cycle.
                continue;
            }

            if (full && full.fields) {
                // Override exists on remote — ingest if newer than local.
                const rMod = parseModified(full.fields.modified);
                const lMod = local ? parseModified(local.modified) : 0;
                if (!local || rMod > lMod) {
                    db.putTiddler(full.fields, 'remote', full.revision);
                    events.broadcast('update', Object.assign({}, full.fields, {
                        revision: full.revision != null ? String(full.revision) : '0',
                        bag: 'default'
                    }));
                    pulled++;
                }
            } else if (local && local.dirty === 0) {
                // Remote returned 404 AND we have a *clean* local copy:
                // treat as a remote deletion (another client reverted the
                // override back to the plugin's shadow default). Dirty local
                // rows are protected — the user's unpushed edit wins, and
                // the next push will re-create the tiddler on the server.
                //
                // Safe because the probe list comes from the plugins'
                // declared shadow tiddlers. We only delete titles that
                // WE ourselves expect as potential overrides; arbitrary
                // `$:/` tiddlers aren't touched.
                if (db.deleteTiddler(title, 'remote')) {
                    events.broadcast('delete', { title });
                    deleted++;
                }
            }
            // (no local, no remote) → candidate shadow without override;
            // nothing to do — this is the common case for ~95% of titles.
        }
    }
    const workers = [];
    for (let i = 0; i < CONC; i++) workers.push(worker());
    await Promise.all(workers);

    report.pulledOverrides = pulled;
    report.removedOverrides = deleted;
    if (pulled || deleted) {
        console.log('[sync] overrides: +' + pulled + ' / -' + deleted + ' (probed ' + probed + ')');
    }
}

// ---- Incremental sync (every N seconds) ----

async function syncOnce() {
    if (syncing) {
        console.log('[sync] skip: already syncing');
        return { skipped: true };
    }
    if (!config.isConfigured()) {
        emit({ phase: 'idle', status: 'not-configured' });
        return { error: 'not configured' };
    }

    syncing = true;
    const report = { pushed: 0, deleted: 0, pulled: 0, removed: 0, errors: [] };

    try {
        emit({ phase: 'push', status: 'starting', pushTotal: 0, pushDone: 0 });

        // --- Push phase ---
        const NOSYNC = new Set(['$:/StoryList']);
        const dirty = db.getDirty().filter(d => !NOSYNC.has(d.title) && !db.isDraft(d.fields));
        for (let i = 0; i < dirty.length; i++) {
            const d = dirty[i];
            emit({ phase: 'push', status: 'pushing', pushTotal: dirty.length, pushDone: i });
            try {
                if (d.tombstone) {
                    console.log('[sync] push delete:', d.title);
                    await pushDeletion(d.title);
                    db.purgeTombstone(d.title);
                    report.deleted++;
                } else if (!d.fields) {
                    console.warn('[sync] skip push: null fields (missing file) for', d.title);
                    report.errors.push({ title: d.title, op: 'put', msg: 'missing local file — skipped' });
                } else {
                    console.log('[sync] push update:', d.title);
                    const newRev = await pushTiddler(d.title, d.fields);
                    db.clearDirty(d.title, newRev);
                    report.pushed++;
                }
            } catch (e) {
                report.errors.push({ title: d.title, op: d.tombstone ? 'delete' : 'put', msg: e.message });
            }
        }

        emit({ phase: 'pull', status: 'listing' });

        // --- Pull phase ---
        const remoteList = await fetchRemoteSkinnyList();
        const remoteMap = {};
        for (const r of remoteList) remoteMap[r.title] = r;

        const localMap = db.getModifiedMap();

        // Normalize revisions for comparison. The remote may send `1` as a
        // JSON number, while the local DB might hold `'1.0'` as text (a
        // legacy artefact from an older code path that stored the revision
        // as a float). A naive `!==` strict compare treats these as
        // different on every cycle and triggers endless re-pulls. Coerce
        // both sides through `parseFloat` to a canonical number, then
        // compare as numbers — `Number.isNaN` sentinels for "no revision".
        const normRev = v => {
            if (v === null || v === undefined || v === '' || v === '0' || v === 0) return null;
            const n = typeof v === 'number' ? v : parseFloat(String(v));
            return Number.isFinite(n) ? n : null;
        };

        const toFetch = [];
        for (const title in remoteMap) {
            // Filesystem-path ghosts. TidGi's filesystem adaptor sometimes
            // leaks absolute file paths (e.g. "/root/…/tiddlers/foo.tid")
            // into the skinny list on the remote. Those entries have no
            // `modified`, their individual GET returns 404, and they can
            // never be pulled — but the pull loop still counts them in
            // `pullTotal`, producing a perpetual "2/2" noise in the UI.
            // No legal TW title starts with '/', so this is safe.
            if (title.startsWith('/')) continue;

            const r = remoteMap[title];
            const l = localMap[title];
            if (!l) {
                toFetch.push(title);
                continue;
            }
            const rMod = parseModified(r.modified);
            const lMod = parseModified(l.modified);
            if (rMod > lMod) {
                toFetch.push(title);
            } else {
                const rRev = normRev(r.revision);
                const lRev = normRev(l.revision);
                if (rRev !== null && lRev !== null && rRev !== lRev && rMod >= lMod) {
                    toFetch.push(title);
                }
            }
        }

        emit({ phase: 'pull', status: 'fetching', pullTotal: toFetch.length, pullDone: 0 });

        // Parallel fetch with progress
        const CONCURRENCY = 10;
        const queue = toFetch.slice();
        let processed = 0;
        const totalToFetch = toFetch.length;
        async function worker() {
            while (queue.length > 0) {
                const title = queue.shift();
                if (!title) continue;
                try {
                    const full = await fetchRemoteTiddler(title);
                    if (full && full.fields) {
                        db.putTiddler(full.fields, 'remote', full.revision);
                        events.broadcast('update', Object.assign({}, full.fields, {
                            revision: full.revision != null ? String(full.revision) : '0',
                            bag: 'default'
                        }));
                        report.pulled++;
                    }
                } catch (e) {
                    report.errors.push({ title, op: 'pull', msg: e.message });
                }
                processed++;
                if (processed % 10 === 0 || processed === totalToFetch) {
                    emit({
                        phase: 'pull', status: 'fetching',
                        pullTotal: totalToFetch, pullDone: processed,
                        errors: report.errors.length
                    });
                }
            }
        }
        const workers = [];
        for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
        await Promise.all(workers);

        // --- Detect remote deletions ---
        // A tiddler absent from the remote skinny list may mean one of:
        //   (a) it was genuinely deleted on the server, or
        //   (b) the remote's $:/config/SyncSystemTiddlersFromServer = 'no'
        //       filters `$:/...` titles out of the skinny list even though
        //       the tiddlers still exist on the server.
        // For (a) we delete locally. For (b) we must NOT delete based on list
        // absence — that would wipe user customisations like
        // $:/config/AnimationDuration on every sync.
        //
        // For non-system titles: case (b) doesn't apply; safe to delete when
        // absent from the skinny list and local is clean.
        //
        // For `$:/` titles: absence from the skinny list is NOT evidence of
        // deletion. Delete detection for system tiddlers is delegated to the
        // override-probe loop below (which runs an explicit GET per candidate
        // on a rate-limited schedule and only touches titles that appear in
        // some plugin's declared shadow list).
        for (const title in localMap) {
            if (remoteMap[title]) continue;
            if (title.startsWith('$:/')) continue;
            // Draft tiddlers ("Draft of 'xxx'") are local-only editor state — TW
            // never pushes them to the remote server, so they will NEVER appear in
            // the remote skinny list. Without this guard the sync loop would see
            // every open draft as "remotely deleted" and hard-delete it, closing
            // the user's edit panel mid-edit.
            if (db.isDraft({ title })) continue;
            const dirtyRow = db.getRaw().prepare('SELECT dirty FROM tiddlers WHERE title = ?').get(title);
            if (!dirtyRow || dirtyRow.dirty !== 0) continue;
            console.log('[sync] remote delete detected:', title);
            if (db.deleteTiddler(title, 'remote')) {
                events.broadcast('delete', { title });
                report.removed++;
            }
        }

        // --- Probe system-tiddler overrides hidden from the skinny list ---
        // (see note above discoverSystemOverrideTitles). Rate-limited to run
        // once every OVERRIDE_PROBE_INTERVAL_MS because each invocation costs
        // ~300 HTTPS round-trips (one per candidate title). Failures here are
        // non-fatal: the main push/pull above is what keeps user content in
        // sync. This only rescues plugin config tiddlers and similar.
        const OVERRIDE_PROBE_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes
        const lastProbeRaw = db.getMeta('last-override-probe');
        const lastProbe = lastProbeRaw ? parseInt(lastProbeRaw, 10) : 0;
        if ((Date.now() - lastProbe) >= OVERRIDE_PROBE_INTERVAL_MS) {
            try {
                const overrideTitles = await discoverSystemOverrideTitles();
                if (overrideTitles.length) {
                    emit({ phase: 'pull', status: 'overrides', pullTotal: overrideTitles.length, pullDone: 0 });
                    await pullSystemOverrides(overrideTitles, report);
                }
                db.setMeta('last-override-probe', String(Date.now()));
            } catch (e) {
                console.warn('[sync] system-override probe failed:', e.message);
                report.errors.push({ op: 'override-probe', msg: e.message });
            }
        }

        db.setMeta('last-sync', String(Date.now()));
        emit({ phase: 'idle', status: 'done', report });
    } catch (e) {
        console.error('[sync] error:', e.message);
        report.errors.push({ op: 'sync', msg: e.message });
        emit({ phase: 'idle', status: 'error', error: e.message, report });
    } finally {
        syncing = false;
    }

    return report;
}

// ---- Scheduler ----

function start() {
    stop();
    const cfg = config.get();
    const interval = cfg.syncInterval || 15000;
    timer = setInterval(() => {
        syncOnce().catch(e => console.error('[sync] background error:', e.message));
    }, interval);
    console.log('[sync] background sync started, interval =', interval, 'ms');
}

function stop() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

async function finalSync() {
    console.log('[sync] final sync before quit...');
    try {
        await syncOnce();
    } catch (e) {
        console.error('[sync] final sync failed:', e.message);
    }
}

// Push-only sync for fast shutdown. Only pushes dirty tiddlers and deletions,
// skips the pull phase (fetching remote list + comparing is the slow part).
async function pushOnly() {
    if (syncing) return { skipped: true, pushed: 0, deleted: 0 };
    if (!config.isConfigured()) return { pushed: 0, deleted: 0 };

    syncing = true;
    const report = { pushed: 0, deleted: 0, errors: [] };

    try {
        const dirty = db.getDirty().filter(d => !db.isDraft(d.fields));
        // Concurrent push
        const CONCURRENCY = 5;
        const queue = dirty.slice();
        async function worker() {
            while (queue.length > 0) {
                const d = queue.shift();
                if (!d) continue;
                try {
                    if (d.tombstone) {
                        await pushDeletion(d.title);
                        db.purgeTombstone(d.title);
                        report.deleted++;
                    } else {
                        const newRev = await pushTiddler(d.title, d.fields);
                        db.clearDirty(d.title, newRev);
                        report.pushed++;
                    }
                } catch (e) {
                    report.errors.push({ title: d.title, msg: e.message });
                }
            }
        }
        const workers = [];
        for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
        await Promise.all(workers);
    } finally {
        syncing = false;
    }

    return report;
}

function getStatus() {
    return {
        syncing,
        totalTiddlers: db.count(),
        dirtyCount: db.countDirty(),
        lastSync: parseInt(db.getMeta('last-sync') || '0', 10),
        initialComplete: isInitialSyncDone()
    };
}

module.exports = {
    initialFullSync, isInitialSyncDone, syncOnce, start, stop, finalSync, pushOnly,
    getStatus, on,
    // Test-only exports (used by scripts/test-override-discovery.js)
    _test_discoverSystemOverrideTitles: discoverSystemOverrideTitles,
    _test_pullSystemOverrides: pullSystemOverrides
};
