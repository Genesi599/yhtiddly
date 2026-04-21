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
    text_cache   TEXT,
    revision     TEXT,
    modified     TEXT,
    dirty        INTEGER NOT NULL DEFAULT 0,
    tombstone    INTEGER NOT NULL DEFAULT 0,
    last_synced  INTEGER,
    file_mtime   INTEGER
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

    // Add columns introduced after the initial schema (idempotent ALTER TABLE).
    for (const sql of [
        'ALTER TABLE tiddlers ADD COLUMN text_cache TEXT',
        'ALTER TABLE tiddlers ADD COLUMN file_mtime INTEGER',
    ]) {
        try { db.exec(sql); } catch (e) { /* column already exists — ignore */ }
    }

    // One-time cleanup: clear dirty=1 on any draft tiddlers that may have been
    // incorrectly marked by reconcileWithFiles or earlier code paths. Drafts are
    // local editor state and must never be pushed, so dirty=1 is meaningless.
    const cleared = db.prepare(
        "UPDATE tiddlers SET dirty = 0 WHERE dirty = 1 AND header_json LIKE '%\"draft.of\"%'"
    ).run().changes;
    if (cleared) console.log('[db] cleared dirty flag on', cleared, 'draft tiddler(s)');

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

// Parse TW modified timestamp to epoch ms. Handles TW compact format
// ("20240101120000000") and ISO 8601 ("2024-01-01T12:00:00.000Z").
function parseModified(s) {
    if (!s) return 0;
    const str = String(s);
    const m = str.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})?$/);
    if (m) return Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6], +(m[7]||0));
    const t = Date.parse(str);
    return isNaN(t) ? 0 : t;
}

// Titles that are never pushed to the remote server. These are UI-state
// tiddlers that change constantly and have no value outside the current session.
const NOSYNC_TITLES = new Set([
    '$:/StoryList',
]);

// TiddlyWiki draft tiddlers are local-only editor state and should never be
// synced to the remote server. TW5 marks them with a `draft.of` field AND
// uses a title generated by core/language/en-*/Draft.multids of the form
// `Draft of '<title>'` (or `Draft <N> of '<title>'`, or a localized variant).
// Match on EITHER condition — the title pattern catches orphan rows where the
// `draft.of` field got lost in a malformed save (seen in the wild), and the
// field catches non-English locales where the title template differs.
const DRAFT_TITLE_RE = /^Draft(\s+\d+)?\s+of\s+['"]/;
function isDraft(fields) {
    if (!fields) return false;
    if (fields['draft.of']) return true;
    if (fields.title && DRAFT_TITLE_RE.test(String(fields.title))) return true;
    return false;
}

// Defence-in-depth: clean any tiddler fields object before it is persisted.
// Handles four classes of garbage that can arrive from the remote server:
//   1. Nested `fields` sub-object (TiddlyWeb hybrid format). We merge its
//      entries up to the top level WITHOUT overwriting existing keys (top
//      level is authoritative), then drop the sub-object.
//   2. Numeric-index keys ("0", "1", …) left behind when a plain object was
//      accidentally spread into a field map (e.g. `[object Object]` chars).
//      Tiddler field names cannot legally start with a digit.
//   3. Server-only meta keys (`bag`, `revision`) that are tracked in their
//      own columns, not in the tiddler body.
//   4. Non-string field values (arrays, plain objects). TW5's wire format
//      always uses strings; arrays are TW list format (space-separated,
//      [[brackets]] for items with spaces), objects become JSON strings.
// Returns a new object — does not mutate its input.
function normalizeFields(raw) {
    if (!raw || typeof raw !== 'object') return raw;
    const out = {};
    // Copy top-level entries first (these win).
    for (const k of Object.keys(raw)) {
        if (k === 'fields' || k === 'bag' || k === 'revision') continue;
        if (/^\d+$/.test(k)) continue;
        out[k] = raw[k];
    }
    // Merge nested sub-object, non-destructively.
    const nested = raw.fields;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        for (const k of Object.keys(nested)) {
            if (/^\d+$/.test(k)) continue;
            if (!(k in out)) out[k] = nested[k];
        }
    }
    // Coerce non-string values to TW5 wire format.
    for (const k of Object.keys(out)) {
        const v = out[k];
        if (v == null) continue;
        if (Array.isArray(v)) {
            out[k] = v.map(t => (/[\s\[\]]/.test(String(t)) ? '[[' + t + ']]' : String(t))).join(' ');
        } else if (typeof v === 'object') {
            out[k] = JSON.stringify(v);
        }
    }
    return out;
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
    // Sanitize: strip any nested `fields`, numeric-garbage keys, and server
    // meta that may have been written by older code paths.
    header = normalizeFields(header);
    fileFields = normalizeFields(fileFields);
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
            const fields = normalizeFields(JSON.parse(r.header_json));
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
        const f = normalizeFields(fileFields);
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
    fields = normalizeFields(fields);
    if (!fields.title) throw new Error('putTiddler: missing title after normalization');
    invalidateFatCache();
    const title = fields.title;
    const now = Date.now();
    if (!fields.modified) fields.modified = new Date().toISOString();
    const modified = fields.modified;

    // Existing row? Preserve its filename; otherwise allocate a new one.
    const existing = db.prepare('SELECT filename, dirty, revision FROM tiddlers WHERE title = ?').get(title);
    const filename = existing ? existing.filename : assignFilename(title);

    // Per-tiddler monotonic revision. For local writes, bump whatever the row
    // previously had — that's what TW5's reference server does via
    // `getChangeCount()` (see core-server/server/routes/put-tiddler.js). We
    // need the skinny-list `revision` to match the Etag we handed TW on the
    // PUT response, otherwise the syncer thinks the tiddler has drifted on
    // the server and queues a spurious re-load the moment the user saves.
    if (source === 'local') {
        const prev = existing && existing.revision ? parseInt(existing.revision, 10) : 0;
        revision = String(Number.isFinite(prev) ? prev + 1 : 1);
    }

    // Conflict resolution: remote write vs local dirty changes → newer modified wins.
    // If timestamps are equal, local wins (avoids stomping an in-progress edit).
    const preserveLocal = source === 'remote' && existing && existing.dirty === 1
        && parseModified(existing.modified) >= parseModified(fields.modified);

    let fileMtime = null;
    let textCache = null;
    if (!preserveLocal) {
        tiddlerStore.writeByFilename(filename, fields);
        const normalized = tiddlerStore.parse(tiddlerStore.serialize(fields));
        _fileCache.set(filename, normalized);
        fileMtime = tiddlerStore.getMtime(filename);
        textCache = normalized.text != null ? String(normalized.text) : null;
    }

    const header = Object.assign({}, fields);
    delete header.text;

    // Drafts are always clean: they're local editor state and are never pushed.
    // When remote wins the conflict (preserveLocal=false), clear dirty so the
    // overridden local change is not pushed back to the server on next sync.
    const dirtyNew = isDraft(fields) ? 0
        : (source === 'local' && !NOSYNC_TITLES.has(title)) ? 1
        : preserveLocal ? 1
        : 0;
    const lastSynced = source === 'remote' ? now : (existing ? null : null);

    db.prepare(`
        INSERT INTO tiddlers (title, filename, header_json, text_cache, revision, modified, dirty, tombstone, last_synced, file_mtime)
        VALUES (@title, @filename, @header_json, @text_cache, @revision, @modified, @dirty, 0, @last_synced, @file_mtime)
        ON CONFLICT(title) DO UPDATE SET
            filename    = CASE WHEN @preserve_local THEN tiddlers.filename    ELSE excluded.filename    END,
            header_json = CASE WHEN @preserve_local THEN tiddlers.header_json ELSE excluded.header_json END,
            text_cache  = CASE WHEN @preserve_local THEN tiddlers.text_cache  ELSE excluded.text_cache  END,
            revision    = COALESCE(excluded.revision, tiddlers.revision),
            modified    = CASE WHEN @preserve_local THEN tiddlers.modified    ELSE excluded.modified    END,
            dirty       = @dirty,
            tombstone   = 0,
            last_synced = CASE WHEN @source = 'remote' THEN @last_synced ELSE tiddlers.last_synced END,
            file_mtime  = CASE WHEN @preserve_local THEN tiddlers.file_mtime  ELSE excluded.file_mtime  END
    `).run({
        title,
        filename,
        header_json: JSON.stringify(header),
        text_cache: textCache,
        revision,
        modified,
        dirty: dirtyNew,
        last_synced: lastSynced,
        file_mtime: fileMtime,
        source,
        preserve_local: preserveLocal ? 1 : 0
    });

    // Return the revision so server.js can stamp it on the PUT Etag.
    return revision;
}

// Bulk upsert from remote (transaction for speed). Local dirty rows are
// protected: their file is left alone and their dirty flag stays on.
function bulkPutRemote(tiddlers) {
    if (!tiddlers || !tiddlers.length) return;
    invalidateFatCache();
    const now = Date.now();
    const getExisting = db.prepare('SELECT filename, dirty FROM tiddlers WHERE title = ?');
    const upsert = db.prepare(`
        INSERT INTO tiddlers (title, filename, header_json, text_cache, revision, modified, dirty, tombstone, last_synced, file_mtime)
        VALUES (@title, @filename, @header_json, @text_cache, @revision, @modified, 0, 0, @last_synced, @file_mtime)
        ON CONFLICT(title) DO UPDATE SET
            filename    = CASE WHEN tiddlers.dirty = 1 THEN tiddlers.filename    ELSE excluded.filename    END,
            header_json = CASE WHEN tiddlers.dirty = 1 THEN tiddlers.header_json ELSE excluded.header_json END,
            text_cache  = CASE WHEN tiddlers.dirty = 1 THEN tiddlers.text_cache  ELSE excluded.text_cache  END,
            revision    = excluded.revision,
            modified    = CASE WHEN tiddlers.dirty = 1 THEN tiddlers.modified    ELSE excluded.modified    END,
            tombstone   = 0,
            last_synced = excluded.last_synced,
            file_mtime  = CASE WHEN tiddlers.dirty = 1 THEN tiddlers.file_mtime  ELSE excluded.file_mtime  END
    `);

    const set = ensureFilenameCache();
    const tx = db.transaction((items) => {
        for (let item of items) {
            if (!item || !item.title) continue;
            item = normalizeFields(item);
            if (!item || !item.title) continue;
            const title = item.title;
            const existing = getExisting.get(title);
            const filename = existing ? existing.filename
                : (() => { const fn = tiddlerStore.decideFilename(title, set); set.add(fn.toLowerCase()); return fn; })();

            let fileMtime = null;
            let textCache = null;
            if (!existing || existing.dirty !== 1) {
                try {
                    tiddlerStore.writeByFilename(filename, item);
                    const normalized = tiddlerStore.parse(tiddlerStore.serialize(item));
                    _fileCache.set(filename, normalized);
                    fileMtime = tiddlerStore.getMtime(filename);
                    textCache = normalized.text != null ? String(normalized.text) : null;
                }
                catch (e) { console.warn('[db] bulkPut: write failed for', title, e.message); continue; }
            }

            const header = Object.assign({}, item);
            delete header.text;

            upsert.run({
                title,
                filename,
                header_json: JSON.stringify(header),
                text_cache: textCache,
                revision: item.revision || '0',
                modified: item.modified || new Date().toISOString(),
                last_synced: now,
                file_mtime: fileMtime
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
// Drafts are never pushed (they're local editor state). Rows whose `.tid`
// file is missing are also filtered — we have nothing meaningful to push
// and the previous behaviour would loop forever on a malformed row.
function getDirty() {
    const rows = db.prepare(
        'SELECT title, filename, revision, modified, tombstone FROM tiddlers WHERE dirty = 1 AND ' + NOT_DRAFT_SQL
    ).all();
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

// SQL fragment that filters out draft tiddlers from the dirty queue. Matches
// isDraft(): either the `draft.of` field is set, OR the title follows the
// `Draft of '<x>'` / `Draft <N> of '<x>'` pattern used by TW5's draft title
// generator. Using GLOB because SQLite has no regex without an extension; the
// patterns cover both single- and double-quote title wrappers.
const NOT_DRAFT_SQL =
    "header_json NOT LIKE '%\"draft.of\"%' " +
    "AND title NOT GLOB 'Draft of ''*' " +
    "AND title NOT GLOB 'Draft of \"*' " +
    "AND title NOT GLOB 'Draft [0-9]* of ''*' " +
    "AND title NOT GLOB 'Draft [0-9]* of \"*'";

function countDirty() {
    return db.prepare(
        "SELECT COUNT(*) AS c FROM tiddlers WHERE dirty = 1 AND " + NOT_DRAFT_SQL
    ).get().c;
}

// Lightweight dirty list for UI display — no file reads, index only.
// Excludes draft tiddlers: they're local editor state and are never pushed.
function getDirtyList() {
    return db.prepare(
        "SELECT title, tombstone, modified FROM tiddlers WHERE dirty = 1 AND " +
        NOT_DRAFT_SQL + " ORDER BY modified DESC"
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
// Runs once at startup. Uses file mtime to skip unchanged files — only reads
// content when mtime differs from the stored file_mtime, or when text_cache
// is absent (first run after schema upgrade). Unchanged files are loaded
// straight from DB (header_json + text_cache) into _fileCache, making
// warmFileCache essentially a no-op for steady-state startups.
//
// Detects:
//   1. Hand-edited .tid files (mtime changed + modified field newer) → mark dirty
//   2. New .tid files with no index row → insert, mark dirty
//   3. Index rows whose file vanished → log but don't delete

function reconcileWithFiles() {
    const onDisk = new Set(tiddlerStore.listFilenames());

    const indexRows = db.prepare(
        'SELECT title, filename, header_json, text_cache, modified, file_mtime, dirty, tombstone FROM tiddlers'
    ).all();
    const indexByFilename = new Map();
    const indexByTitle = new Map();
    for (const r of indexRows) {
        indexByFilename.set(r.filename, r);
        indexByTitle.set(r.title, r);
    }

    let added = 0, updated = 0, missing = 0;

    // --- Each indexed tiddler vs its on-disk file ---
    for (const r of indexRows) {
        if (r.tombstone) continue;
        if (!onDisk.has(r.filename)) { missing++; continue; }

        const mtime = tiddlerStore.getMtime(r.filename);

        if (mtime !== null && mtime === r.file_mtime && r.text_cache !== null) {
            // File unchanged: reconstruct fields from DB cache — no disk read.
            let header = {};
            try { header = normalizeFields(JSON.parse(r.header_json)); } catch (e) {}
            const fields = Object.assign({}, header);
            if (r.text_cache) fields.text = r.text_cache;
            _fileCache.set(r.filename, fields);
        } else {
            // File changed or no recorded mtime: read from disk.
            const fields = tiddlerStore.readByFilename(r.filename);
            if (!fields) { missing++; continue; }
            if (!fields.title) fields.title = r.title;
            _fileCache.set(r.filename, fields);

            const header = Object.assign({}, fields);
            delete header.text;
            const fileMod = fields.modified || '';
            const markDirty = r.dirty === 0 && fileMod && r.modified && fileMod > r.modified;

            if (markDirty) {
                db.prepare(`UPDATE tiddlers
                    SET header_json = ?, text_cache = ?, file_mtime = ?, modified = ?, dirty = 1
                    WHERE title = ?`
                ).run(JSON.stringify(header), fields.text != null ? String(fields.text) : null,
                      mtime, fileMod, r.title);
                updated++;
            } else {
                db.prepare(`UPDATE tiddlers SET header_json = ?, text_cache = ?, file_mtime = ? WHERE title = ?`)
                    .run(JSON.stringify(header), fields.text != null ? String(fields.text) : null, mtime, r.title);
            }
        }
    }

    // --- Files on disk not yet indexed → insert as new ---
    for (const filename of onDisk) {
        if (indexByFilename.has(filename)) continue;
        const fields = tiddlerStore.readByFilename(filename);
        if (!fields || !fields.title) continue;
        if (indexByTitle.has(fields.title)) continue; // title already indexed under different filename
        _fileCache.set(filename, fields);
        const mtime = tiddlerStore.getMtime(filename);
        const header = Object.assign({}, fields);
        delete header.text;
        ensureFilenameCache().add(filename.toLowerCase());
        db.prepare(`
            INSERT INTO tiddlers (title, filename, header_json, text_cache, revision, modified, dirty, tombstone, file_mtime, last_synced)
            VALUES (?, ?, ?, ?, NULL, ?, 1, 0, ?, NULL)
        `).run(fields.title, filename, JSON.stringify(header),
               fields.text != null ? String(fields.text) : null,
               fields.modified || new Date().toISOString(), mtime);
        added++;
    }

    if (added || updated || missing) {
        console.log('[db] reconcile: added', added, 'updated', updated, 'missing-file', missing);
    }
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
    // Skip files already populated by reconcileWithFiles() — they were just
    // read from disk and parsed, so reading them again would be pure waste.
    const uncached = rows.filter(r => r.filename && !_fileCache.has(r.filename));
    const total = rows.length;
    let done = rows.length - uncached.length; // pre-filled count
    const CONCURRENCY = 64;
    for (let i = 0; i < uncached.length; i += CONCURRENCY) {
        const batch = uncached.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (r) => {
            const fields = await tiddlerStore.readByFilenameAsync(r.filename);
            if (fields) _fileCache.set(r.filename, fields);
        }));
        done = Math.min(rows.length - uncached.length + i + CONCURRENCY, total);
        if (progressCb) progressCb({ done, total });
    }
    if (progressCb && uncached.length === 0) progressCb({ done: total, total });
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
    filenameForTitle, isDraft,
    reconcileWithFiles,
    setMeta, getMeta,
    cacheGet, cacheSet, cacheClear, cacheStats,
    wipeAll
};
