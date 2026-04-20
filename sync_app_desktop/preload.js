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
    }
});
