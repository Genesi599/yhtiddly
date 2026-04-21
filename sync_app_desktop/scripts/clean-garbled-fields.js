#!/usr/bin/env node
// clean-garbled-fields.js
//
// One-shot script: scan every tiddler in the local store and remove any
// fields whose name is a pure integer ("0", "1", ..., "14", etc.).
// These are leftover artefacts of a bug where "[object Object]" was
// accidentally spread into a tiddler's field map.
//
// After removing the bogus fields the script:
//   1. Re-writes the .tid file on disk.
//   2. Updates header_json in the SQLite index.
//   3. Sets dirty=1 so the sync engine pushes the cleaned version to the
//      remote TiddlyWiki server on next startup.
//
// Run WHILE THE APP IS STOPPED:
//   node scripts/clean-garbled-fields.js
//
// Progress is printed to stdout; nothing is changed if no garbled fields are
// found.

'use strict';

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

// ── Locate data directory ────────────────────────────────────────────────────

const DATA_DIR     = path.join(process.env.APPDATA, 'tw-sync-desktop');
const DB_PATH      = path.join(DATA_DIR, 'tiddlers.db');
const TIDDLERS_DIR = path.join(DATA_DIR, 'tiddlers');

if (!fs.existsSync(DB_PATH)) {
    console.error('DB not found at', DB_PATH);
    process.exit(1);
}

// ── .tid helpers (inline copy — avoids depending on the app's module path) ───

function serializeFields(fields) {
    const text = fields.text == null ? '' : String(fields.text);
    const quoteTagsField = (tags) => {
        if (!tags) return '';
        if (typeof tags === 'string') return tags;
        if (!Array.isArray(tags)) return String(tags);
        return tags.map(t => (/[\s\[\]]/.test(t) ? '[[' + t + ']]' : t)).join(' ');
    };
    const header = [];
    const keys = Object.keys(fields).filter(k => k !== 'text').sort();
    for (const k of keys) {
        let v = fields[k];
        if (v == null) continue;
        if (Array.isArray(v))          v = quoteTagsField(v);
        else if (typeof v === 'object') v = JSON.stringify(v);
        v = String(v).replace(/\r?\n/g, ' ');
        header.push(k + ': ' + v);
    }
    return header.join('\n') + '\n\n' + text;
}

function parseFields(content) {
    const fields = {};
    const lines  = String(content).split(/\r?\n/);
    const hLine  = /^([a-zA-Z0-9_\-.]+):\s?(.*)$/;
    let i = 0;
    for (; i < lines.length; i++) {
        const line = lines[i];
        if (line === '') { i++; break; }
        const m = line.match(hLine);
        if (!m) break;
        fields[m[1]] = m[2];
    }
    const text = lines.slice(i).join('\n');
    if (text.length > 0) fields.text = text;
    return fields;
}

function isGarbledKey(k) {
    return /^\d+$/.test(k);
}

// ── Open DB ──────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const selectAll    = db.prepare('SELECT title, filename, header_json FROM tiddlers WHERE tombstone = 0');
const updateTiddler = db.prepare(`
    UPDATE tiddlers SET header_json = ?, dirty = 1
    WHERE title = ?
`);

// ── Main loop ────────────────────────────────────────────────────────────────

const rows = selectAll.all();
console.log('Scanning', rows.length, 'tiddlers …');

let fixedFiles = 0;
let fixedDbOnly = 0;
let errors = 0;

const doWork = db.transaction(() => {
    for (const row of rows) {
        let hadGarbled = false;

        // ── 1. Check & clean the .tid file ───────────────────────────────────
        const filepath = path.join(TIDDLERS_DIR, row.filename);
        let fields = null;

        if (fs.existsSync(filepath)) {
            try {
                const raw = fs.readFileSync(filepath, 'utf8');
                fields = parseFields(raw);
            } catch (e) {
                console.error('  read error', row.filename, e.message);
                errors++;
                continue;
            }

            const garbledKeys = Object.keys(fields).filter(isGarbledKey);
            if (garbledKeys.length > 0) {
                hadGarbled = true;
                for (const k of garbledKeys) delete fields[k];

                // Atomic write
                const tmp = filepath + '.clean-' + process.pid;
                try {
                    fs.writeFileSync(tmp, serializeFields(fields), 'utf8');
                    fs.renameSync(tmp, filepath);
                } catch (e) {
                    try { fs.unlinkSync(tmp); } catch (_) {}
                    console.error('  write error', row.filename, e.message);
                    errors++;
                    continue;
                }
                fixedFiles++;
                console.log('  fixed file:', row.filename, '→ removed', garbledKeys.join(', '));
            }
        }

        // ── 2. Check & clean header_json in DB ───────────────────────────────
        let hdr;
        try { hdr = JSON.parse(row.header_json); } catch (_) { hdr = {}; }

        const garbledDbKeys = Object.keys(hdr).filter(isGarbledKey);
        if (garbledDbKeys.length > 0) {
            if (!hadGarbled) {
                // File was clean but DB had garbage — note it
                fixedDbOnly++;
                console.log('  fixed DB: ', row.title, '→ removed', garbledDbKeys.join(', '));
            }
            for (const k of garbledDbKeys) delete hdr[k];
            hadGarbled = true;
        }

        // Use file-derived fields for header_json if available (authoritative)
        if (hadGarbled) {
            const hdrSource = fields || hdr;
            // Build clean header (no text, no garbled keys)
            const cleanHdr = {};
            for (const [k, v] of Object.entries(hdrSource)) {
                if (k !== 'text' && !isGarbledKey(k)) cleanHdr[k] = v;
            }
            updateTiddler.run(JSON.stringify(cleanHdr), row.title);
        }
    }
});

doWork();
db.close();

console.log('\nDone.');
console.log('  .tid files cleaned :', fixedFiles);
console.log('  DB-only rows fixed  :', fixedDbOnly);
console.log('  Errors              :', errors);
if (fixedFiles + fixedDbOnly > 0) {
    console.log('\nAffected tiddlers marked dirty=1 — they will be pushed to the');
    console.log('remote server the next time the sync app runs.');
}
