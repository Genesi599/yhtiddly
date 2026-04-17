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

    // --- List all tiddlers (skinny) ---
    app.get('/recipes/default/tiddlers.json', (req, res) => {
        const list = db.listSkinny();
        res.json(list);
    });

    // --- GET single tiddler (full, with text) ---
    app.get('/recipes/default/tiddlers/:title', (req, res) => {
        const title = decodeURIComponent(req.params.title);
        const t = db.getTiddler(title);
        if (!t) return res.status(404).end();
        // TW expects the fields object with Etag-like revision
        res.set('Etag', '"default/' + encodeURIComponent(title) + '/' + t.revision + ':"');
        res.json(t.fields);
    });

    // --- PUT tiddler (save) ---
    app.put('/recipes/default/tiddlers/:title', (req, res) => {
        const title = decodeURIComponent(req.params.title);
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
            // Some TW versions send {fields:{...}} wrapper, others send flat object
            if (fields.fields && !fields.title) fields = fields.fields;
            if (!fields.title) fields.title = title;

            // Stamp modified if not set
            if (!fields.modified) fields.modified = new Date().toISOString();

            db.putTiddler(fields, 'local');

            // Use any monotonically-increasing number for revision
            const revision = String(Date.now());
            res.set('Etag', '"default/' + encodeURIComponent(title) + '/' + revision + ':"');
            res.status(204).end();
        } catch (e) {
            console.error('[server] PUT error:', e);
            res.status(500).send(e.message);
        }
    });

    // --- DELETE tiddler ---
    app.delete('/bags/default/tiddlers/:title', (req, res) => {
        const title = decodeURIComponent(req.params.title);
        db.deleteTiddler(title, 'local');
        res.status(204).end();
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

    function serveFromCache(res, cached) {
        res.status(cached.status);
        for (const k of Object.keys(cached.headers)) {
            res.set(k, cached.headers[k]);
        }
        res.set('X-TW-Cache', 'HIT');
        res.send(cached.body);
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
                for (const k of Object.keys(headers)) res.set(k, headers[k]);
                res.set('X-TW-Cache', 'MISS');
                res.send(body);
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
