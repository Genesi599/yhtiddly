#!/usr/bin/env python3
"""
clean-remote-garbled.py

Find every tiddler on the remote TiddlyWeb server that has numeric-key
fields (garbled "[object Object]" artefacts), fetch the full content,
strip those keys, and PUT the clean version back.

Usage:
    python clean-remote-garbled.py [remote_url]
    Default remote_url: https://yhtiddly.fun
"""

import json, re, sys, time, urllib.request, urllib.error, urllib.parse
import threading
from queue import Queue, Empty

sys.stdout.reconfigure(encoding='utf-8')

REMOTE = sys.argv[1] if len(sys.argv) > 1 else 'https://yhtiddly.fun'
NUMERIC_RE = re.compile(r'^\d+$')
CONCURRENCY = 8     # parallel workers
MAX_RETRIES = 3


def fetch_json(url, method='GET', body=None, headers=None):
    req_headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    }
    # TiddlyWiki's CSRF guard requires this header on write requests only
    if method in ('PUT', 'POST', 'DELETE'):
        req_headers['X-Requested-With'] = 'TiddlyWiki'
    if headers:
        req_headers.update(headers)
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode('utf-8'))


def get_tiddler(title):
    url = REMOTE + '/recipes/default/tiddlers/' + urllib.parse.quote(title, safe='')
    for attempt in range(MAX_RETRIES):
        try:
            return fetch_json(url)
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                raise
            time.sleep(1 * (attempt + 1))


def put_tiddler(title, fields):
    url = REMOTE + '/recipes/default/tiddlers/' + urllib.parse.quote(title, safe='')
    # PUT body: tiddler fields (without revision/bag, which are server-side)
    body = {k: v for k, v in fields.items() if k not in ('revision', 'bag')}
    for attempt in range(MAX_RETRIES):
        try:
            fetch_json(url, method='PUT', body=body)
            return True
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                raise
            time.sleep(1 * (attempt + 1))


# ── 1. Fetch the skinny tiddler list ─────────────────────────────────────────

print('Fetching tiddler list from', REMOTE, '…')
try:
    all_tiddlers = fetch_json(REMOTE + '/recipes/default/tiddlers.json')
except Exception as e:
    print('ERROR: could not fetch tiddler list:', e)
    sys.exit(1)

garbled = [t for t in all_tiddlers if any(NUMERIC_RE.match(k) for k in t)]
print(f'Found {len(garbled)} tiddlers with numeric fields.')

if not garbled:
    print('Nothing to clean — done.')
    sys.exit(0)

# ── 2. Worker: GET full tiddler → clean → PUT ─────────────────────────────────

q = Queue()
for t in garbled:
    q.put(t['title'])

fixed = 0
errors = 0
lock = threading.Lock()


def worker():
    global fixed, errors
    while True:
        try:
            title = q.get_nowait()
        except Empty:
            break
        try:
            full = get_tiddler(title)

            # TidGi's API can return a hybrid structure:
            #   { "fields": {"0":"[", ...},   ← extra/non-standard fields nested here
            #     "text": "...", "title": ..., "created": ..., ... }
            # OR a flat structure where numeric keys sit at the top level.
            # We need to strip numeric keys from BOTH locations.

            nested_fields = full.get('fields', {}) if isinstance(full.get('fields'), dict) else {}
            nested_numeric = [k for k in nested_fields if NUMERIC_RE.match(k)]
            top_numeric    = [k for k in full if NUMERIC_RE.match(k)]

            if not nested_numeric and not top_numeric:
                q.task_done()
                continue   # already clean

            # Build clean PUT body: top-level fields minus garbage,
            # and rebuild 'fields' without garbled keys (drop 'fields'
            # entirely if it only contained garbage).
            clean = {k: v for k, v in full.items()
                     if k not in ('revision', 'bag') and not NUMERIC_RE.match(k)}
            if nested_fields:
                clean_nested = {k: v for k, v in nested_fields.items() if not NUMERIC_RE.match(k)}
                if clean_nested:
                    clean['fields'] = clean_nested
                else:
                    clean.pop('fields', None)   # all nested fields were garbage → drop

            put_tiddler(title, clean)
            with lock:
                fixed += 1
                if fixed % 50 == 0:
                    print(f'  … {fixed}/{len(garbled)} cleaned')
        except Exception as e:
            with lock:
                errors += 1
                try:
                    print(f'  ERROR: {title}: {e}')
                except Exception:
                    print(f'  ERROR: (unprintable title): {e}')
        finally:
            q.task_done()


threads = [threading.Thread(target=worker, daemon=True) for _ in range(CONCURRENCY)]
for t in threads:
    t.start()
q.join()

print(f'\nDone. Cleaned: {fixed}  Errors: {errors}')
