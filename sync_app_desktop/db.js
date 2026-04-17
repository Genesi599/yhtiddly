// db.js - SQLite wrapper for tiddler storage

const Database = require('better-sqlite3');
const path = require('path');

let db = null;

// Each tiddler is stored as a row.
// `fields` is a JSON blob of ALL fields (including title, text, tags, type, etc.).
// `dirty` = 1 when local changes haven't been pushed to remote yet.
// `tombstone` = 1 for tiddlers deleted locally but not yet pushed.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tiddlers (
    title        TEXT PRIMARY KEY,
    fields       TEXT NOT NULL,
    revision     TEXT,
    modified     TEXT,
    dirty        INTEGER NOT NULL DEFAULT 0,
    tombstone    INTEGER NOT NULL DEFAULT 0,
    last_synced  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dirty ON tiddlers(dirty);
CREATE INDEX IF NOT EXISTS idx_tombstone ON tiddlers(tombstone);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS http_cache (
    url           TEXT PRIMARY KEY,
    status        INTEGER NOT NULL,
    headers       TEXT NOT NULL,
    body          BLOB NOT NULL,
    etag          TEXT,
    last_modified TEXT,
    updated_at    INTEGER NOT NULL
);
`;

function init(dbPath) {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(SCHEMA);
    console.log('[db] initialized at', dbPath);
    return db;
}

function getRaw() {
    if (!db) throw new Error('db not initialized');
    return db;
}

// --- CRUD ---

// Get one tiddler including full text. Returns {revision, fields} or null.
function getTiddler(title) {
    const row = db.prepare('SELECT fields, revision FROM tiddlers WHERE title = ? AND tombstone = 0').get(title);
    if (!row) return null;
    return {
        revision: row.revision || '0',
        fields: JSON.parse(row.fields)
    };
}

// Get all tiddlers as skinny list (no text field). Matches TW's tiddlers.json response.
function listSkinny() {
    const rows = db.prepare('SELECT fields FROM tiddlers WHERE tombstone = 0').all();
    return rows.map(r => {
        const fields = JSON.parse(r.fields);
        delete fields.text;
        return fields;
    });
}

// Get all tiddlers as FULL list (with text). Used for bulk export.
function listFull() {
    const rows = db.prepare('SELECT fields FROM tiddlers WHERE tombstone = 0').all();
    return rows.map(r => JSON.parse(r.fields));
}

// Upsert a tiddler. `source` tells us whether change came from browser (local)
// or from remote sync. Local changes get dirty=1, remote changes get dirty=0.
function putTiddler(fields, source = 'local', revision = null) {
    if (!fields || !fields.title) throw new Error('putTiddler: missing title');

    const title = fields.title;
    const modified = fields.modified || new Date().toISOString();
    const dirty = source === 'local' ? 1 : 0;
    const now = Date.now();

    const stmt = db.prepare(`
        INSERT INTO tiddlers (title, fields, revision, modified, dirty, tombstone, last_synced)
        VALUES (@title, @fields, @revision, @modified, @dirty, 0, @last_synced)
        ON CONFLICT(title) DO UPDATE SET
            fields       = excluded.fields,
            revision     = COALESCE(excluded.revision, tiddlers.revision),
            modified     = excluded.modified,
            dirty        = CASE
                              WHEN @source = 'local' THEN 1
                              WHEN @source = 'remote' AND tiddlers.dirty = 1 THEN 1
                              ELSE 0
                           END,
            tombstone    = 0,
            last_synced  = CASE WHEN @source = 'remote' THEN @last_synced ELSE tiddlers.last_synced END
    `);

    stmt.run({
        title,
        fields: JSON.stringify(fields),
        revision: revision,
        modified,
        dirty,
        last_synced: source === 'remote' ? now : null,
        source
    });
}

// Bulk upsert from remote (in transaction for speed).
function bulkPutRemote(tiddlers) {
    const insert = db.prepare(`
        INSERT INTO tiddlers (title, fields, revision, modified, dirty, tombstone, last_synced)
        VALUES (@title, @fields, @revision, @modified, 0, 0, @last_synced)
        ON CONFLICT(title) DO UPDATE SET
            fields       = excluded.fields,
            revision     = excluded.revision,
            modified     = excluded.modified,
            tombstone    = 0,
            last_synced  = excluded.last_synced
        WHERE tiddlers.dirty = 0
    `);
    const now = Date.now();
    const tx = db.transaction((items) => {
        for (const item of items) {
            if (!item || !item.title) continue;
            insert.run({
                title: item.title,
                fields: JSON.stringify(item),
                revision: item.revision || '0',
                modified: item.modified || new Date().toISOString(),
                last_synced: now
            });
        }
    });
    tx(tiddlers);
}

// Delete tiddler. Local deletes create tombstone; remote deletes purge directly.
function deleteTiddler(title, source = 'local') {
    if (source === 'local') {
        db.prepare(`
            UPDATE tiddlers SET tombstone = 1, dirty = 1, modified = ?
            WHERE title = ?
        `).run(new Date().toISOString(), title);
    } else {
        db.prepare('DELETE FROM tiddlers WHERE title = ?').run(title);
    }
}

// Remove tombstone permanently (after remote confirmed delete).
function purgeTombstone(title) {
    db.prepare('DELETE FROM tiddlers WHERE title = ? AND tombstone = 1').run(title);
}

// --- Sync helpers ---

function getDirty() {
    return db.prepare(`
        SELECT title, fields, revision, modified, tombstone FROM tiddlers WHERE dirty = 1
    `).all().map(r => ({
        title: r.title,
        fields: JSON.parse(r.fields),
        revision: r.revision,
        modified: r.modified,
        tombstone: !!r.tombstone
    }));
}

function clearDirty(title, newRevision) {
    if (newRevision) {
        db.prepare('UPDATE tiddlers SET dirty = 0, revision = ? WHERE title = ?').run(newRevision, title);
    } else {
        db.prepare('UPDATE tiddlers SET dirty = 0 WHERE title = ?').run(title);
    }
}

function getAllTitles() {
    return db.prepare('SELECT title FROM tiddlers WHERE tombstone = 0').all().map(r => r.title);
}

function getModifiedMap() {
    // Return {title: modified} for all non-tombstoned tiddlers
    const rows = db.prepare('SELECT title, modified, revision FROM tiddlers WHERE tombstone = 0').all();
    const map = {};
    for (const r of rows) map[r.title] = { modified: r.modified, revision: r.revision };
    return map;
}

function count() {
    return db.prepare('SELECT COUNT(*) AS c FROM tiddlers WHERE tombstone = 0').get().c;
}

function countDirty() {
    return db.prepare('SELECT COUNT(*) AS c FROM tiddlers WHERE dirty = 1').get().c;
}

// --- Meta ---

function setMeta(key, value) {
    db.prepare(`
        INSERT INTO meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
}

function getMeta(key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
}

// --- HTTP response cache (for proxied HTML/JS/CSS) ---

function cacheGet(url) {
    const row = db.prepare('SELECT status, headers, body, etag, last_modified, updated_at FROM http_cache WHERE url = ?').get(url);
    if (!row) return null;
    return {
        status: row.status,
        headers: JSON.parse(row.headers),
        body: row.body,
        etag: row.etag,
        lastModified: row.last_modified,
        updatedAt: row.updated_at
    };
}

function cacheSet(url, entry) {
    db.prepare(`
        INSERT INTO http_cache (url, status, headers, body, etag, last_modified, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET
            status        = excluded.status,
            headers       = excluded.headers,
            body          = excluded.body,
            etag          = excluded.etag,
            last_modified = excluded.last_modified,
            updated_at    = excluded.updated_at
    `).run(
        url,
        entry.status,
        JSON.stringify(entry.headers || {}),
        entry.body,
        entry.etag || null,
        entry.lastModified || null,
        entry.updatedAt || Date.now()
    );
}

function cacheClear() {
    db.prepare('DELETE FROM http_cache').run();
}

function cacheStats() {
    const row = db.prepare('SELECT COUNT(*) AS c, SUM(LENGTH(body)) AS bytes FROM http_cache').get();
    return { entries: row.c, bytes: row.bytes || 0 };
}

function close() {
    if (db) {
        db.close();
        db = null;
    }
}

module.exports = {
    init, getRaw, close,
    getTiddler, listSkinny, listFull, putTiddler, bulkPutRemote,
    deleteTiddler, purgeTombstone,
    getDirty, clearDirty, getAllTitles, getModifiedMap, count, countDirty,
    setMeta, getMeta,
    cacheGet, cacheSet, cacheClear, cacheStats
};
