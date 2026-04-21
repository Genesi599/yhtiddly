#!/usr/bin/env python3
"""
fix-incomplete-tiddlers.py

Find local tiddlers whose .tid files are missing key fields that the
remote has (text, tags, type, created, etc.).  This can happen when
a garbled PUT overwrote the server record and TWSync stored only the
minimal (garbled) version locally.

For each such tiddler:
  1. Fetch the full tiddler from the remote server.
  2. Merge top-level fields AND any nested `fields` sub-object from the
     remote response.
  3. Keep locally-recovered custom fields (linkstyle, color …) that are
     already in the local .tid if they aren't on the remote top-level.
  4. Write the merged result back to the .tid file.
  5. Update header_json in SQLite and mark dirty=1 so the clean version
     gets pushed to the remote on next sync.

Run while the sync app is STOPPED.
"""

import json, os, re, sqlite3, sys, time, urllib.request, urllib.parse, urllib.error

sys.stdout.reconfigure(encoding='utf-8')

REMOTE       = 'https://yhtiddly.fun'
DATA_DIR     = os.path.join(os.environ['APPDATA'], 'tw-sync-desktop')
DB_PATH      = os.path.join(DATA_DIR, 'tiddlers.db')
TIDDLERS_DIR = os.path.join(DATA_DIR, 'tiddlers')
NUMERIC_RE   = re.compile(r'^\d+$')
HEADER_RE    = re.compile(r'^([a-zA-Z0-9_\-.]+):\s?(.*)$')

# Standard fields that SHOULD come from the remote (not invented locally).
# If ANY of these is absent from the local .tid, the tiddler is "incomplete".
REQUIRED_REMOTE_FIELDS = {'text', 'type', 'created', 'tags'}


def parse_tid(content):
    fields = {}
    lines  = content.splitlines(keepends=False)
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


def quote_tags(v):
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return ' '.join(
            '[[' + t + ']]' if re.search(r'[\s\[\]]', t) else t for t in v)
    return str(v)


def serialize_tid(fields):
    text   = '' if fields.get('text') is None else str(fields['text'])
    header = []
    for k in sorted(k for k in fields if k != 'text'):
        v = fields[k]
        if v is None:
            continue
        if isinstance(v, list):
            v = quote_tags(v)
        elif isinstance(v, dict):
            v = json.dumps(v, ensure_ascii=False)
        v = str(v).replace('\r\n', ' ').replace('\n', ' ').replace('\r', ' ')
        header.append(k + ': ' + v)
    return '\n'.join(header) + '\n\n' + text


def fetch_remote(title):
    url = REMOTE + '/recipes/default/tiddlers/' + urllib.parse.quote(title, safe='')
    req = urllib.request.Request(url, headers={'Accept': 'application/json'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except Exception as e:
            if attempt == 2:
                raise
            time.sleep(1 * (attempt + 1))


def normalize_remote(data):
    """
    Build a clean fields dict from the remote API response.
    Handles both flat format and the TiddlyWeb hybrid where custom fields
    sit in a nested `fields` sub-object.
    Strips numeric-index garbage keys everywhere.
    """
    SKIP = {'bag', 'revision', 'fields'}
    fields = {k: v for k, v in data.items()
              if k not in SKIP and not NUMERIC_RE.match(k)}
    # Merge nested custom fields (e.g. linkstyle, color)
    nested = data.get('fields')
    if isinstance(nested, dict):
        for k, v in nested.items():
            if not NUMERIC_RE.match(k) and k not in fields:
                fields[k] = v
    return fields


# ── Main ──────────────────────────────────────────────────────────────────────

if not os.path.exists(DB_PATH):
    print('ERROR: DB not found at', DB_PATH)
    sys.exit(1)

con = sqlite3.connect(DB_PATH)
con.execute('PRAGMA journal_mode = WAL')
con.execute('PRAGMA busy_timeout = 5000')

rows = con.execute(
    'SELECT title, filename FROM tiddlers WHERE tombstone = 0'
).fetchall()

print(f'Scanning {len(rows)} tiddlers for missing remote fields …')

to_fix = []
for title, filename in rows:
    filepath = os.path.join(TIDDLERS_DIR, filename)
    if not os.path.exists(filepath):
        continue
    try:
        with open(filepath, encoding='utf-8') as f:
            raw = f.read()
        local = parse_tid(raw)
    except Exception:
        continue
    # If text is present and non-empty, and created is present, assume complete.
    missing = [f for f in REQUIRED_REMOTE_FIELDS
               if f not in local or (f == 'text' and not local.get('text', '').strip())]
    if missing:
        to_fix.append((title, filename, local, missing))

print(f'Found {len(to_fix)} incomplete tiddler(s).')

if not to_fix:
    print('Nothing to fix.')
    con.close()
    sys.exit(0)

for title, filename, local, missing in to_fix:
    print(f'\n  [{title}] missing: {missing}')
    filepath = os.path.join(TIDDLERS_DIR, filename)
    try:
        remote_data = fetch_remote(title)
    except Exception as e:
        print(f'    ERROR fetching remote: {e}')
        continue

    remote_fields = normalize_remote(remote_data)
    if not remote_fields.get('title'):
        print(f'    ERROR: remote returned no title')
        continue

    # Merge: start from remote (authoritative for content), then add any local
    # custom fields (like linkstyle/color) that are not on the remote.
    merged = dict(remote_fields)
    for k, v in local.items():
        if k not in merged and not NUMERIC_RE.match(k):
            merged[k] = v

    # Write merged .tid
    tmp = filepath + '.fix-tmp'
    try:
        with open(tmp, 'w', encoding='utf-8', newline='') as f:
            f.write(serialize_tid(merged))
        os.replace(tmp, filepath)
    except Exception as e:
        try: os.unlink(tmp)
        except: pass
        print(f'    ERROR writing file: {e}')
        continue

    # Update DB
    new_hdr = {k: v for k, v in merged.items() if k != 'text'}
    with con:
        con.execute(
            'UPDATE tiddlers SET header_json = ?, dirty = 1, modified = ? WHERE title = ?',
            (json.dumps(new_hdr, ensure_ascii=False), merged.get('modified', ''), title)
        )

    print(f'    Fixed — now has: {sorted(merged.keys())}')

con.close()
print('\nDone. Fixed tiddlers marked dirty=1 — will be pushed to remote on next sync.')
