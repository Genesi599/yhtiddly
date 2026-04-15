// config.js - Configuration loader
// Priority: environment variables > config.json > defaults

const fs = require('fs');
const path = require('path');

let configPath = null;  // set by init()
let cached = null;

const DEFAULTS = {
    remoteUrl: '',
    localPort: 3000,
    syncInterval: 15000,
    username: '',
    password: '',
    autoStart: false,
    lastSyncTime: 0
};

function init(userDataDir) {
    configPath = path.join(userDataDir, 'config.json');
    return load();
}

function load() {
    let fileConfig = {};
    if (configPath && fs.existsSync(configPath)) {
        try {
            fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) {
            console.error('[config] failed to parse config.json:', e.message);
        }
    }

    cached = Object.assign({}, DEFAULTS, fileConfig);

    // Environment overrides
    if (process.env.REMOTE_URL) cached.remoteUrl = process.env.REMOTE_URL;
    if (process.env.LOCAL_PORT) cached.localPort = parseInt(process.env.LOCAL_PORT, 10);
    if (process.env.SYNC_INTERVAL) cached.syncInterval = parseInt(process.env.SYNC_INTERVAL, 10);
    if (process.env.TW_USERNAME) cached.username = process.env.TW_USERNAME;
    if (process.env.TW_PASSWORD) cached.password = process.env.TW_PASSWORD;
    if (process.env.DB_PATH) cached.dbPath = process.env.DB_PATH;

    // Normalize remote URL
    if (cached.remoteUrl) {
        cached.remoteUrl = cached.remoteUrl.replace(/\/+$/, '');
    }

    return cached;
}

function save(updates) {
    if (!configPath) throw new Error('config not initialized');
    const merged = Object.assign({}, cached || DEFAULTS, updates);

    // Don't persist env-only or computed fields
    const toSave = {
        remoteUrl: merged.remoteUrl,
        localPort: merged.localPort,
        syncInterval: merged.syncInterval,
        username: merged.username,
        password: merged.password,
        autoStart: merged.autoStart,
        lastSyncTime: merged.lastSyncTime
    };

    fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), 'utf8');
    cached = load();
    return cached;
}

function get() {
    if (!cached) throw new Error('config not initialized');
    return cached;
}

function isConfigured() {
    return !!(cached && cached.remoteUrl);
}

module.exports = { init, load, save, get, isConfigured };
