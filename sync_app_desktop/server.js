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

    // --- Catch-all: proxy to remote ---
    // This handles the HTML skeleton (GET /), plugins, assets, etc.
    app.use(async (req, res) => {
        const cfg = config.get();
        if (!cfg.remoteUrl) {
            return res.status(503).send('No remote URL configured');
        }

        const targetUrl = cfg.remoteUrl + req.originalUrl;
        try {
            const headers = {};
            for (const k of Object.keys(req.headers)) {
                if (['host', 'connection', 'content-length'].includes(k.toLowerCase())) continue;
                headers[k] = req.headers[k];
            }
            if (cfg.username && cfg.password) {
                headers['Authorization'] = 'Basic ' + Buffer.from(cfg.username + ':' + cfg.password).toString('base64');
            }

            // Strip accept-encoding so upstream returns uncompressed body
            // (otherwise we'd have to decompress ourselves before re-serving)
            delete headers['accept-encoding'];

            const upstream = await fetch(targetUrl, {
                method: req.method,
                headers,
                body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
                redirect: 'manual',
                compress: true  // node-fetch decompresses if upstream sends gzip anyway
            });

            // Relay status + headers (strip hop-by-hop and length-related)
            res.status(upstream.status);
            upstream.headers.forEach((v, k) => {
                const lk = k.toLowerCase();
                if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(lk)) return;
                res.set(k, v);
            });

            // Stream body (already decompressed by node-fetch if needed)
            upstream.body.pipe(res);
        } catch (e) {
            console.error('[proxy] error for', targetUrl, e.message);
            res.status(502).send('Proxy error: ' + e.message);
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

function getPort() {
    return startedPort;
}

module.exports = { start, stop, getPort };
