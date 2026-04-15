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
    closeSettings: () => ipcRenderer.send('close-settings'),
    onProgress: (cb) => {
        const listener = (_e, p) => cb(p);
        ipcRenderer.on('progress', listener);
        return () => ipcRenderer.removeListener('progress', listener);
    }
});
