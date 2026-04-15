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
let loadingWindow = null;
let tray = null;
let isQuittingForReal = false;

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

    // Close to tray instead of quitting
    mainWindow.on('close', (e) => {
        if (!isQuittingForReal) {
            e.preventDefault();
            mainWindow.hide();
            if (process.platform === 'darwin') app.dock.hide();
        }
    });

    mainWindow.on('closed', () => { mainWindow = null; });
    return mainWindow;
}

function createSettingsWindow(onSaved) {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.focus();
        return;
    }
    settingsWindow = new BrowserWindow({
        width: 520,
        height: 520,
        title: '同步设置',
        resizable: false,
        minimizable: false,
        maximizable: false,
        parent: mainWindow || undefined,
        modal: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    settingsWindow.setMenuBarVisibility(false);
    settingsWindow.loadFile(path.join(__dirname, 'ui', 'settings.html'));
    settingsWindow.on('closed', () => {
        settingsWindow = null;
        if (onSaved) onSaved();
    });
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
const FALLBACK_ICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAS0lEQVR4Ae3UMQoAIAxDUe//b11EUHSqOiTwh0IhpXkEylqrHr4AoDvQB3oD0xv4A58OLBzYcmDLgV0HNh3YcGDNgRUHbnvhfY/pALqAZT95OxNxAAAAAElFTkSuQmCC';

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
        // Danger: wipe local cache (will trigger full re-sync)
        try {
            db.getRaw().exec('DELETE FROM tiddlers; DELETE FROM meta;');
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.on('close-settings', () => {
        if (settingsWindow) settingsWindow.close();
    });
}

// ---------- Startup orchestration ----------

async function bootstrap() {
    const userData = app.getPath('userData');
    fs.mkdirSync(userData, { recursive: true });

    config.init(userData);
    const cfg = config.get();

    // Init DB
    const dbPath = cfg.dbPath || path.join(userData, 'tiddlers.db');
    db.init(dbPath);

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

    // If first run: initial full sync with loading window
    if (!sync.isInitialSyncDone()) {
        createLoadingWindow();
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
        if (loadingWindow) loadingWindow.close();
    }

    // Background sync
    sync.start();
    sync.on(() => refreshTrayMenu());

    // Main window
    createMainWindow();
    if (!tray) createTray();
    else refreshTrayMenu();
}

// ---------- Shutdown ----------

async function quitApp() {
    isQuittingForReal = true;
    sync.stop();
    try {
        await sync.finalSync();
    } catch (e) { /* ignore */ }
    try { await server.stop(); } catch (e) {}
    db.close();
    app.quit();
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
