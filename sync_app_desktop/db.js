// db.js — SQLite index over the on-disk tiddler store.
//
// History: v1 stored tiddler content as a JSON blob directly in the DB
// (`fields TEXT`). v2 switches to per-file storage under {tiddlersDir}/ so
// plugins / AI tooling can consume tiddlers as ordinary `.tid` files. The
// DB's role shrinks to "title → filename" plus sync-state metadata.
//
// Columns:
//   title        — PK, the tiddler's identity
//   filename     — relative `.tid` filename inside the tiddlers dir.
//                  Assigned on first write and stable thereafter (never
//                  re-derived, so a title-rename won't orphan the file).
//   header_json  — JSON of all non-text fields. Cached here so that
//                  `listSkinny` (the hottest endpoint) doesn't have to
//                  open and parse thousands of files.
//   revision     — server's revision, used for conflict detection.
//   modified     — ISO timestamp from the tiddler fields.
//   dirty        — 1 when local has unsynced changes.
//   tombstone    — 1 when locally deleted but not yet confirmed with remote.
//   last_synced  — ms epoch of last successful remote ingest.

const Database = require('better-sqlite3');
const fs = require('fs');
const tiddlerStore = require('./tiddlerStore');

let db = null;

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS tiddlers (
    title        TEXT PRIMARY KEY,
    filename     TEXT NOT NULL,
    header_json  TEXT NOT NULL,
    revision     TEXT,
    modified     TEXT,
    dirty        INTEGER NOT NULL DEFAULT 0,
    tombstone    INTEGER NOT NULL DEFAULT 0,
    last_synced  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dirty ON tiddlers(dirty);
CREATE INDEX IF NOT EXISTS idx_tombstone ON tiddlers(tombstone);
CREATE INDEX IF NOT EXISTS idx_filename ON tiddlers(filename);

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

// --- Schema detection / migration ----------------------------------------

function tableInfo(tableName) {
    try {
        return db.prepare(`PRAGMA table_info(${tableName})`).all();
    } catch (e) {
        return [];
    }
}

// Detect whether the DB on disk is v1 (blob `fields` column, no `filename`).
// Returns the list of v1 row objects if a migration is needed, else null.
function detectV1Rows() {
    const info = tableInfo('tiddlers');
    if (info.length === 0) return null;
    const hasFields = info.some(c => c.name === 'fields');
    const hasFilename = info.some(c => c.name === 'filename');
    if (!hasFields || hasFilename) return null;
    return db.prepare('SELECT title, fields, revision, modified, dirty, tombstone, last_synced FROM tiddlers').all();
}

// Migrate v1 → v2 in-place. For each old row: write its `fields` blob to a
// .tid file on disk, then reinsert into the new-shape table. Tombstones
// survive as rows without a file (filename still recorded for consistency;
// any subsequent push or purge handles it).
function migrateV1(rows) {
    console.log('[db] migrating v1 → v2:', rows.length, 'rows');
    db.exec('DROP INDEX IF EXISTS idx_dirty; DROP INDEX IF EXISTS idx_tombstone; DROP TABLE tiddlers;');
    db.exec(SCHEMA_V2);

    const insert = db.prepare(`
        INSERT INTO tiddlers (title, filename, header_json, revision, modified, dirty, tombstone, last_synced)
        VALUES (@title, @filename, @header_json, @revision, @modified, @dirty, @tombstone, @last_synced)
    `);

    const usedFilenames = new Set(); // lower-cased
    const tx = db.transaction((items) => {
        for (const r of items) {
            let fields;
            try { fields = JSON.parse(r.fields); }
            catch (e) { console.warn('[db] migration: bad JSON for', r.title, '- skipping'); continue; }
            if (!fields || !fields.title) fields = Object.assign({}, fields, { title: r.title });

            const filename = tiddlerStore.decideFilename(r.title, usedFilenames);
            usedFilenames.add(filename.toLowerCase());

            if (!r.tombstone) {
                try { tiddlerStore.writeByFilename(filename, fields); }
                catch (e) { console.warn('[db] migration: write failed for', r.title, e.message); }
            }

            const header = Object.assign({}, fields);
            delete header.text;

            insert.run({
                title: r.title,
                filename,
                header_json: JSON.stringify(header),
                revision: r.revision || null,
                modified: r.modified || null,
                dirty: r.dirty ? 1 : 0,
                tombstone: r.tombstone ? 1 : 0,
                last_synced: r.last_synced || null
            });
        }
    });
    tx(rows);
    console.log('[db] migration complete');
}

function init(dbPath, tiddlersDir) {
    // tiddlerStore MUST be initialized before the DB, because a v1→v2
    // migration writes tiddler files to disk mid-init.
    if (!tiddlersDir) throw new Error('init: tiddlersDir required');
    tiddlerStore.init(tiddlersDir);

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    const v1 = detectV1Rows();
    if (v1) {
        migrateV1(v1);
    } else {
        db.exec(SCHEMA_V2);
    }

    console.log('[db] initialized at', dbPath, '(tiddlers dir:', tiddlersDir + ')');
    return db;
}

function getRaw() {
    if (!db) throw new Error('db not initialized');
    return db;
}

// --- Filename bookkeeping -------------------------------------------------

// Set of all currently-used filenames (lower-cased), for collision avoidance.
// We hit this on every new-tiddler write, so cache it in memory and keep
// in sync via updateFilenameCache.
let filenameCacheLC = null;

function ensureFilenameCache() {
    if (filenameCacheLC) return filenameCacheLC;
    filenameCacheLC = new Set();
    for (const r of db.prepare('SELECT filename FROM tiddlers').all()) {
        if (r.filename) filenameCacheLC.add(r.filename.toLowerCase());
    }
    return filenameCacheLC;
}

function filenameForTitle(title) {
    const row = db.prepare('SELECT filename FROM tiddlers WHERE title = ?').get(title);
    return row ? row.filename : null;
}

function assignFilename(title) {
    const set = ensureFilenameCache();
    const fn = tiddlerStore.decideFilename(title, set);
    set.add(fn.toLowerCase());
    return fn;
}

// --- Tiddler CRUD ---------------------------------------------------------

// Returns { revision, fields } or null. Reads `text` from the file on disk
// (the source of truth for content); merges cached header fields for any
// keys the file doesn't carry itself (rare; only an issue for hand-edited
// files that drop fields).
function getTiddler(title) {
    const row = db.prepare('SELECT filename, header_json, revision FROM tiddlers WHERE title = ? AND tombstone = 0').get(title);
    if (!row) return null;
    let fileFields = _fileCache.get(row.filename);
    if (!fileFields) {
        fileFields = tiddlerStore.readByFilename(row.filename) || {};
        if (fileFields && row.filename) _fileCache.set(row.filename, fileFields);
    }
    let header = {};
    try { header = JSON.parse(row.header_json); } catch (e) { /* ignore */ }
    const fields = Object.assign({}, header, fileFields);
    if (!fields.title) fields.title = title;
    return { revision: row.revision || '0', fields };
}

// Skinny list: every non-tombstoned tiddler's fields minus `text`.
// Matches TW's `/tiddlers.json` response shape.
function listSkinny() {
    const rows = db.prepare('SELECT header_json, revision FROM tiddlers WHERE tombstone = 0').all();
    const out = [];
    for (const r of rows) {
        try {
            const fields = JSON.parse(r.header_json);
            // Must include `revision` so TW's syncer can match its local
            // state. Missing revision → syncer considers every tiddler
            // changed → dispatches a load task per tiddler → CPU pegged.
            if (r.revision) fields.revision = String(r.revision);
            out.push(fields);
        } catch (e) { /* skip corrupt row */ }
    }
    return out;
}

// In-memory cache of filename → fields (including text) from the .tid file.
// Populated asynchronously at startup by warmFileCache(), then kept in sync
// by putTiddler/bulkPutRemote/deleteTiddler. Eliminates disk reads for the
// hot path (individual tiddler GET requests during TW's lazy-load phase).
const _fileCache = new Map();

// Fat list: includes text for all non-plugin tiddlers.
// Cached in memory after first build; invalidated by putTiddler/deleteTiddler.
let _fatCache = null;

function invalidateFatCache() { _fatCache = null; }

function listFat() {
    if (_fatCache) return _fatCache;
    const rows = db.prepare('SELECT title, filename, revision FROM tiddlers WHERE tombstone = 0').all();
    const out = [];
    for (const r of rows) {
        let fileFields = _fileCache.get(r.filename) || tiddlerStore.readByFilename(r.filename);
        if (!fileFields) continue;
        if (!_fileCache.has(r.filename)) _fileCache.set(r.filename, fileFields);
        const f = Object.assign({}, fileFields);
        if (!f.title) f.title = r.title;
        if (r.title.startsWith('$:/')) continue;
        if (r.revision) f.revision = String(r.revision);
        out.push(f);
    }
    _fatCache = out;
    return out;
}

// Upsert a tiddler. `source`:
//   'local'  → mark dirty (needs push), bump modified if absent
//   'remote' → clear dirty UNLESS local is already dirty (preserve user's
//              unpushed edits in a last-write-wins with local priority)
function putTiddler(fields, source = 'local', revision = null) {
    if (!fields || !fields.title) throw new Error('putTiddler: missing title');
    invalidateFatCache();
    const title = fields.title;
    const now = Date.now();
    if (!fields.modified) fields.modified = new Date().toISOString();
    const modified = fields.modified;

    // Existing row? Preserve its filename; otherwise allocate a new one.
    const existing = db.prepare('SELECT filename, dirty FROM tiddlers WHERE title = ?').get(title);
    const filename = existing ? existing.filename : assignFilename(title);

    // If a remote write lands on top of local dirty content, KEEP the local
    // file and the local dirty flag. We still update revision/last_synced
    // so the next push knows what server baseline it's racing against.
    const preserveLocal = source === 'remote' && existing && existing.dirty === 1;

    if (!preserveLocal) {
        tiddlerStore.writeByFilename(filename, fields);
        _fileCache.set(filename, Object.assign({}, fields));
    }

    const header = Object.assign({}, fields);
    delete header.text;

    const dirtyNew = source === 'local' ? 1 : (existing && existing.dirty === 1 ? 1 : 0);
    const lastSynced = source === 'remote' ? now : (existing ? null : null);

    db.prepare(`
        INSERT INTO tiddlers (title, filename, header_json, revision, modified, dirty, tombstone, last_synced)
        VALUES (@title, @filename, @header_json, @revision, @modified, @dirty, 0, @last_synced)
        ON CONFLICT(title) DO UPDATE SET
            filename    = CASE WHEN @preserve_local THEN tiddlers.filename ELSE excluded.filename END,
            header_json = CASE WHEN @preserve_local THEN tiddlers.header_json ELSE excluded.header_json END,
            revision    = COALESCE(excluded.revision, tiddlers.revision),
            modified    = CASE WHEN @preserve_local THEN tiddlers.modified ELSE excluded.modified END,
            dirty       = @dirty,
            tombstone   = 0,
            last_synced = CASE WHEN @source = 'remote' THEN @last_synced ELSE tiddlers.last_synced END
    `).run({
        title,
        filename,
        header_json: JSON.stringify(header),
        revision,
        modified,
        dirty: dirtyNew,
        last_synced: lastSynced,
        source,
        preserve_local: preserveLocal ? 1 : 0
    });
}

// Bulk upsert from remote (transaction for speed). Local dirty rows are
// protected: their file is left alone and their dirty flag stays on.
function bulkPutRemote(tiddlers) {
    if (!tiddlers || !tiddlers.length) return;
    invalidateFatCache();
    const now = Date.now();
    const getExisting = db.prepare('SELECT filename, dirty FROM tiddlers WHERE title = ?');
    const upsert = db.prepare(`
        INSERT INTO tiddlers (title, filename, header_json, revision, modified, dirty, tombstone, last_synced)
        VALUES (@title, @filename, @header_json, @revision, @modified, 0, 0, @last_synced)
        ON CONFLICT(title) DO UPDATE SET
            filename    = CASE WHEN tiddlers.dirty = 1 THEN tiddlers.filename ELSE excluded.filename END,
            header_json = CASE WHEN tiddlers.dirty = 1 THEN tiddlers.header_json ELSE excluded.header_json END,
            revision    = excluded.revision,
            modified    = CASE WHEN tiddlers.dirty = 1 THEN tiddlers.modified ELSE excluded.modified END,
            tombstone   = 0,
            last_synced = excluded.last_synced
    `);

    const set = ensureFilenameCache();
    const tx = db.transaction((items) => {
        for (const item of items) {
            if (!item || !item.title) continue;
            const title = item.title;
            const existing = getExisting.get(title);
            const filename = existing ? existing.filename
                : (() => { const fn = tiddlerStore.decideFilename(title, set); set.add(fn.toLowerCase()); return fn; })();

            // Skip file write if local has unpushed changes.
            if (!existing || existing.dirty !== 1) {
                try {
                    tiddlerStore.writeByFilename(filename, item);
                    _fileCache.set(filename, Object.assign({}, item));
                }
                catch (e) { console.warn('[db] bulkPut: write failed for', title, e.message); continue; }
            }

            const header = Object.assign({}, item);
            delete header.text;

            upsert.run({
                title,
                filename,
                header_json: JSON.stringify(header),
                revision: item.revision || '0',
                modified: item.modified || new Date().toISOString(),
                last_synced: now
            });
        }
    });
    tx(tiddlers);
}

// Delete. Local delete → tombstone (kept in index until remote confirms).
// Remote delete → hard purge, unless local has dirty changes (keep user's
// local edit; it'll re-PUT on next sync and recreate the remote tiddler).
function deleteTiddler(title, source = 'local') {
    invalidateFatCache();
    const row = db.prepare('SELECT filename, dirty FROM tiddlers WHERE title = ?').get(title);
    if (!row) return;

    if (source === 'local') {
        db.prepare('UPDATE tiddlers SET tombstone = 1, dirty = 1, modified = ? WHERE title = ?')
            .run(new Date().toISOString(), title);
        tiddlerStore.removeByFilename(row.filename);
        _fileCache.delete(row.filename);
        return;
    }

    // source === 'remote'
    if (row.dirty === 1) {
        // Keep the local version; skip the delete.
        return;
    }
    tiddlerStore.removeByFilename(row.filename);
    _fileCache.delete(row.filename);
    db.prepare('DELETE FROM tiddlers WHERE title = ?').run(title);
    if (filenameCacheLC) filenameCacheLC.delete(row.filename.toLowerCase());
}

// Remove tombstone row after remote confirmed the delete. File is already gone.
function purgeTombstone(title) {
    const row = db.prepare('SELECT filename FROM tiddlers WHERE title = ? AND tombstone = 1').get(title);
    if (!row) return;
    db.prepare('DELETE FROM tiddlers WHERE title = ?').run(title);
    if (filenameCacheLC) filenameCacheLC.delete(row.filename.toLowerCase());
}

// --- Sync helpers ---------------------------------------------------------

// Dirty rows to push. Returns the full fields read from disk (so the PUT
// to remote gets the current text body, not a stale header cache).
function getDirty() {
    const rows = db.prepare('SELECT title, filename, revision, modified, tombstone FROM tiddlers WHERE dirty = 1').all();
    return rows.map(r => {
        let fields = null;
        if (!r.tombstone) {
            fields = tiddlerStore.readByFilename(r.filename);
            if (fields && !fields.title) fields.title = r.title;
        }
        return {
            title: r.title,
            filename: r.filename,
            fields,
            revision: r.revision,
            modified: r.modified,
            tombstone: !!r.tombstone
        };
    });
}

function clearDirty(title, newRevision) {
    if (newRevision) {
        db.prepare('UPDATE tiddlers SET dirty = 0, revision = ?, last_synced = ? WHERE title = ?')
            .run(newRevision, Date.now(), title);
    } else {
        db.prepare('UPDATE tiddlers SET dirty = 0, last_synced = ? WHERE title = ?')
            .run(Date.now(), title);
    }
}

function getAllTitles() {
    return db.prepare('SELECT title FROM tiddlers WHERE tombstone = 0').all().map(r => r.title);
}

function getModifiedMap() {
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

// Lightweight dirty list for UI display — no file reads, index only.
function getDirtyList() {
    return db.prepare(
        'SELECT title, tombstone, modified FROM tiddlers WHERE dirty = 1 ORDER BY modified DESC'
    ).all();
}

// Most-recently-modified tiddlers for the dashboard's "recent" panel.
function getRecentTiddlers(limit = 30) {
    const rows = db.prepare(
        'SELECT header_json FROM tiddlers WHERE tombstone = 0 ORDER BY modified DESC LIMIT ?'
    ).all(limit);
    return rows.map(r => { try { return JSON.parse(r.header_json); } catch (e) { return null; } }).filter(Boolean);
}

// --- Reconcile DB index against on-disk files ----------------------------
//
// Runs once at startup. Catches two cases:
//   1. Someone edited a .tid file by hand between runs → reparse its
//      header into header_json and mark dirty (so next sync pushes it).
//   2. A .tid file on disk has no index row → create one and mark dirty.
//   3. An index row points at a file that no longer exists and isn't a
//      tombstone → leave the row alone (might be intentional; don't
//      second-guess) but log it.
//
// We keep this cheap: stat mtime vs. row modified rather than parsing
// every file unless the mtime actually changed.

function reconcileWithFiles() {
    const fileRows = tiddlerStore.scanAll();
    const byTitle = new Map();
    for (const f of fileRows) byTitle.set(f.fields.title, f);

    const indexRows = db.prepare('SELECT title, filename, header_json, modified, tombstone FROM tiddlers').all();
    const indexByTitle = new Map();
    for (const r of indexRows) indexByTitle.set(r.title, r);

    let added = 0, updated = 0, missing = 0;

    // Files → index
    for (const { filename, fields } of fileRows) {
        const title = fields.title;
        const existing = indexByTitle.get(title);
        if (!existing) {
            // New file appeared (hand-added by user). Register + mark dirty.
            const fn = filename;
            const header = Object.assign({}, fields);
            delete header.text;
            db.prepare(`
                INSERT INTO tiddlers (title, filename, header_json, revision, modified, dirty, tombstone, last_synced)
                VALUES (?, ?, ?, NULL, ?, 1, 0, NULL)
            `).run(title, fn, JSON.stringify(header), fields.modified || new Date().toISOString());
            added++;
        } else if (existing.tombstone !== 1) {
            // Compare modified. If file is newer, refresh header + dirty.
            const fileMod = fields.modified || '';
            if (fileMod && existing.modified && fileMod > existing.modified) {
                const header = Object.assign({}, fields);
                delete header.text;
                db.prepare('UPDATE tiddlers SET header_json = ?, modified = ?, dirty = 1 WHERE title = ?')
                    .run(JSON.stringify(header), fileMod, title);
                updated++;
            }
        }
    }

    // Index rows pointing at files that vanished (and aren't tombstones):
    // log but don't delete. They may be dirty (needing push) — a subsequent
    // push with a null body would wipe remote. Leave for user to resolve.
    for (const r of indexRows) {
        if (r.tombstone) continue;
        if (!byTitle.has(r.title)) missing++;
    }

    if (added || updated || missing) {
        console.log('[db] reconcile: added', added, 'updated', updated, 'missing-file', missing);
    }
    // Refresh cache since we mutated rows.
    filenameCacheLC = null;
    return { added, updated, missing };
}

// --- Meta -----------------------------------------------------------------

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

// --- HTTP response cache -------------------------------------------------

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

// --- Full reset ----------------------------------------------------------
//
// Wipe everything: index rows, http cache, and all .tid files on disk.
// Used by the "清空本地缓存" button in settings. Safer than DROPping the
// DB because we keep the schema intact.

function wipeAll() {
    const rows = db.prepare('SELECT filename FROM tiddlers').all();
    for (const r of rows) {
        if (r.filename) tiddlerStore.removeByFilename(r.filename);
    }
    db.exec('DELETE FROM tiddlers; DELETE FROM meta; DELETE FROM http_cache;');
    filenameCacheLC = null;
    _fileCache.clear();
    _fatCache = null;
}

// Asynchronously read all tiddler files into _fileCache using concurrent
// async I/O. Call this at startup before serving TW so that individual
// tiddler GET requests (TW's lazy-load phase) are served from memory
// instead of disk, reducing per-request latency from ~5ms to ~0.1ms.
async function warmFileCache(progressCb) {
    const rows = db.prepare('SELECT filename FROM tiddlers WHERE tombstone = 0').all();
    const total = rows.length;
    const CONCURRENCY = 64;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
        const batch = rows.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (r) => {
            if (r.filename && !_fileCache.has(r.filename)) {
                const fields = await tiddlerStore.readByFilenameAsync(r.filename);
                if (fields) _fileCache.set(r.filename, fields);
            }
        }));
        if (progressCb) progressCb({ done: Math.min(i + CONCURRENCY, total), total });
    }
}

function close() {
    if (db) { db.close(); db = null; }
}

module.exports = {
    init, getRaw, close,
    getTiddler, listSkinny, listFull: listFat, putTiddler, bulkPutRemote,
    deleteTiddler, purgeTombstone, warmFileCache,
    getDirty, clearDirty, getDirtyList, getRecentTiddlers,
    getAllTitles, getModifiedMap, count, countDirty,
    filenameForTitle,
    reconcileWithFiles,
    setMeta, getMeta,
    cacheGet, cacheSet, cacheClear, cacheStats,
    wipeAll
};
