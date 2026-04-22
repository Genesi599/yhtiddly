// preload.js - Exposes a safe API to renderer processes (settings + loading UIs).
// NOT used for the TW iframe/main browser view — that loads the wiki itself.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('twApi', {
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveConfig: (updates) => ipcRenderer.invoke('save-config', updates),
    testConnection: (opts) => ipcRenderer.invoke('test-connection', opts),
    syncNow: () => ipcRenderer.invoke('sync-now'),
    getSyncStatus: () => ipcRenderer.invoke('get-sync-status'),
    resetLocalDb: () => ipcRenderer.invoke('reset-local-db'),
    clearHttpCache: () => ipcRenderer.invoke('clear-http-cache'),
    cacheStats: () => ipcRenderer.invoke('cache-stats'),
    getTiddlersDir: () => ipcRenderer.invoke('get-tiddlers-dir'),
    openTiddlersDir: () => ipcRenderer.invoke('open-tiddlers-dir'),
    closeSettings: () => ipcRenderer.send('close-settings'),
    getDashboardData: () => ipcRenderer.invoke('get-dashboard-data'),
    reloadWiki: () => ipcRenderer.invoke('reload-wiki'),
    openBrowser: () => ipcRenderer.invoke('open-browser'),
    openSettings: () => ipcRenderer.invoke('open-settings'),
    onProgress: (cb) => {
        const listener = (_e, p) => cb(p);
        ipcRenderer.on('progress', listener);
        return () => ipcRenderer.removeListener('progress', listener);
    },
    onSyncStatus: (cb) => {
        const listener = (_e, s) => cb(s);
        ipcRenderer.on('sync-status', listener);
        return () => ipcRenderer.removeListener('sync-status', listener);
    },
    adjustZoom: (delta) => ipcRenderer.invoke('adjust-zoom', delta),
    getBackupStatus: () => ipcRenderer.invoke('get-backup-status'),
    backupNow: () => ipcRenderer.invoke('backup-now'),
    saveBackupConfig: (cfg) => ipcRenderer.invoke('save-backup-config', cfg),
    openBackupDir: () => ipcRenderer.invoke('open-backup-dir'),
    onBackupStatus: (cb) => {
        const listener = (_e, s) => cb(s);
        ipcRenderer.on('backup-status', listener);
        return () => ipcRenderer.removeListener('backup-status', listener);
    },
    // In-page find. Electron's BrowserWindow has no built-in Ctrl+F UI, so
    // main.js intercepts the hotkey and an overlay (injected into the TW
    // page) talks to the webContents findInPage API through these methods.
    findInPage: (text, opts) => ipcRenderer.send('find-in-page', text, opts || {}),
    findStop: () => ipcRenderer.send('find-in-page-stop'),
    onFindResult: (cb) => {
        const listener = (_e, result) => cb(result);
        ipcRenderer.on('find-result', listener);
        return () => ipcRenderer.removeListener('find-result', listener);
    }
});
