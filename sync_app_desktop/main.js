// main.js - Electron main process
//
// Responsibilities:
// - Start local Express server + DB
// - Show settings window on first run (no remote URL yet)
// - Show loading window during initial full sync
// - Show main BrowserWindow loading http://localhost:<port>
// - System tray with open/browser/settings/quit
// - Graceful shutdown with final sync

const { app, BrowserWindow, Tray, Menu, shell, ipcMain, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const db = require('./db');
const server = require('./server');
const sync = require('./sync');

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
        icon: path.join(__dirname, 'ui', 'tray-icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    const url = 'http://localhost:' + server.getPort();
    mainWindow.loadURL(url);
    mainWindow.setMenuBarVisibility(false);

    // Patch TW's syncer before it processes tiddlers.json:
    // - storeTiddler is always called with isSkinny=true by the tiddlyweb adaptor,
    //   even for fat tiddlers. We fix this so tiddlers with text skip lazy loading.
    // - Also disable TW's own sync polling (our sync.js handles sync externally).
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.executeJavaScript(`
            (function patchSyncer() {
                if (!window.$tw || !$tw.syncer) { setTimeout(patchSyncer, 50); return; }
                var orig = $tw.syncer.storeTiddler.bind($tw.syncer);
                $tw.syncer.storeTiddler = function(tiddlerFields, isSkinny) {
                    // If tiddler already has text, don't mark it for lazy-loading
                    return orig.call(this, tiddlerFields, isSkinny && !('text' in tiddlerFields));
                };
                // Disable TW's sync polling — sync.js handles sync externally
                $tw.syncer.syncFromServerInterval = 999999999;
                if ($tw.syncer.pollTimerId) { clearTimeout($tw.syncer.pollTimerId); $tw.syncer.pollTimerId = null; }
                console.log('[patch] storeTiddler patched, sync polling disabled');
            })();
        `).catch(() => {});
    });

    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        if (input.key === 'F12') {
            mainWindow.webContents.toggleDevTools();
            event.preventDefault();
        } else if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i') {
            mainWindow.webContents.toggleDevTools();
            event.preventDefault();
        } else if ((input.control || input.meta) && input.key.toLowerCase() === 'r' && !input.shift) {
            mainWindow.webContents.reload();
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

// ---------- Tray ----------

// Minimal 16x16 blue square PNG (base64). Used if ui/tray-icon.png isn't present.
const FALLBACK_ICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAW0lEQVR4nO3XsQ0AIAwDQSZhWOZkF+goggQUAQfpI7n2NSmckrlcarsZ2/eseAl5XT4hpABV+UAACAvwPgD/AXY5Lbj2BQAAAAAAAIAc4BU9QD5MQgDk41Q5zztNwGm/kTSctgAAAABJRU5ErkJggg==';

function createTray() {
    const iconPath = path.join(__dirname, 'ui', 'tray-icon.png');
    let img;
    try {
        img = nativeImage.createFromPath(iconPath);
        if (img.isEmpty()) throw new Error('empty');
    } catch (e) {
        // Fallback: use inlined base64 icon
        img = nativeImage.createFromBuffer(Buffer.from(FALLBACK_ICON_B64, 'base64'));
    }
    tray = new Tray(img);
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
    const lastSyncTxt = status.lastSync
        ? new Date(status.lastSync).toLocaleTimeString()
        : '从未';
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
}

// ---------- Startup orchestration ----------

async function bootstrap() {
    const userData = app.getPath('userData');
    fs.mkdirSync(userData, { recursive: true });

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
