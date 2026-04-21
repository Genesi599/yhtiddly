#!/usr/bin/env python3
"""
fix-bcell.py

One-shot repair for the "B cell" tiddler:
  1. Read local B cell.tid and reconstruct the original custom fields
     (linkstyle, color) from the numeric character-spread keys.
  2. Fetch the clean version from the remote server to get the correct
     standard fields (title, tags, type, text, created, modified).
  3. Merge: remote base + recovered custom fields.
  4. Write the merged result back to B cell.tid.
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


# ── .tid helpers ──────────────────────────────────────────────────────────────

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


def quote_tags_field(v):
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


def serialize_tid(fields):
    text   = '' if fields.get('text') is None else str(fields['text'])
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


# ── Reconstruct custom fields from numeric character keys ─────────────────────

def reconstruct_fields(local_fields):
    """
    Numeric keys 0..N are ASCII characters of the original value (a JSON string
    that was accidentally spread into a field map).  Sort numerically, join, and
    parse as JSON; if it's a plain dict, return its string-valued entries.
    """
    num_keys = sorted([k for k in local_fields if NUMERIC_RE.match(k)],
                      key=lambda x: int(x))
    if not num_keys:
        return {}
    reconstructed = ''.join(str(local_fields[k]) for k in num_keys)
    print(f'  Reconstructed value: {reconstructed}')
    try:
        parsed = json.loads(reconstructed)
        if isinstance(parsed, dict):
            return {k: str(v) for k, v in parsed.items() if isinstance(v, (str, int, float, bool))}
    except (json.JSONDecodeError, ValueError):
        print('  WARNING: could not parse reconstructed value as JSON — no recovery')
    return {}


# ── Remote fetch ──────────────────────────────────────────────────────────────

def fetch_tiddler(title):
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


# ── Main ──────────────────────────────────────────────────────────────────────

if not os.path.exists(DB_PATH):
    print('ERROR: DB not found at', DB_PATH)
    sys.exit(1)

# 1. Read local B cell.tid
con = sqlite3.connect(DB_PATH)
row = con.execute(
    "SELECT filename FROM tiddlers WHERE title = 'B cell' AND tombstone = 0"
).fetchone()
if not row:
    print('ERROR: "B cell" not found in local DB')
    sys.exit(1)

filename = row[0]
filepath = os.path.join(TIDDLERS_DIR, filename)
print(f'Local file: {filepath}')

if not os.path.exists(filepath):
    print('ERROR: .tid file not found')
    sys.exit(1)

with open(filepath, encoding='utf-8') as f:
    raw = f.read()
local_fields = parse_tid(raw)
print(f'Local fields (keys): {list(local_fields.keys())}')

# 2. Recover custom fields from numeric keys
recovered = reconstruct_fields(local_fields)
print(f'Recovered fields: {recovered}')

# 3. Fetch remote B cell
print(f'\nFetching remote B cell from {REMOTE} …')
remote_data = fetch_tiddler('B cell')
print(f'Remote top-level keys: {list(remote_data.keys())}')

# 4. Build merged fields:
#    - Start from remote top-level fields (title, tags, type, text, created, modified)
#    - Skip server-only keys (bag, revision) and the nested `fields` sub-object
#    - Add recovered custom fields that aren't already present
SKIP = {'bag', 'revision', 'fields'}
merged = {k: v for k, v in remote_data.items() if k not in SKIP and not NUMERIC_RE.match(k)}
for k, v in recovered.items():
    if k not in merged:
        merged[k] = v
        print(f'  Added recovered field: {k} = {v!r}')

print(f'\nMerged fields: {list(merged.keys())}')

# 5. Write clean .tid file (atomic)
clean_content = serialize_tid(merged)
tmp = filepath + '.fix-tmp'
with open(tmp, 'w', encoding='utf-8', newline='') as f:
    f.write(clean_content)
os.replace(tmp, filepath)
print(f'Wrote clean .tid: {filepath}')
print('--- Content ---')
print(clean_content[:500])
print('---')

# 6. Update DB
new_hdr = {k: v for k, v in merged.items() if k != 'text'}
with con:
    con.execute(
        "UPDATE tiddlers SET header_json = ?, dirty = 1, modified = ? WHERE title = 'B cell'",
        (json.dumps(new_hdr, ensure_ascii=False),
         merged.get('modified', ''))
    )
con.close()
print('\nDB updated — dirty=1, header_json refreshed.')
print('\nDone. B cell will be pushed to remote on next sync.')
