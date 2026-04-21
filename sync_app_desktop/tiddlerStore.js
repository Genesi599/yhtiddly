// tiddlerStore.js — per-tiddler file-based storage.
//
// Each tiddler is written as a single `.tid` file under {tiddlersDir}/. The
// on-disk format is TW5's native .tid serialization: `key: value` header
// lines, a blank line, then the `text` body. That makes every tiddler
// directly readable by any text editor, by external scripts, and by a
// standalone `tiddlywiki --load` run — which is the whole point of
// switching off the SQLite blob store. Plugins / AI tooling can walk this
// directory without touching the DB.
//
// The SQLite index (see db.js) stores the `title → filename` mapping plus
// sync-state columns. Files are the source of truth for tiddler CONTENT;
// the index is the source of truth for "which filename does this title
// live at" and "is this dirty / tombstoned / what revision".

const fs = require('fs');
const path = require('path');

let tiddlersDir = null;

function init(dir) {
    tiddlersDir = dir;
    fs.mkdirSync(tiddlersDir, { recursive: true });
    return tiddlersDir;
}

function getDir() {
    if (!tiddlersDir) throw new Error('tiddlerStore not initialized');
    return tiddlersDir;
}

// --- Filename mapping -----------------------------------------------------
//
// Derive a safe, deterministic filename from a tiddler title. The mapping
// is intentionally close to TW's own `savewikifolder` convention so that a
// user who points a plain `tiddlywiki` binary at our tiddlers/ folder sees
// familiar filenames. Collisions are rare in practice (different titles
// that normalize to the same stem) but we handle them by appending a short
// hash of the original title.
//
// The index (db.js) is authoritative once a filename has been assigned:
// callers should always prefer the DB's stored filename over a fresh
// derivation when updating an existing tiddler, so we never accidentally
// rename a file just because the slugifier changed.

function titleToStem(title) {
    let s = String(title);
    // TW convention: `$:/foo/bar` → `$__foo_bar`
    if (s.startsWith('$:/')) s = '$__' + s.slice(3);
    // Forward slashes become underscores so hierarchy survives as a flat name.
    s = s.replace(/\//g, '_');
    // Strip characters Windows / macOS / Linux all dislike.
    s = s.replace(/[<>:"\\|?*\x00-\x1f]/g, '_');
    // Windows also rejects trailing dots / spaces.
    s = s.replace(/^[\s.]+|[\s.]+$/g, '');
    // Cap to a reasonable length; the hash suffix on collision still fits.
    if (s.length > 180) s = s.slice(0, 180);
    if (s.length === 0) s = '_';
    return s;
}

function shortHash(str) {
    // djb2, base36, 7 chars. Enough entropy for local dedup; not crypto.
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36).slice(0, 7);
}

// Given a title and the set of already-claimed filenames (lower-cased for
// case-insensitive filesystems), return a new filename that doesn't clash.
function decideFilename(title, existingFilenamesLC) {
    const stem = titleToStem(title);
    let fn = stem + '.tid';
    if (!existingFilenamesLC.has(fn.toLowerCase())) return fn;
    fn = stem + '_' + shortHash(title) + '.tid';
    if (!existingFilenamesLC.has(fn.toLowerCase())) return fn;
    // Last resort — should never happen in practice.
    return stem + '_' + shortHash(title + Date.now()) + '.tid';
}

// --- .tid (de)serialize ---------------------------------------------------

function quoteTagsField(tags) {
    if (!tags) return '';
    if (typeof tags === 'string') return tags;
    if (!Array.isArray(tags)) return String(tags);
    return tags.map(t => (/[\s\[\]]/.test(t) ? '[[' + t + ']]' : t)).join(' ');
}

// Serialize fields to a .tid string. All fields except `text` go in the
// header (one per line, sorted for deterministic output), then blank line,
// then the text body.
function serialize(fields) {
    const text = fields.text == null ? '' : String(fields.text);
    const header = [];
    const keys = Object.keys(fields).filter(k => k !== 'text').sort();
    for (const k of keys) {
        let v = fields[k];
        if (v == null) continue;
        if (Array.isArray(v)) {
            // All array-valued fields (tags, list, or any custom list field) use TW
            // list format: space-separated items, [[brackets]] for items with spaces.
            v = quoteTagsField(v);
        } else if (typeof v === 'object') {
            // Plain objects: JSON-encode to preserve structure rather than coercing
            // to the useless "[object Object]" string.
            v = JSON.stringify(v);
        }
        // Header lines must be single-line. Rare, but guard anyway.
        v = String(v).replace(/\r?\n/g, ' ');
        header.push(k + ': ' + v);
    }
    return header.join('\n') + '\n\n' + text;
}

// Parse a .tid file back into a fields object. Mirrors TW's own parser:
// header is `key: value` lines until the first blank line; everything
// after is `text`. Lines that don't look like fields abort header parsing
// and fall into the body (a defensive posture for hand-edited files).
function parse(content) {
    const fields = {};
    const lines = String(content).split(/\r?\n/);
    const headerLine = /^([a-zA-Z0-9_\-.]+):\s?(.*)$/;
    let i = 0;
    for (; i < lines.length; i++) {
        const line = lines[i];
        if (line === '') { i++; break; }
        const m = line.match(headerLine);
        if (!m) break;
        fields[m[1]] = m[2];
    }
    const text = lines.slice(i).join('\n');
    if (text.length > 0) fields.text = text;
    return fields;
}

// --- File CRUD ------------------------------------------------------------

function readByFilename(filename) {
    if (!filename) return null;
    const fp = path.join(getDir(), filename);
    if (!fs.existsSync(fp)) return null;
    try {
        const content = fs.readFileSync(fp, 'utf8');
        return parse(content);
    } catch (e) {
        console.error('[tiddlerStore] read failed', filename, e.message);
        return null;
    }
}

async function readByFilenameAsync(filename) {
    if (!filename) return null;
    const fp = path.join(getDir(), filename);
    try {
        const content = await fs.promises.readFile(fp, 'utf8');
        return parse(content);
    } catch (e) {
        if (e.code !== 'ENOENT') console.error('[tiddlerStore] async read failed', filename, e.message);
        return null;
    }
}

function writeByFilename(filename, fields) {
    const fp = path.join(getDir(), filename);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    // Atomic-ish: write sibling, rename. Prevents readers seeing a truncated
    // file if the process dies mid-write. `rename` is atomic on same FS.
    const tmp = fp + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, serialize(fields), 'utf8');
    fs.renameSync(tmp, fp);
}

function removeByFilename(filename) {
    if (!filename) return;
    try {
        fs.unlinkSync(path.join(getDir(), filename));
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn('[tiddlerStore] unlink', filename, e.message);
    }
}

// Walk the tiddlers directory and return { filename, fields } for every
// `.tid` file. Used once at startup to reconcile the DB index against
// reality (in case someone hand-edited / added files between runs).
function scanAll() {
    const dir = getDir();
    const out = [];
    let entries;
    try { entries = fs.readdirSync(dir); } catch (e) { return out; }
    for (const entry of entries) {
        if (!entry.endsWith('.tid')) continue;
        const fields = readByFilename(entry);
        if (fields && fields.title) {
            out.push({ filename: entry, fields });
        }
    }
    return out;
}

module.exports = {
    init, getDir,
    titleToStem, decideFilename,
    serialize, parse,
    readByFilename, readByFilenameAsync, writeByFilename, removeByFilename,
    scanAll
};
