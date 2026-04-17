// gen-icon.js - Generate a visible tray icon PNG
//
// Draws a 32x32 rounded-square with a white "T" (TiddlyWiki mark) centered.
// Writes ui/tray-icon.png. Replace with your own if desired.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 32;

// --- Pixel buffer (RGBA, 32x32) ---
const pixels = Buffer.alloc(SIZE * SIZE * 4);

// Background color (a clear blue)
const BG_R = 30, BG_G = 130, BG_B = 220;
// Foreground (white)
const FG_R = 255, FG_G = 255, FG_B = 255;

function setPixel(x, y, r, g, b, a) {
    const i = (y * SIZE + x) * 4;
    pixels[i]     = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = a;
}

// Fill with rounded rectangle (radius 4)
const RADIUS = 4;
for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
        let transparent = false;
        if (x < RADIUS && y < RADIUS) {
            const dx = RADIUS - x, dy = RADIUS - y;
            if (dx * dx + dy * dy > RADIUS * RADIUS) transparent = true;
        } else if (x >= SIZE - RADIUS && y < RADIUS) {
            const dx = x - (SIZE - RADIUS - 1), dy = RADIUS - y;
            if (dx * dx + dy * dy > RADIUS * RADIUS) transparent = true;
        } else if (x < RADIUS && y >= SIZE - RADIUS) {
            const dx = RADIUS - x, dy = y - (SIZE - RADIUS - 1);
            if (dx * dx + dy * dy > RADIUS * RADIUS) transparent = true;
        } else if (x >= SIZE - RADIUS && y >= SIZE - RADIUS) {
            const dx = x - (SIZE - RADIUS - 1), dy = y - (SIZE - RADIUS - 1);
            if (dx * dx + dy * dy > RADIUS * RADIUS) transparent = true;
        }
        if (transparent) setPixel(x, y, 0, 0, 0, 0);
        else setPixel(x, y, BG_R, BG_G, BG_B, 255);
    }
}

// Draw a "T" centered: horizontal bar at y=8 (width 20, height 4),
// vertical bar at x=14 (width 4, height 18).
function drawRect(x0, y0, w, h, r, g, b) {
    for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
            if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) setPixel(x, y, r, g, b, 255);
        }
    }
}
drawRect(6, 8, 20, 4, FG_R, FG_G, FG_B);   // T top
drawRect(14, 12, 4, 14, FG_R, FG_G, FG_B); // T stem

// --- PNG encoding ---

// Build IDAT: each scanline prefixed with filter byte 0
const stride = SIZE * 4;
const raw = Buffer.alloc((stride + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
}
const idatData = zlib.deflateSync(raw);

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    const table = zlib.crc32 || require('buffer').Buffer.crc32 || null;
    const toCrc = Buffer.concat([typeBuf, data]);
    let crcVal;
    if (zlib.crc32) {
        crcVal = zlib.crc32(toCrc);
    } else {
        // Fallback CRC32 implementation
        const crcTable = [];
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            crcTable[n] = c >>> 0;
        }
        let c = 0xFFFFFFFF;
        for (let i = 0; i < toCrc.length; i++) c = crcTable[(c ^ toCrc[i]) & 0xFF] ^ (c >>> 8);
        crcVal = (c ^ 0xFFFFFFFF) >>> 0;
    }
    crc.writeUInt32BE(crcVal, 0);
    return Buffer.concat([length, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type: RGBA
ihdr[10] = 0;  // compression
ihdr[11] = 0;  // filter
ihdr[12] = 0;  // interlace

const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),  // signature
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0))
]);

const outDir = path.join(__dirname, 'ui');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'tray-icon.png');
fs.writeFileSync(outPath, png);
console.log('Wrote', outPath, '(' + png.length + ' bytes,', SIZE + 'x' + SIZE + ')');
