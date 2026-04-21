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
const db = require('./db');
const config = require('./config');

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
    const res = await fetch(url, { headers: defaultHeaders(), timeout: 30000 });
    if (res.status === 404) {
        const bagUrl = remoteUrl('/bags/default/tiddlers/' + encodeURIComponent(title));
        const bagRes = await fetch(bagUrl, { headers: defaultHeaders(), timeout: 30000 });
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

        const toFetch = [];
        for (const title in remoteMap) {
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
            } else if (r.revision && l.revision && l.revision !== '0' &&
                       r.revision !== l.revision && rMod >= lMod) {
                toFetch.push(title);
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
        for (const title in localMap) {
            if (!remoteMap[title]) {
                const dirtyRow = db.getRaw().prepare('SELECT dirty FROM tiddlers WHERE title = ?').get(title);
                if (dirtyRow && dirtyRow.dirty === 0) {
                    console.log('[sync] remote delete detected:', title);
                    db.deleteTiddler(title, 'remote');
                    report.removed++;
                }
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
    getStatus, on
};
