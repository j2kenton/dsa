#!/usr/bin/env node
// Generates icon16.png, icon48.png, icon128.png in extension/icons/
// No dependencies — writes raw PNG using zlib (built-in).

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT_DIR = path.join(__dirname, "extension", "icons");
fs.mkdirSync(OUT_DIR, { recursive: true });

// --- Minimal PNG writer ---

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crcVal = Buffer.allocUnsafe(4);
  crcVal.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([len, typeBytes, data, crcVal]);
}

function encodePNG(width, height, pixels) {
  // pixels: Uint8Array of RGBA, row-major
  const rawRows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.allocUnsafe(1 + width * 4);
    row[0] = 0; // filter type None
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      row[1 + x * 4 + 0] = pixels[i + 0];
      row[1 + x * 4 + 1] = pixels[i + 1];
      row[1 + x * 4 + 2] = pixels[i + 2];
      row[1 + x * 4 + 3] = pixels[i + 3];
    }
    rawRows.push(row);
  }
  const raw = Buffer.concat(rawRows);
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Icon renderer ---
// Draws a dark rounded-square background with white "<>" brackets

function renderIcon(size) {
  const pixels = new Uint8Array(size * size * 4);

  const BG = [30, 30, 46, 255];    // dark navy
  const FG = [205, 214, 244, 255]; // soft white

  const radius = Math.round(size * 0.18);
  const cx = size / 2;
  const cy = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      // Rounded rectangle (anti-aliased via distance)
      const dx = Math.max(0, Math.abs(x - cx) - (size / 2 - radius - 0.5));
      const dy = Math.max(0, Math.abs(y - cy) - (size / 2 - radius - 0.5));
      const dist = Math.sqrt(dx * dx + dy * dy) - radius;
      const alpha = Math.max(0, Math.min(1, 0.5 - dist));

      pixels[idx + 0] = BG[0];
      pixels[idx + 1] = BG[1];
      pixels[idx + 2] = BG[2];
      pixels[idx + 3] = Math.round(alpha * 255);
    }
  }

  // Draw "<>" using thick strokes scaled to icon size
  const stroke = Math.max(1, Math.round(size * 0.09));
  const armLen = size * 0.22;
  const spread = size * 0.17;
  const leftX = cx - size * 0.18;
  const rightX = cx + size * 0.18;

  function drawLine(x0, y0, x1, y1) {
    const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const lx = x0 + (x1 - x0) * t;
      const ly = y0 + (y1 - y0) * t;
      for (let py = Math.floor(ly - stroke); py <= Math.ceil(ly + stroke); py++) {
        for (let px = Math.floor(lx - stroke); px <= Math.ceil(lx + stroke); px++) {
          if (px < 0 || py < 0 || px >= size || py >= size) continue;
          const d = Math.sqrt((px - lx) ** 2 + (py - ly) ** 2) - stroke / 2;
          const a = Math.max(0, Math.min(1, 0.5 - d));
          if (a <= 0) continue;
          const idx = (py * size + px) * 4;
          const bg_a = pixels[idx + 3] / 255;
          const out_a = a + bg_a * (1 - a);
          if (out_a === 0) continue;
          pixels[idx + 0] = Math.round((FG[0] * a + pixels[idx + 0] * bg_a * (1 - a)) / out_a);
          pixels[idx + 1] = Math.round((FG[1] * a + pixels[idx + 1] * bg_a * (1 - a)) / out_a);
          pixels[idx + 2] = Math.round((FG[2] * a + pixels[idx + 2] * bg_a * (1 - a)) / out_a);
          pixels[idx + 3] = Math.round(out_a * 255);
        }
      }
    }
  }

  // "<" left bracket
  drawLine(leftX + armLen, cy - spread, leftX, cy);
  drawLine(leftX, cy, leftX + armLen, cy + spread);
  // ">" right bracket
  drawLine(rightX - armLen, cy - spread, rightX, cy);
  drawLine(rightX, cy, rightX - armLen, cy + spread);

  return encodePNG(size, size, pixels);
}

for (const size of [16, 48, 128]) {
  const buf = renderIcon(size);
  const outPath = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(outPath, buf);
  console.log(`Wrote ${outPath}`);
}
