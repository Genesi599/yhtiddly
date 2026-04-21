#!/usr/bin/env node
// scripts/set-icon.js
// Post-pack helper: embed ui/app-icon.ico into the Windows EXE via rcedit.
//
// electron-packager's built-in rcedit call sometimes fails when Windows AV
// holds a temporary lock on a freshly-written EXE. This script works around
// it by copying the EXE to %TEMP%, patching it there, then copying back.

const { execFileSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const exePath  = path.resolve(__dirname, '..', 'dist', 'TWSync-win32-x64', 'TWSync.exe');
const icoPath  = path.resolve(__dirname, '..', 'ui', 'app-icon.ico');
const rcedit   = path.resolve(__dirname, '..', 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');

if (!fs.existsSync(exePath)) { console.error('EXE not found:', exePath); process.exit(1); }
if (!fs.existsSync(icoPath)) { console.error('ICO not found:', icoPath); process.exit(1); }
if (!fs.existsSync(rcedit))  { console.error('rcedit not found:', rcedit); process.exit(1); }

const tmp = path.join(os.tmpdir(), 'TWSync-icon-patch.exe');

console.log('[set-icon] Copying EXE to temp...');
fs.copyFileSync(exePath, tmp);

console.log('[set-icon] Embedding icon via rcedit...');
try {
    execFileSync(rcedit, [tmp, '--set-icon', icoPath], { stdio: 'inherit' });
} catch (e) {
    fs.unlinkSync(tmp);
    console.error('[set-icon] rcedit failed:', e.message);
    process.exit(1);
}

console.log('[set-icon] Copying patched EXE back...');
// AV scanners may briefly lock the freshly-written EXE — retry up to 10×
let copyErr;
for (let i = 0; i < 10; i++) {
    try { fs.copyFileSync(tmp, exePath); copyErr = null; break; }
    catch (e) {
        copyErr = e;
        process.stdout.write('  locked, retrying in 2s… (' + (i+1) + '/10)\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
}
try { fs.unlinkSync(tmp); } catch (_) {}
if (copyErr) { console.error('[set-icon] copy back failed:', copyErr.message); process.exit(1); }

console.log('[set-icon] Done. Icon embedded successfully.');
