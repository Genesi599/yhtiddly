// server.js - Local Express server
//
// Serves TiddlyWiki to the browser on http://localhost:<port>
// - Tiddler REST API: served locally from SQLite cache
// - Everything else (HTML skeleton, plugin JS, etc.): proxied to remote server
//
// Browser hits local → instant response for tiddler ops
// Local cache stays in sync with remote via sync.js

const express = require('express');
const fetch = require('node-fetch');
const db = require('./db');
const config = require('./config');
const sync = require('./sync');
const events = require('./events');

let server = null;
let startedPort = null;

function buildApp() {
    const app = express();

    // Raw body buffer for PUT (tiddler data can be large, keep it as Buffer)
    app.use('/recipes/default/tiddlers/', express.raw({
        type: () => true,
        limit: '100mb'
    }));

    // JSON parser for other endpoints
    app.use(express.json({ limit: '100mb' }));

    // --- Status endpoint (TW boot checks this) ---
    app.get('/status', (req, res) => {
        res.json({
            username: config.get().username || '',
            anonymous: !config.get().username,
            read_only: false,
            logout_is_available: false,
            space: { recipe: 'default' },
            tiddlywiki_version: '5.3.8'
        });
    });

    // --- List all tiddlers (fat — no lazy-loading needed) ---
    // _fileCache is pre-warmed at startup so listFull() is instant (no disk reads).
    app.get('/recipes/default/tiddlers.json', (req, res) => {
        res.json(db.listFull());
    });

    // --- GET single tiddler (full, with text) ---
    app.get('/recipes/default/tiddlers/:title', (req, res) => {
        let title; try { title = decodeURIComponent(req.params.title); } catch(e) { title = req.params.title; }
        const t = db.getTiddler(title);
        if (!t) return res.status(404).end();
        res.set('Etag', '"default/' + encodeURIComponent(title) + '/' + t.revision + ':"');
        // bag is fixed server-side to 'default'. Merge fields first, then force
        // bag — so a stale `bag` accidentally stored on a tiddler can never
        // misroute the adaptor's DELETE (which uses the bag from GET).
        res.json(Object.assign({}, t.fields, { bag: 'default' }));
    });

    // --- PUT tiddler (save) ---
    app.put('/recipes/default/tiddlers/:title', (req, res) => {
        let title; try { title = decodeURIComponent(req.params.title); } catch(e) { title = req.params.title; }
        try {
            let fields;
            if (Buffer.isBuffer(req.body) && req.body.length) {
                const text = req.body.toString('utf8');
                try {
                    fields = JSON.parse(text);
                } catch (e) {
                    return res.status(400).send('invalid JSON body: ' + e.message);
                }
            } else if (typeof req.body === 'object' && req.body !== null && Object.keys(req.body).length > 0) {
                fields = req.body;
            } else {
                return res.status(400).send('empty body');
            }
            // Mirror TW5's put-tiddler.js reference: unconditionally pull up any
            // `fields` sub-object (the adaptor always sends non-standard fields
            // there) and drop any client-sent revision. The client's `title` is
            // authoritative when present; otherwise fall back to the URL param.
            if (fields.fields && typeof fields.fields === 'object' && !Array.isArray(fields.fields)) {
                for (const k of Object.keys(fields.fields)) {
                    if (!(k in fields)) fields[k] = fields.fields[k];
                }
                delete fields.fields;
            }
            if (fields.revision !== undefined) delete fields.revision;
            if (!fields.title) fields.title = title;

            // Stamp modified if not set
            if (!fields.modified) fields.modified = new Date().toISOString();

            // Bump a per-tiddler monotonic revision. Matches TW5's
            // `state.wiki.getChangeCount(title)` contract, so the Etag we
            // return here is the same revision that a subsequent skinny-list
            // poll will report — which means TW's syncer sees no mismatch
            // and does not spuriously requeue a load for the just-saved
            // tiddler.
            const revision = db.putTiddler(fields, 'local');
            res.set('Etag', '"default/' + encodeURIComponent(title) + '/' + revision + ':"');
            res.status(204).end();
        } catch (e) {
            console.error('[server] PUT error:', e);
            res.status(500).send(e.message);
        }
    });

    // --- DELETE tiddler ---
    app.delete('/bags/default/tiddlers/:title', (req, res) => {
        let title; try { title = decodeURIComponent(req.params.title); } catch(e) { title = req.params.title; }
        db.deleteTiddler(title, 'local');
        res.status(204).end();
    });

    // --- SSE channel: backend → TW frontend signals (e.g. deletions) ---
    // The injected HTML patch opens an EventSource on this endpoint; sync.js
    // calls events.broadcast(...) whenever it detects a remote-originated
    // delete, so the in-browser wiki can drop the tiddler without F5.
    app.get('/tws-events', (req, res) => {
        events.attach(res);
    });

    // --- Local sync control endpoints (used by settings UI) ---
    app.post('/_sync/force', async (req, res) => {
        try {
            const report = await sync.syncOnce();
            res.json(report);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/_sync/status', (req, res) => {
        res.json(sync.getStatus());
    });

    // --- Catch-all: proxy to remote with caching ---
    //
    // For GET requests, we use a stale-while-revalidate strategy:
    //   1. If cached → serve from cache instantly (fast startup)
    //   2. Revalidate in background using If-None-Match / If-Modified-Since
    //   3. Update cache on 200, no-op on 304
    //
    // For non-GET (POST/PUT/DELETE) → transparent proxy (no cache).
    //
    // This is what makes restart fast: TW HTML, plugin JS, CSS, fonts all
    // served from local SQLite after first fetch.

    const REVALIDATE_AFTER = 10 * 60 * 1000;  // 10 minutes: serve from cache without revalidating
    const inflightRevalidations = new Set();

    async function fetchUpstream(req, extraHeaders, timeout) {
        const cfg = config.get();
        const targetUrl = cfg.remoteUrl + req.originalUrl;
        const headers = {};
        for (const k of Object.keys(req.headers)) {
            if (['host', 'connection', 'content-length'].includes(k.toLowerCase())) continue;
            headers[k] = req.headers[k];
        }
        if (cfg.username && cfg.password) {
            headers['Authorization'] = 'Basic ' + Buffer.from(cfg.username + ':' + cfg.password).toString('base64');
        }
        delete headers['accept-encoding'];
        if (extraHeaders) Object.assign(headers, extraHeaders);

        return fetch(targetUrl, {
            method: req.method,
            headers,
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
            redirect: 'manual',
            compress: true,
            timeout: timeout || 120000  // 120s default — user's remote TW can be slow
        });
    }

    function collectHeaders(upstream) {
        const h = {};
        upstream.headers.forEach((v, k) => {
            const lk = k.toLowerCase();
            if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(lk)) return;
            h[k] = v;
        });
        return h;
    }

    function shouldCache(req, upstream) {
        if (req.method !== 'GET') return false;
        if (upstream.status !== 200) return false;
        // Don't cache the tiddler API (already handled locally — defensive)
        if (req.originalUrl.startsWith('/recipes/')) return false;
        if (req.originalUrl.startsWith('/bags/')) return false;
        if (req.originalUrl.startsWith('/status')) return false;
        if (req.originalUrl.startsWith('/_sync/')) return false;
        return true;
    }

    async function revalidate(req) {
        const key = req.originalUrl;
        if (inflightRevalidations.has(key)) return;
        inflightRevalidations.add(key);
        try {
            const cached = db.cacheGet(key);
            const extraHeaders = {};
            if (cached && cached.etag) extraHeaders['If-None-Match'] = cached.etag;
            if (cached && cached.lastModified) extraHeaders['If-Modified-Since'] = cached.lastModified;

            const upstream = await fetchUpstream(req, extraHeaders);
            if (upstream.status === 304) {
                // Content unchanged, bump updatedAt
                if (cached) {
                    db.cacheSet(key, {
                        status: cached.status,
                        headers: cached.headers,
                        body: cached.body,
                        etag: cached.etag,
                        lastModified: cached.lastModified,
                        updatedAt: Date.now()
                    });
                }
            } else if (upstream.status === 200) {
                const body = await upstream.buffer();
                const headers = collectHeaders(upstream);
                db.cacheSet(key, {
                    status: 200,
                    headers,
                    body,
                    etag: headers.etag || headers.ETag,
                    lastModified: headers['last-modified'] || headers['Last-Modified'],
                    updatedAt: Date.now()
                });
            }
        } catch (e) {
            // Network errors during revalidation are silent
        } finally {
            inflightRevalidations.delete(key);
        }
    }

    // Inject a tiny script just before the <script> that contains $tw.boot.boot()
    // (boot.js). This fires synchronously during TW's boot sequence, after
    // bootprefix.js has set window.$tw but before boot.js creates $tw.syncer.
    //
    // We install an Object.defineProperty setter on $tw.syncer so that the
    // instant TW assigns it ($tw.syncer = new Syncer(...)), we patch
    // storeTiddler to NOT mark fat tiddlers (those with text) as needing
    // lazy-loading. Without this patch, TW's tiddlyweb adaptor unconditionally
    // calls storeTiddler(fields, isSkinny=true), causing 18000+ lazy-load XHRs.
    //
    // Finding the injection point by searching for '$tw.boot.boot()' is robust
    // across all TW server versions regardless of <script> tag attributes.
    function maybeInjectPatch(body, headers) {
        const ct = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
        if (!ct.includes('text/html')) return body;
        let text;
        try { text = body.toString('utf8'); } catch (e) { return body; }

        // Find the <script> block containing $tw.boot.boot() — the boot entry point
        const bootCallIdx = text.indexOf('$tw.boot.boot()');
        if (bootCallIdx < 0) {
            console.warn('[server] maybeInjectPatch: $tw.boot.boot() not found in HTML — patch skipped');
            return body;
        }

        // Walk backwards to find the opening <script tag of that block
        const scriptTagIdx = text.lastIndexOf('<script', bootCallIdx);
        if (scriptTagIdx < 0) return body;

        // Our /tiddlers.json returns FAT tiddlers (with text). TW should never
        // lazy-load those individually.  Three code paths in TW 5.3.x can still
        // trigger individual GETs:
        //
        //   a) storeTiddler(fields, isSkinny=true) with a revision mismatch
        //      → directly enqueues a SyncFromServerTask
        //   b) handleLazyLoadEvent (fired when TW tries to render missing text)
        //      → enqueues a SyncFromServerTask
        //   c) syncFromServer / canSyncFromServer polling loop
        //      → bulk revision compare, queues tasks for every changed tiddler
        //
        // We block all three after $tw.syncer is assigned:
        //   1. storeTiddler patch — fat tiddlers (fields.text != null) are always
        //      treated as non-skinny, so no task is queued on revision mismatch.
        //   2. enqueueTask guard — drop any residual "load-from-server" tasks.
        //   3. handleLazyLoadEvent → no-op (belt-and-suspenders).
        //   4. canSyncFromServer → false (disables the polling path).
        //   5. Kill the polling timer.
        // TW save operations (SaveTiddlerTask) are unaffected.
        // Three code paths in TW 5.3.x trigger individual tiddler GETs:
        //
        //   a) SyncFromServerTask.run() — calls getSkinnyTiddlers(), then for every
        //      tiddler whose revision changed it unconditionally adds the title to
        //      titlesToBeLoaded (syncer.js:682), regardless of whether the incoming
        //      tiddler already had text.  chooseNextTask() then pops from that map
        //      and creates LoadTiddlerTask, which calls syncadaptor.loadTiddler().
        //
        //   b) handleLazyLoadEvent — fired when TW tries to render missing text.
        //
        //   c) The poll timer — triggerTimeout(pollTimerInterval) re-runs
        //      processTaskQueue() periodically.
        //
        // We block all three after $tw.syncer is assigned:
        //   1. storeTiddler patch — fat tiddlers (fields.text != null) always stored
        //      as non-skinny, so no spurious skinny-store on revision mismatch.
        //   2. loadTiddler patch — if we already have text, call back with null
        //      immediately (LoadTiddlerTask skips the XHR when tiddlerFields is null).
        //   3. handleLazyLoadEvent → no-op.
        //   4. canSyncFromServer → false (blocks syncFromServer() from setting
        //      forceSyncFromServer and calling processTaskQueue).
        //   5. pollTimerInterval → huge value so the timestamp condition in
        //      chooseNextTask() never fires (syncer.js:502).
        //   6. Clear the pending task timer (property is taskTimerId, not pollTimerId).
        const script = '<script>(function(){' +
            'if(!window.$tw)return;' +
            'Object.defineProperty($tw,"syncer",{configurable:true,enumerable:true,' +
                'get:function(){return $tw.__syncer__;},' +
                'set:function(v){' +
                    '$tw.__syncer__=v;' +
                    'if(!v)return;' +
                    // 1. storeTiddler: fat tiddlers (with text) are never skinny
                    'if(v.storeTiddler){' +
                        'var _st=v.storeTiddler.bind(v);' +
                        'v.storeTiddler=function(f,skinny){' +
                            'return _st(f,skinny&&!(f&&f.text!=null));' +
                        '};' +
                    '}' +
                    // 2. loadTiddler: skip XHR if we already have text
                    //    LoadTiddlerTask.run() at syncer.js:609 skips storeTiddler
                    //    when tiddlerFields is null, so this is safe.
                    'if(v.syncadaptor&&v.syncadaptor.loadTiddler){' +
                        'var _lt=v.syncadaptor.loadTiddler.bind(v.syncadaptor);' +
                        'v.syncadaptor.loadTiddler=function(title,cb){' +
                            'var t=$tw.wiki&&$tw.wiki.getTiddler(title);' +
                            'if(t&&t.fields&&t.fields.text!==undefined)return cb(null,null);' +
                            'return _lt(title,cb);' +
                        '};' +
                    '}' +
                    // 3. handleLazyLoadEvent → no-op
                    'v.handleLazyLoadEvent=function(){};' +
                    // 4. canSyncFromServer → false (blocks syncFromServer polling path)
                    'v.canSyncFromServer=function(){return false;};' +
                    // 5. pollTimerInterval: huge value so chooseNextTask timestamp
                    //    condition (syncer.js:502) never fires in normal usage.
                    //    NOTE: was wrongly named syncFromServerInterval before.
                    'v.pollTimerInterval=999999999;' +
                    // 6. Clear pending task timer.
                    //    NOTE: TW uses taskTimerId, not pollTimerId.
                    'if(v.taskTimerId){clearTimeout(v.taskTimerId);v.taskTimerId=null;}' +
                    // 7. SSE listener — receive remote-originated deletes
                    //    pushed by sync.js and drop the tiddler from the
                    //    in-memory wiki so the UI updates without a page
                    //    reload. We clear the syncer's tiddlerInfo entry
                    //    BEFORE calling deleteTiddler, so the syncer does
                    //    not enqueue a redundant DELETE back to our local
                    //    server (titleIsSubjectToSyncing returns false
                    //    once tiddlerInfo[title] is gone).
                    'if(typeof EventSource!=="undefined"){' +
                        'try{' +
                            'var _es=new EventSource("/tws-events");' +
                            '_es.addEventListener("delete",function(e){' +
                                'try{' +
                                    'var d=JSON.parse(e.data);' +
                                    'var t=d&&d.title;' +
                                    'if(!t||!$tw.wiki)return;' +
                                    'if(v.tiddlerInfo)delete v.tiddlerInfo[t];' +
                                    '$tw.wiki.deleteTiddler(t);' +
                                    'console.log("[sse] remote deleted",t);' +
                                '}catch(err){console.warn("[sse] delete handler error",err);}' +
                            '});' +
                            '_es.onerror=function(){/* EventSource auto-reconnects */};' +
                        '}catch(err){console.warn("[sse] cannot open channel",err);}' +
                    '}' +
                    'console.log("[patch] lazy-load and sync-from-server disabled");' +
                '}' +
            '});' +
        '})();</script>\n';
        const out = text.slice(0, scriptTagIdx) + script + text.slice(scriptTagIdx);
        return Buffer.from(out, 'utf8');
    }

    function serveFromCache(res, cached) {
        res.status(cached.status);
        const body = maybeInjectPatch(cached.body, cached.headers);
        for (const k of Object.keys(cached.headers)) {
            if (k.toLowerCase() === 'content-length') continue;
            res.set(k, cached.headers[k]);
        }
        res.set('X-TW-Cache', 'HIT');
        res.send(body);
    }

    app.use(async (req, res) => {
        const cfg = config.get();
        if (!cfg.remoteUrl) {
            return res.status(503).send('No remote URL configured');
        }

        // Non-GET: transparent proxy
        if (req.method !== 'GET') {
            try {
                const upstream = await fetchUpstream(req);
                res.status(upstream.status);
                upstream.headers.forEach((v, k) => {
                    const lk = k.toLowerCase();
                    if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(lk)) return;
                    res.set(k, v);
                });
                upstream.body.pipe(res);
            } catch (e) {
                console.error('[proxy] error:', e.message);
                res.status(502).send('Proxy error: ' + e.message);
            }
            return;
        }

        // GET: try cache first
        const cached = db.cacheGet(req.originalUrl);
        const now = Date.now();

        if (cached) {
            // Serve from cache instantly
            serveFromCache(res, cached);
            // If stale, revalidate in background
            if (now - cached.updatedAt > REVALIDATE_AFTER) {
                revalidate(req).catch(() => {});
            }
            return;
        }

        // Not cached: fetch from remote and cache
        try {
            const upstream = await fetchUpstream(req);
            const headers = collectHeaders(upstream);

            if (shouldCache(req, upstream)) {
                const body = await upstream.buffer();
                db.cacheSet(req.originalUrl, {
                    status: upstream.status,
                    headers,
                    body,
                    etag: headers.etag || headers.ETag,
                    lastModified: headers['last-modified'] || headers['Last-Modified'],
                    updatedAt: now
                });
                res.status(upstream.status);
                for (const k of Object.keys(headers)) {
                    if (k.toLowerCase() === 'content-length') continue;
                    res.set(k, headers[k]);
                }
                res.set('X-TW-Cache', 'MISS');
                res.send(maybeInjectPatch(body, headers));
            } else {
                // Not cacheable: just stream through
                res.status(upstream.status);
                for (const k of Object.keys(headers)) res.set(k, headers[k]);
                res.set('X-TW-Cache', 'BYPASS');
                upstream.body.pipe(res);
            }
        } catch (e) {
            console.error('[proxy] error for', req.originalUrl, e.message);
            // Re-check cache as a last resort. If we have ANY cached copy
            // (even stale), serve it rather than showing an error page.
            const fallback = db.cacheGet(req.originalUrl);
            if (fallback) {
                console.log('[proxy] serving stale cache as fallback for', req.originalUrl);
                res.set('X-TW-Cache', 'STALE');
                serveFromCache(res, fallback);
                return;
            }
            res.status(502).send('Proxy error: ' + e.message + '\n\n远程服务器响应过慢或不可达。请检查网络 / 远程服务器状态，或到设置里确认 URL 是否正确。');
        }
    });

    // Error fallback
    app.use((err, req, res, next) => {
        console.error('[server] unhandled error:', err);
        res.status(500).json({ error: err.message });
    });

    return app;
}

async function start() {
    const app = buildApp();
    const port = config.get().localPort || 3000;
    return new Promise((resolve, reject) => {
        server = app.listen(port, '127.0.0.1', () => {
            startedPort = port;
            console.log('[server] listening on http://localhost:' + port);
            resolve(port);
        });
        server.on('error', reject);
    });
}

function stop() {
    return new Promise((resolve) => {
        if (server) {
            server.close(() => resolve());
            server = null;
        } else {
            resolve();
        }
    });
}

// Force-close: don't wait for active connections to finish. Used on quit.
function forceStop() {
    if (server) {
        try { server.closeAllConnections && server.closeAllConnections(); } catch (e) {}
        try { server.close(); } catch (e) {}
        server = null;
    }
}

function getPort() {
    return startedPort;
}

module.exports = { start, stop, forceStop, getPort };
