// backup.js — Periodic full-HTML backup of the remote TiddlyWiki.
//
// Fetches the complete single-file TiddlyWiki HTML from the remote server
// and writes it to backupDir with a timestamped filename, e.g.:
//   tiddlywiki_20260421_153000.html
//
// Schedule: configurable via config.backupInterval (ms). 0 = disabled.
// Dir:      config.backupDir. Empty = disabled.

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const fetch  = require('node-fetch');
const config = require('./config');

let timer     = null;
let listeners = [];

// Circular log of last 20 backup results
const backupLog = [];
function addLog(entry) {
    backupLog.unshift(entry);
    if (backupLog.length > 20) backupLog.length = 20;
}

function on(fn)   { listeners.push(fn); }
function emit(ev) { for (const fn of listeners) { try { fn(ev); } catch (_) {} } }

// ── Auth (same as sync.js) ────────────────────────────────────────────────

function authHeader() {
    const cfg = config.get();
    if (cfg.username && cfg.password) {
        const b64 = Buffer.from(cfg.username + ':' + cfg.password).toString('base64');
        return 'Basic ' + b64;
    }
    return null;
}

// ── Timestamp filename ────────────────────────────────────────────────────

function timestampedFilename() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const date = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate());
    const time = pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
    return 'tiddlywiki_' + date + '_' + time + '.html';
}

// ── Core backup ───────────────────────────────────────────────────────────

async function doBackup() {
    const cfg = config.get();
    const backupDir = cfg.backupDir || '';

    if (!cfg.remoteUrl)  throw new Error('remote URL not configured');
    if (!backupDir)      throw new Error('backup directory not configured');

    fs.mkdirSync(backupDir, { recursive: true });

    emit({ status: 'running' });

    const headers = { 'Accept': 'text/html,*/*', 'Cache-Control': 'no-cache' };
    const auth = authHeader();
    if (auth) headers['Authorization'] = auth;

    const res = await fetch(cfg.remoteUrl + '/', { headers, timeout: 180000 });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + cfg.remoteUrl);

    const html = await res.text();
    if (!html || html.length < 1000) throw new Error('response too short — not a TiddlyWiki HTML');

    // Write to %TEMP% first (avoids cloud-sync client locking during write),
    // then copy the completed file into the backup directory.
    const filename = timestampedFilename();
    const destPath = path.join(backupDir, filename);
    const tmp = path.join(os.tmpdir(), 'tw-backup-' + process.pid + '.html');

    fs.writeFileSync(tmp, html, 'utf8');

    // Retry copy up to 5× in case cloud client briefly locks the directory
    const delay = ms => new Promise(r => setTimeout(r, ms));
    let lastErr;
    for (let i = 0; i < 5; i++) {
        try { fs.copyFileSync(tmp, destPath); lastErr = null; break; }
        catch (e) { lastErr = e; if (i < 4) await delay(2000 * (i + 1)); }
    }
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (lastErr) throw lastErr;

    const entry = { time: Date.now(), filename, size: html.length, error: null };
    addLog(entry);
    emit({ status: 'done', ...entry, path: destPath });
    console.log('[backup] →', destPath, '(' + Math.round(html.length / 1024) + ' KiB)');

    // Prune oldest backups — keep at most MAX_BACKUPS files
    pruneOldBackups(backupDir);

    return entry;
}

// ── Prune old backups ─────────────────────────────────────────────────────

const MAX_BACKUPS = 30;

function pruneOldBackups(backupDir) {
    try {
        // Only touch files that match our naming pattern
        const files = fs.readdirSync(backupDir)
            .filter(f => /^tiddlywiki_\d{8}_\d{6}\.html$/.test(f))
            .sort();   // lexicographic = chronological (YYYYMMDD_HHmmss)

        const excess = files.length - MAX_BACKUPS;
        if (excess <= 0) return;

        const toDelete = files.slice(0, excess);   // oldest first
        for (const f of toDelete) {
            try {
                fs.unlinkSync(path.join(backupDir, f));
                console.log('[backup] pruned old backup:', f);
            } catch (e) {
                console.warn('[backup] could not delete', f, '—', e.message);
            }
        }
    } catch (e) {
        console.warn('[backup] prune failed:', e.message);
    }
}

// ── Scheduler ─────────────────────────────────────────────────────────────

function runOnce() {
    doBackup().catch(e => {
        const entry = { time: Date.now(), filename: null, size: 0, error: e.message };
        addLog(entry);
        emit({ status: 'error', error: e.message });
        console.error('[backup] failed:', e.message);
    });
}

function start() {
    stop();
    const cfg = config.get();
    if (!cfg.backupDir) { console.log('[backup] disabled (no backupDir)'); return; }
    const interval = cfg.backupInterval || 3600000;
    if (interval === 0) { console.log('[backup] disabled (interval=0)'); return; }

    runOnce();   // immediate first run
    timer = setInterval(runOnce, interval);
    console.log('[backup] started — every', Math.round(interval / 60000), 'min →', cfg.backupDir);
}

function stop() {
    if (timer) { clearInterval(timer); timer = null; }
}

function getStatus() {
    const cfg = config.get();
    const last = backupLog[0] || null;
    return {
        enabled:    !!(cfg.backupDir && cfg.backupInterval),
        backupDir:  cfg.backupDir  || '',
        interval:   cfg.backupInterval || 3600000,
        lastBackup: last ? last.time  : 0,
        lastFile:   last ? last.filename : null,
        lastError:  last ? last.error : null,
        log:        backupLog.slice(0, 10)
    };
}

module.exports = { doBackup, start, stop, getStatus, on };
