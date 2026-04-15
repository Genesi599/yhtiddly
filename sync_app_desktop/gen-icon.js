// gen-icon.js - Generate a simple tray icon PNG
//
// Run: node gen-icon.js
// Writes to ui/tray-icon.png (16x16 blue square).
// Replace with your own icon if desired.

const fs = require('fs');
const path = require('path');

const B64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAS0lEQVR4Ae3UMQoAIAxDUe//b11EUHSqOiTwh0IhpXkEylqrHr4AoDvQB3oD0xv4A58OLBzYcmDLgV0HNh3YcGDNgRUHbnvhfY/pALqAZT95OxNxAAAAAElFTkSuQmCC';

const outDir = path.join(__dirname, 'ui');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'tray-icon.png');
fs.writeFileSync(outPath, Buffer.from(B64, 'base64'));
console.log('Wrote', outPath);
