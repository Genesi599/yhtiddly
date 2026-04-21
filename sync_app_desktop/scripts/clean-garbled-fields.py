#!/usr/bin/env python3
"""
clean-garbled-fields.py

Scan every tiddler and remove any field whose name is a pure integer
("0", "1", ..., "14", etc.) — artefacts of a bug where the JS string
"[object Object]" was accidentally spread into field maps.

Steps for each affected tiddler:
  1. Rewrite the .tid file on disk (atomic temp-file + rename).
  2. Update header_json in the SQLite index.
  3. Set dirty=1 so the sync app pushes the clean version to the remote.

Run while the app is stopped.
"""

import os
import re
import json
import sqlite3
import sys

# ── Paths ────────────────────────────────────────────────────────────────────

DATA_DIR     = os.path.join(os.environ['APPDATA'], 'tw-sync-desktop')
DB_PATH      = os.path.join(DATA_DIR, 'tiddlers.db')
TIDDLERS_DIR = os.path.join(DATA_DIR, 'tiddlers')

if not os.path.exists(DB_PATH):
    print('ERROR: DB not found at', DB_PATH, file=sys.stderr)
    sys.exit(1)

# ── .tid parse / serialize (mirrors tiddlerStore.js) ─────────────────────────

HEADER_RE = re.compile(r'^([a-zA-Z0-9_\-.]+):\s?(.*)$')
NUMERIC_RE = re.compile(r'^\d+$')


def parse_tid(content: str) -> dict:
    """Parse a .tid file into a fields dict."""
    fields = {}
    lines = content.splitlines(keepends=False)
    i = 0
    while i < len(lines):
        line = lines[i]
        if line == '':
            i += 1
            break
        m = HEADER_RE.match(line)
        if not m:
            break
        fields[m.group(1)] = m.group(2)
        i += 1
    text = '\n'.join(lines[i:])
    if text:
        fields['text'] = text
    return fields


def quote_tags_field(v) -> str:
    """Convert a tags list to TW list format."""
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        parts = []
        for t in v:
            s = str(t)
            if re.search(r'[\s\[\]]', s):
                parts.append('[[' + s + ']]')
            else:
                parts.append(s)
        return ' '.join(parts)
    return str(v)


def serialize_tid(fields: dict) -> str:
    """Serialize fields to a .tid string."""
    text = '' if fields.get('text') is None else str(fields['text'])
    header = []
    for k in sorted(k for k in fields if k != 'text'):
        v = fields[k]
        if v is None:
            continue
        if isinstance(v, list):
            v = quote_tags_field(v)
        elif isinstance(v, dict):
            v = json.dumps(v, ensure_ascii=False)
        v = str(v).replace('\r\n', ' ').replace('\n', ' ').replace('\r', ' ')
        header.append(k + ': ' + v)
    return '\n'.join(header) + '\n\n' + text


def has_garbled_keys(fields: dict) -> bool:
    return any(NUMERIC_RE.match(k) for k in fields)


def remove_garbled_keys(fields: dict) -> dict:
    return {k: v for k, v in fields.items() if not NUMERIC_RE.match(k)}


# ── Main ──────────────────────────────────────────────────────────────────────

con = sqlite3.connect(DB_PATH)
con.execute('PRAGMA journal_mode = WAL')
con.execute('PRAGMA busy_timeout = 5000')

rows = con.execute(
    'SELECT title, filename, header_json FROM tiddlers WHERE tombstone = 0'
).fetchall()

print(f'Scanning {len(rows)} tiddlers …')

fixed_files  = 0
fixed_db     = 0
errors       = 0

with con:   # single transaction — all or nothing
    for title, filename, header_json_str in rows:
        changed = False
        fields = None

        filepath = os.path.join(TIDDLERS_DIR, filename)

        # ── 1. .tid file ─────────────────────────────────────────────────────
        if os.path.exists(filepath):
            try:
                with open(filepath, encoding='utf-8') as f:
                    raw = f.read()
                fields = parse_tid(raw)
            except Exception as e:
                print(f'  read error  {filename}: {e}', file=sys.stderr)
                errors += 1
                continue

            if has_garbled_keys(fields):
                clean = remove_garbled_keys(fields)
                tmp = filepath + '.clean-tmp'
                try:
                    with open(tmp, 'w', encoding='utf-8', newline='') as f:
                        f.write(serialize_tid(clean))
                    os.replace(tmp, filepath)   # atomic on same FS
                    fields = clean
                    fixed_files += 1
                    garbled = [k for k in fields if NUMERIC_RE.match(k)] or \
                              [k for k in parse_tid(raw) if NUMERIC_RE.match(k)]
                    # (recompute from original for the log message)
                    orig_garbled = [k for k in parse_tid(raw) if NUMERIC_RE.match(k)]
                    print(f'  fixed file: {filename} → removed {", ".join(orig_garbled)}')
                    changed = True
                except Exception as e:
                    try: os.unlink(tmp)
                    except: pass
                    print(f'  write error {filename}: {e}', file=sys.stderr)
                    errors += 1
                    continue

        # ── 2. header_json in DB ─────────────────────────────────────────────
        try:
            hdr = json.loads(header_json_str) if header_json_str else {}
        except Exception:
            hdr = {}

        if has_garbled_keys(hdr):
            clean_hdr = remove_garbled_keys(hdr)
            if not changed:
                fixed_db += 1
                garbled_hdr = [k for k in hdr if NUMERIC_RE.match(k)]
                print(f'  fixed DB:   {title!r} → removed {", ".join(garbled_hdr)}')
            hdr = clean_hdr
            changed = True

        if changed:
            # Use file fields for header_json if available; fall back to DB hdr.
            src = fields if fields is not None else hdr
            new_hdr = {k: v for k, v in src.items() if k != 'text' and not NUMERIC_RE.match(k)}
            con.execute(
                'UPDATE tiddlers SET header_json = ?, dirty = 1 WHERE title = ?',
                (json.dumps(new_hdr, ensure_ascii=False), title)
            )

con.close()

print()
print('Done.')
print(f'  .tid files cleaned : {fixed_files}')
print(f'  DB-only rows fixed : {fixed_db}')
print(f'  Errors             : {errors}')
if fixed_files + fixed_db > 0:
    print()
    print('Affected tiddlers marked dirty=1 — they will be pushed to the')
    print('remote server the next time the sync app runs.')
