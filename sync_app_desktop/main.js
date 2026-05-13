// main.js - Electron main process
//
// Responsibilities:
// - Start local Express server + DB
// - Show settings window on first run (no remote URL yet)
// - Show loading window during initial full sync
// - Show main BrowserWindow loading http://localhost:<port>
// - System tray with open/browser/settings/quit
// - Graceful shutdown with final sync

const { app, BrowserWindow, Tray, Menu, shell, ipcMain, nativeImage, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');

// Expose Chrome DevTools Protocol on localhost:9222 so external tooling
// (Python CDP clients, Claude, perf profilers) can drive the renderer
// hands-free — open tiddlers, run JS, capture timing, read console. Bound
// to 127.0.0.1 by default, not externally reachable. Set TWSYNC_NO_DEBUG=1
// to disable.
if (!process.env.TWSYNC_NO_DEBUG) {
    const port = parseInt(process.env.TWSYNC_DEBUG_PORT, 10) || 9222;
    app.commandLine.appendSwitch('remote-debugging-port', String(port));
    // Electron 32+ blocks WebSocket connections to the CDP endpoint
    // unless the origin is explicitly allowed. * is fine because the
    // port binds to 127.0.0.1 only.
    app.commandLine.appendSwitch('remote-allow-origins', '*');
    console.log('[main] CDP debug port enabled on localhost:' + port +
                ' (set TWSYNC_NO_DEBUG=1 to disable)');
}

const config = require('./config');
const db = require('./db');
const server = require('./server');
const sync = require('./sync');
const backup = require('./backup');

let mainWindow = null;
let settingsWindow = null;
let dashboardWindow = null;
let loadingWindow = null;
let tray = null;
let isQuittingForReal = false;

// Circular buffer of the last 20 completed sync reports for the dashboard log.
const syncLog = [];
function addSyncLog(entry) {
    syncLog.unshift(entry);
    if (syncLog.length > 20) syncLog.length = 20;
}

// Ctrl+F find-bar overlay — injected into the wiki page when the hotkey
// fires. Talks back to the main process through the `findInPage`/`findStop`
// IPC methods exposed by preload.js; Electron's webContents.findInPage does
// the actual highlighting + scroll.
// Kept as a single string so we can pipe it into executeJavaScript.
const openFindBarSnippet = `
(function() {
    if (document.getElementById('__tws_find_bar')) {
        document.getElementById('__tws_find_input').focus();
        document.getElementById('__tws_find_input').select();
        return;
    }
    const api = window.twApi;
    if (!api || !api.findInPage) {
        console.warn('[find] twApi.findInPage not available — preload may be stale');
        return;
    }

    const bar = document.createElement('div');
    bar.id = '__tws_find_bar';
    bar.style.cssText = 'position:fixed;top:10px;right:16px;z-index:2147483647;' +
        'display:flex;align-items:center;gap:6px;' +
        'background:#2a2e3a;color:#e8ecf4;border:1px solid #3d4250;' +
        'border-radius:6px;padding:6px 10px;' +
        'font:13px -apple-system,\"Segoe UI\",\"Microsoft YaHei\",sans-serif;' +
        'box-shadow:0 4px 14px rgba(0,0,0,.3)';

    const input = document.createElement('input');
    input.id = '__tws_find_input';
    input.placeholder = '\u67e5\u627e\u9875\u9762';  // "查找页面"
    input.style.cssText = 'background:#1a1f2e;color:#fff;border:1px solid #3d4250;' +
        'border-radius:4px;padding:4px 8px;width:200px;outline:none;font:inherit';
    bar.appendChild(input);

    const count = document.createElement('span');
    count.id = '__tws_find_count';
    count.style.cssText = 'font-size:11px;color:#8a94a8;min-width:42px;text-align:center;font-variant-numeric:tabular-nums';
    count.textContent = '';
    bar.appendChild(count);

    function mkBtn(label, title, onclick) {
        const b = document.createElement('button');
        b.textContent = label;
        b.title = title;
        b.style.cssText = 'background:transparent;color:#c8cfdb;border:none;cursor:pointer;' +
            'padding:3px 7px;border-radius:3px;font:inherit;line-height:1';
        b.onmouseenter = () => b.style.background = '#3d4250';
        b.onmouseleave = () => b.style.background = 'transparent';
        b.onclick = (e) => { e.preventDefault(); onclick(); input.focus(); };
        return b;
    }

    bar.appendChild(mkBtn('\u2191', '\u4e0a\u4e00\u4e2a (Shift+Enter)', () => doFind(false)));
    bar.appendChild(mkBtn('\u2193', '\u4e0b\u4e00\u4e2a (Enter)',       () => doFind(true)));
    bar.appendChild(mkBtn('\u00d7', '\u5173\u95ed (Esc)',                close));

    document.body.appendChild(bar);
    input.focus();

    // Result listener — updates the match count display. Remove on close.
    const unsubscribe = api.onFindResult && api.onFindResult((r) => {
        if (!r) return;
        if (r.matches != null && r.activeMatchOrdinal != null) {
            count.textContent = r.activeMatchOrdinal + '/' + r.matches;
        } else if (r.matches === 0) {
            count.textContent = '0/0';
        }
    });

    let prevText = '';
    function doFind(forward) {
        const t = input.value;
        if (!t) { api.findStop(); count.textContent = ''; return; }
        const findNext = (t === prevText);  // same query → jump to next/prev match
        prevText = t;
        api.findInPage(t, { forward: forward, findNext: findNext });
    }

    input.addEventListener('input', () => { prevText = ''; doFind(true); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')       { e.preventDefault(); doFind(!e.shiftKey); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });

    function close() {
        if (typeof unsubscribe === 'function') unsubscribe();
        api.findStop();
        bar.remove();
    }
})();
`;

// ---------- Window factories ----------

function createMainWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        return mainWindow;
    }
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        title: 'TiddlyWiki Sync',
        icon: getAppIcon() || path.join(__dirname, 'ui', 'tray-icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    const url = 'http://localhost:' + server.getPort();
    mainWindow.loadURL(url);
    mainWindow.setMenuBarVisibility(false);

    // Relay match counts from webContents.findInPage back to the renderer's
    // find bar overlay (which subscribes via twApi.onFindResult in preload).
    mainWindow.webContents.on('found-in-page', (_event, result) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('find-result', {
                matches: result.matches,
                activeMatchOrdinal: result.activeMatchOrdinal,
                finalUpdate: result.finalUpdate
            });
        }
    });

    // Patch TW's syncer before it processes tiddlers.json:
    // - storeTiddler is always called with isSkinny=true by the tiddlyweb adaptor,
    //   even for fat tiddlers. We fix this so tiddlers with text skip lazy loading.
    // - Also disable TW's own sync polling (our sync.js handles sync externally).
    // Ctrl+scroll zoom
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.executeJavaScript(`
            window.addEventListener('wheel', function(e) {
                if (!e.ctrlKey) return;
                e.preventDefault();
                if (window.twApi && window.twApi.adjustZoom) {
                    window.twApi.adjustZoom(e.deltaY < 0 ? 0.5 : -0.5);
                }
            }, { passive: false });
        `).catch(() => {});
    });

    // Fallback patch (runs after page load): disables TW's lazy-load and server sync.
    // The HTML injection (server.js maybeInjectPatch) is the primary mechanism and fires
    // earlier (synchronously during boot). This backup fires after did-finish-load in case
    // the primary was skipped (e.g. the marker wasn't found).
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.executeJavaScript(`
            (function patchSyncer() {
                if (!window.$tw || !$tw.syncer) { setTimeout(patchSyncer, 50); return; }
                // Kill lazy-load: HTML embedded store already has all tiddlers fat
                $tw.syncer.handleLazyLoadEvent = function() {};
                // Prevent bulk server-to-client sync: revision mismatch would queue 18000+ XHRs
                $tw.syncer.canSyncFromServer = function() { return false; };
                $tw.syncer.syncFromServerInterval = 999999999;
                if ($tw.syncer.pollTimerId) { clearTimeout($tw.syncer.pollTimerId); $tw.syncer.pollTimerId = null; }
                console.log('[patch] lazy-load and sync-from-server disabled (fallback)');
            })();
        `).catch(() => {});
    });

    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        const ctrl = input.control || input.meta;
        if (input.key === 'F12') {
            mainWindow.webContents.toggleDevTools();
            event.preventDefault();
        } else if (ctrl && input.shift && input.key.toLowerCase() === 'i') {
            mainWindow.webContents.toggleDevTools();
            event.preventDefault();
        } else if (ctrl && input.key.toLowerCase() === 'f' && !input.shift && !input.alt) {
            // Ctrl+F — open in-page find bar. TW's own keyboard bindings
            // would otherwise swallow this and focus its sidebar search;
            // preventDefault before the renderer sees it.
            mainWindow.webContents.executeJavaScript(openFindBarSnippet).catch(() => {});
            event.preventDefault();
        } else if (ctrl && input.key.toLowerCase() === 'r' && !input.shift) {
            mainWindow.webContents.reload();
            event.preventDefault();
        // Hard reload (bypass cache): Ctrl+F5 or Ctrl+Shift+R
        } else if ((ctrl && input.key === 'F5') || (ctrl && input.shift && input.key.toLowerCase() === 'r')) {
            mainWindow.webContents.reloadIgnoringCache();
            event.preventDefault();
        // Plain F5 → normal reload
        } else if (input.key === 'F5' && !ctrl) {
            mainWindow.webContents.reload();
            event.preventDefault();
        // Zoom in: Ctrl++ or Ctrl+=
        } else if (ctrl && (input.key === '+' || input.key === '=' || input.key === 'Add')) {
            mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() + 0.5);
            event.preventDefault();
        // Zoom out: Ctrl+-
        } else if (ctrl && (input.key === '-' || input.key === 'Subtract')) {
            mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() - 0.5);
            event.preventDefault();
        // Reset zoom: Ctrl+0
        } else if (ctrl && input.key === '0') {
            mainWindow.webContents.setZoomLevel(0);
            event.preventDefault();
        }
    });

    // Close to tray instead of quitting
    mainWindow.on('close', (e) => {
        if (!isQuittingForReal) {
            e.preventDefault();
            mainWindow.hide();
            if (process.platform === 'darwin') app.dock.hide();
        }
    });

    // Preload happens server-side via HTML rewrite (server.js injects
    // $tw.preloadTiddlers into <head>), so TW boots with full text already.

    mainWindow.on('closed', () => { mainWindow = null; });
    return mainWindow;
}

function createSettingsWindow(onSaved) {
    console.log('[settings] createSettingsWindow called');
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        console.log('[settings] reusing existing window, showing/focusing');
        if (!settingsWindow.isVisible()) settingsWindow.show();
        settingsWindow.focus();
        settingsWindow.moveTop();
        return;
    }
    try {
        settingsWindow = new BrowserWindow({
            width: 560,
            height: 640,
            title: '同步设置',
            resizable: true,
            minimizable: false,
            maximizable: false,
            alwaysOnTop: false,
            skipTaskbar: false,
            parent: undefined,  // don't tie to mainWindow — mainWindow may be hidden to tray
            modal: false,
            show: false,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false
            }
        });
        settingsWindow.setMenuBarVisibility(false);
        const htmlPath = path.join(__dirname, 'ui', 'settings.html');
        console.log('[settings] loading:', htmlPath);
        settingsWindow.loadFile(htmlPath);
        settingsWindow.once('ready-to-show', () => {
            console.log('[settings] ready-to-show');
            settingsWindow.show();
            settingsWindow.focus();
        });
        settingsWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
            console.error('[settings] did-fail-load', code, desc, url);
            dialog.showErrorBox('设置窗口加载失败', desc + '\nURL: ' + url);
        });
        settingsWindow.webContents.on('render-process-gone', (_e, details) => {
            console.error('[settings] render-process-gone', details);
        });
        settingsWindow.on('closed', () => {
            console.log('[settings] closed');
            settingsWindow = null;
            if (onSaved) onSaved();
        });
    } catch (e) {
        console.error('[settings] createSettingsWindow error:', e);
        dialog.showErrorBox('无法打开设置窗口', e.message);
    }
}

function createDashboardWindow() {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        if (!dashboardWindow.isVisible()) dashboardWindow.show();
        dashboardWindow.focus();
        return dashboardWindow;
    }
    dashboardWindow = new BrowserWindow({
        width: 920,
        height: 700,
        title: '同步控制台',
        icon: path.join(__dirname, 'ui', 'tray-icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    dashboardWindow.setMenuBarVisibility(false);
    dashboardWindow.loadFile(path.join(__dirname, 'ui', 'dashboard.html'));
    dashboardWindow.on('closed', () => { dashboardWindow = null; });
    return dashboardWindow;
}

function createLoadingWindow() {
    if (loadingWindow && !loadingWindow.isDestroyed()) return loadingWindow;
    loadingWindow = new BrowserWindow({
        width: 460,
        height: 240,
        frame: false,
        resizable: false,
        alwaysOnTop: false,
        center: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    loadingWindow.loadFile(path.join(__dirname, 'ui', 'loading.html'));
    loadingWindow.on('closed', () => { loadingWindow = null; });
    return loadingWindow;
}

// ---------- App icon from wiki favicon ----------

// Try to load the favicon from the tiddler store and use it as the Electron
// app icon (window + tray). Falls back to ui/tray-icon.png if not found.
// The tiddler title 'favicon.ico' (or '$:/favicon.ico') stores a Base64-encoded
// ICO/PNG that TW uses as the browser-tab favicon — we reuse it here so the
// desktop app icon matches the wiki's favicon automatically.
function loadFaviconImage() {
    try {
        const os = require('os');
        for (const title of ['favicon.ico', '$:/favicon.ico']) {
            const t = db.getTiddler(title);
            if (!t || !t.fields || !t.fields.text) continue;
            // Strip all whitespace — .tid parser joins text lines with \n
            const b64 = String(t.fields.text).replace(/\s/g, '');
            if (!b64) continue;
            const buf = Buffer.from(b64, 'base64');
            if (buf.length < 8) continue;

            // First try createFromBuffer (works for PNG/JPEG)
            let img = nativeImage.createFromBuffer(buf);
            if (!img.isEmpty()) {
                console.log('[icon] loaded via createFromBuffer, size:', buf.length);
                return img;
            }

            // Fallback: write to a temp .ico file — Windows needs the file
            // extension to pick the right codec; createFromBuffer doesn't
            // infer ICO format reliably on all Electron builds.
            const tmpFile = path.join(os.tmpdir(), 'tw-sync-icon.ico');
            try {
                fs.writeFileSync(tmpFile, buf);
                img = nativeImage.createFromPath(tmpFile);
                try { fs.unlinkSync(tmpFile); } catch (_) {}
                if (!img.isEmpty()) {
                    console.log('[icon] loaded via temp .ico file, size:', buf.length);
                    return img;
                }
                console.warn('[icon] createFromPath also returned empty for', title);
            } catch (e2) {
                console.warn('[icon] temp file approach failed:', e2.message);
                try { fs.unlinkSync(tmpFile); } catch (_) {}
            }
        }
        console.warn('[icon] no usable favicon tiddler found');
    } catch (e) {
        console.warn('[icon] could not load favicon from wiki:', e.message);
    }
    return null;
}

let _appIcon = null;
function getAppIcon() {
    if (_appIcon) return _appIcon;
    _appIcon = loadFaviconImage();
    return _appIcon;
}

// ---------- Tray ----------

// Minimal 16x16 blue square PNG (base64). Used if ui/tray-icon.png isn't present.
const FALLBACK_ICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAW0lEQVR4nO3XsQ0AIAwDQSZhWOZkF+goggQUAQfpI7n2NSmckrlcarsZ2/eseAl5XT4hpABV+UAACAvwPgD/AXY5Lbj2BQAAAAAAAIAc4BU9QD5MQgDk41Q5zztNwGm/kTSctgAAAABJRU5ErkJggg==';

function loadTrayIcon() {
    // Tray icons must be small and opaque-enough to be visible.
    // Prefer the bundled app-icon.ico (rabbit image), resized to 16x16.
    // The wiki's dark favicon tiddler renders as near-invisible in the tray.
    const icoPath = path.join(__dirname, 'ui', 'app-icon.ico');
    try {
        const img = nativeImage.createFromPath(icoPath);
        if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
    } catch (_) {}
    // Fallback: tray-icon.png
    try {
        const img = nativeImage.createFromPath(path.join(__dirname, 'ui', 'tray-icon.png'));
        if (!img.isEmpty()) return img;
    } catch (_) {}
    // Last resort: small blue square
    return nativeImage.createFromBuffer(Buffer.from(FALLBACK_ICON_B64, 'base64'));
}

function createTray() {
    tray = new Tray(loadTrayIcon());
    tray.setToolTip('TiddlyWiki Sync');
    refreshTrayMenu();
    tray.on('click', () => {
        if (mainWindow) {
            mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
        } else {
            createMainWindow();
        }
    });
}

function refreshTrayMenu() {
    if (!tray) return;
    const status = sync.getStatus();
    const bkStatus = backup.getStatus();
    const lastSyncTxt = status.lastSync
        ? new Date(status.lastSync).toLocaleTimeString()
        : '从未';
    const lastBackupTxt = bkStatus.lastBackup
        ? new Date(bkStatus.lastBackup).toLocaleTimeString()
        : (bkStatus.lastError ? '失败: ' + bkStatus.lastError.slice(0, 30) : '从未');
    const menu = Menu.buildFromTemplate([
        { label: '打开 TiddlyWiki', click: () => {
            if (!mainWindow) createMainWindow();
            else mainWindow.show();
        }},
        { label: '在浏览器打开', click: () => shell.openExternal('http://localhost:' + server.getPort()) },
        { type: 'separator' },
        { label: '本地 tiddler 数: ' + status.totalTiddlers, enabled: false },
        { label: '待上传: ' + status.dirtyCount, enabled: false },
        { label: '上次同步: ' + lastSyncTxt, enabled: false },
        { type: 'separator' },
        { label: '立即同步', click: async () => {
            try { await sync.syncOnce(); refreshTrayMenu(); }
            catch (e) { dialog.showErrorBox('同步失败', e.message); }
        }},
        ...(bkStatus.enabled ? [
            { label: '上次备份: ' + lastBackupTxt, enabled: false },
            { label: '立即备份', click: async () => {
                try {
                    const r = await backup.doBackup();
                    refreshTrayMenu();
                    dialog.showMessageBox({ type: 'info', title: '备份完成', message: '已备份至:\n' + bkStatus.backupDir + '\n' + (r.filename || ''), buttons: ['好'] });
                } catch (e) {
                    dialog.showErrorBox('备份失败', e.message);
                }
            }},
        ] : []),
        { label: '控制台…', click: () => createDashboardWindow() },
        { label: '设置…', click: () => createSettingsWindow() },
        { type: 'separator' },
        { label: '退出', click: () => quitApp() }
    ]);
    tray.setContextMenu(menu);
}

// ---------- IPC for settings/loading UIs ----------

function registerIpc() {
    ipcMain.handle('get-config', () => {
        const c = config.get();
        // Don't send password plain via IPC — but for local app it's fine
        return c;
    });

    ipcMain.handle('save-config', (_e, updates) => {
        const c = config.save(updates);
        return c;
    });

    ipcMain.handle('test-connection', async (_e, { url, username, password }) => {
        try {
            const fetch = require('node-fetch');
            const headers = { 'Accept': 'application/json' };
            if (username && password) {
                headers['Authorization'] = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
            }
            const res = await fetch((url || '').replace(/\/+$/, '') + '/status', { headers, timeout: 10000 });
            if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
            const data = await res.json();
            return { ok: true, data };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('sync-now', async () => {
        try { return await sync.syncOnce(); }
        catch (e) { return { error: e.message }; }
    });

    ipcMain.handle('get-sync-status', () => sync.getStatus());

    ipcMain.handle('reset-local-db', () => {
        // Danger: wipe local cache — both the SQLite index AND the .tid
        // files on disk — then the next startup will re-pull everything
        // from remote. Doing this atomically (db.wipeAll) rather than a
        // raw SQL DELETE so files don't linger as zombies.
        try {
            db.wipeAll();
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('get-tiddlers-dir', () => {
        try { return { path: db.getRaw() ? require('./tiddlerStore').getDir() : null }; }
        catch (e) { return { path: null, error: e.message }; }
    });

    ipcMain.handle('open-tiddlers-dir', () => {
        try {
            const p = require('./tiddlerStore').getDir();
            shell.openPath(p);
            return { ok: true, path: p };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('clear-http-cache', () => {
        try {
            db.cacheClear();
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('cache-stats', () => {
        try { return db.cacheStats(); } catch (e) { return { entries: 0, bytes: 0 }; }
    });

    ipcMain.on('close-settings', () => {
        if (settingsWindow) settingsWindow.close();
    });

    // In-page find — the find bar overlay (see openFindBarSnippet) calls
    // these through the preload bridge. `webContents.findInPage` highlights
    // matches and scrolls to them; `found-in-page` fires back with counts.
    ipcMain.on('find-in-page', (_e, text, opts) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (!text) return;
        mainWindow.webContents.findInPage(text, opts || {});
    });
    ipcMain.on('find-in-page-stop', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.stopFindInPage('clearSelection');
    });

    ipcMain.handle('get-dashboard-data', () => {
        const status = sync.getStatus();
        const cfg = config.get();
        return {
            status,
            remoteUrl: cfg.remoteUrl || '',
            dirtyList: db.getDirtyList(),
            recentTiddlers: db.getRecentTiddlers(30),
            syncLog: syncLog.slice()
        };
    });

    ipcMain.handle('open-browser', () => {
        shell.openExternal('http://localhost:' + server.getPort());
        return { ok: true };
    });

    ipcMain.handle('reload-wiki', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.reload();
            return { ok: true };
        }
        return { ok: false, error: 'main window not open' };
    });

    ipcMain.handle('open-settings', () => {
        createSettingsWindow();
        return { ok: true };
    });

    ipcMain.handle('adjust-zoom', (_e, delta) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            const cur = mainWindow.webContents.getZoomLevel();
            mainWindow.webContents.setZoomLevel(
                delta === 0 ? 0 : Math.max(-5, Math.min(5, cur + delta))
            );
        }
    });

    // ── Backup IPC ──────────────────────────────────────────────────────
    ipcMain.handle('get-backup-status', () => backup.getStatus());

    ipcMain.handle('backup-now', async () => {
        try { return await backup.doBackup(); }
        catch (e) { return { error: e.message }; }
    });

    ipcMain.handle('save-backup-config', (_e, { backupDir, backupInterval }) => {
        const saved = config.save({ backupDir, backupInterval });
        // Restart scheduler with new settings
        backup.stop();
        backup.start();
        refreshTrayMenu();
        return { ok: true, config: saved };
    });

    ipcMain.handle('open-backup-dir', () => {
        const dir = config.get().backupDir;
        if (dir) shell.openPath(dir);
        return { ok: !!dir };
    });
}

// ---------- Startup orchestration ----------

async function bootstrap() {
    const userData = app.getPath('userData');
    fs.mkdirSync(userData, { recursive: true });

    // Wipe the Chromium session disk cache on every startup. Our local server
    // is the only origin the app loads from, and its HTML embeds the full
    // wiki (`$tw.preloadTiddlers`) — when admin-script PUTs update backend
    // tiddlers, a cached HTML response would show stale state forever until
    // the user hits Ctrl+Shift+R. Clearing at boot guarantees the TW window
    // always renders against the latest server-side content.
    try { await session.defaultSession.clearCache(); }
    catch (e) { console.warn('[main] clearCache failed (non-fatal):', e.message); }

    config.init(userData);
    const cfg = config.get();

    // Init DB + file-based tiddler store. Default tiddler dir is
    // `{userData}/tiddlers/`; user can override via config / env.
    const dbPath = cfg.dbPath || path.join(userData, 'tiddlers.db');
    const tiddlersDir = cfg.tiddlersDir && cfg.tiddlersDir.trim().length > 0
        ? cfg.tiddlersDir
        : path.join(userData, 'tiddlers');
    db.init(dbPath, tiddlersDir);
    // Reconcile: pick up hand-edited / hand-added .tid files so the user
    // can freely edit in their editor between app runs. Anything new or
    // modified is flagged dirty so the next sync pushes it.
    try {
        const r = db.reconcileWithFiles();
        if (r.added || r.updated || r.missing) {
            console.log('[main] file reconcile result:', r);
        }
    } catch (e) {
        console.warn('[main] reconcile failed (non-fatal):', e.message);
    }

    // If not configured → force settings first
    if (!config.isConfigured()) {
        createSettingsWindow(async () => {
            if (config.isConfigured()) {
                await afterConfigured();
            } else {
                app.quit();
            }
        });
        return;
    }

    await afterConfigured();
}

async function afterConfigured() {
    // Start local server
    await server.start();

    // Show loading window for initial sync and/or file cache warm-up
    createLoadingWindow();

    // If first run: initial full sync
    if (!sync.isInitialSyncDone()) {
        try {
            await sync.initialFullSync((p) => {
                if (loadingWindow && !loadingWindow.isDestroyed()) {
                    loadingWindow.webContents.send('progress', p);
                }
            });
        } catch (e) {
            dialog.showErrorBox('初始同步失败', e.message + '\n\n检查远程服务器地址和网络连接，然后从设置重新同步。');
            if (loadingWindow) loadingWindow.close();
            createSettingsWindow();
            return;
        }
    }

    // Pre-warm file cache (async I/O), then build the fat tiddler list so
    // tiddlers.json is served from memory — no disk reads, no lazy-loading.
    try {
        await db.warmFileCache((p) => {
            if (loadingWindow && !loadingWindow.isDestroyed()) {
                loadingWindow.webContents.send('progress', p);
            }
        });
        db.listFull(); // build _fatCache while loading screen is still up
    } catch (e) {
        console.warn('[main] warmFileCache error (non-fatal):', e.message);
    }

    if (loadingWindow) loadingWindow.close();

    // Background sync
    sync.start();

    // Periodic HTML backup
    backup.start();
    backup.on((ev) => {
        refreshTrayMenu();
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
            dashboardWindow.webContents.send('backup-status', ev);
        }
    });

    sync.on((status) => {
        refreshTrayMenu();
        if (settingsWindow && !settingsWindow.isDestroyed()) {
            settingsWindow.webContents.send('sync-status', status);
        }
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
            dashboardWindow.webContents.send('sync-status', status);
        }
        if (status.phase === 'idle' && status.status === 'done' && status.report) {
            addSyncLog({
                time: Date.now(),
                pushed: status.report.pushed || 0,
                pulled: status.report.pulled || 0,
                removed: status.report.removed || 0,
                errors: (status.report.errors || []).length
            });
        }
    });

    // Main window
    createMainWindow();
    if (!tray) createTray();
    else refreshTrayMenu();
}

// ---------- Shutdown ----------

// Exit is fast by design:
// - Push dirty tiddlers with a hard 3s budget (losing a push is OK; still
//   marked dirty, next startup will retry). Don't bother pulling.
// - Don't wait for HTTP server to drain — just kill it.
// - Close SQLite (fast, WAL auto-checkpoints).

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))
    ]);
}

async function quitApp() {
    if (isQuittingForReal) return;
    isQuittingForReal = true;
    sync.stop();
    backup.stop();

    // Give a PUSH-only final sync 3s max. Skip pull entirely.
    try {
        await withTimeout(pushOnlyFinalSync(), 3000);
    } catch (e) { /* ignore */ }

    // Don't wait on server.stop() — just force-kill
    try { server.forceStop(); } catch (e) {}

    try { db.close(); } catch (e) {}

    app.exit(0);  // app.exit is immediate; app.quit runs the normal lifecycle
}

async function pushOnlyFinalSync() {
    // Only push dirty tiddlers, don't do the full sync pull (slow on remote)
    const report = await sync.pushOnly();
    console.log('[quit] pushed', report.pushed, 'deleted', report.deleted);
}

app.on('before-quit', (e) => {
    if (!isQuittingForReal) {
        e.preventDefault();
        quitApp();
    }
});

app.on('window-all-closed', (e) => {
    // On macOS, keep the app alive in tray; on other platforms, also keep alive
    // because we're a tray app. Only quit via explicit menu action.
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 || !mainWindow) {
        createMainWindow();
    } else {
        mainWindow.show();
    }
});

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
        registerIpc();
        bootstrap().catch(err => {
            console.error('[main] bootstrap error:', err);
            dialog.showErrorBox('启动失败', err.message);
            app.quit();
        });
    });
}
