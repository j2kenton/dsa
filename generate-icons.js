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
// Draws a dark rounded-square background with a graph "solved path": two plain
// nodes connected to a highlighted node, tracing a checkmark-like path.

function renderIcon(size) {
  const pixels = new Uint8Array(size * size * 4);

  const BG = [255, 255, 255, 255];  // white, checkbox-like
  const ACCENT = [52, 168, 83, 255]; // solid green
  const EDGE = [27, 94, 32, 255];    // dark green
  const BORDER = [66, 66, 66, 255];  // dark gray

  function blend(px, py, color, a) {
    if (px < 0 || py < 0 || px >= size || py >= size || a <= 0) return;
    const idx = (py * size + px) * 4;
    const bg_a = pixels[idx + 3] / 255;
    const out_a = a + bg_a * (1 - a);
    if (out_a === 0) return;
    pixels[idx + 0] = Math.round((color[0] * a + pixels[idx + 0] * bg_a * (1 - a)) / out_a);
    pixels[idx + 1] = Math.round((color[1] * a + pixels[idx + 1] * bg_a * (1 - a)) / out_a);
    pixels[idx + 2] = Math.round((color[2] * a + pixels[idx + 2] * bg_a * (1 - a)) / out_a);
    pixels[idx + 3] = Math.round(out_a * 255);
  }

  // Rounded-square background
  const radius = Math.round(size * 0.2);
  const cx = size / 2;
  const cy = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(0, Math.abs(x - cx) - (size / 2 - radius - 0.5));
      const dy = Math.max(0, Math.abs(y - cy) - (size / 2 - radius - 0.5));
      const dist = Math.sqrt(dx * dx + dy * dy) - radius;
      const alpha = Math.max(0, Math.min(1, 0.5 - dist));
      blend(x, y, BG, alpha);
    }
  }

  // Checkbox-style border, inset from the rounded-square edge
  const borderStroke = Math.max(1, size * 0.045);
  const borderInset = borderStroke * 0.7;
  const borderRadius = radius - borderInset;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(0, Math.abs(x - cx) - (size / 2 - radius - 0.5 - borderInset));
      const dy = Math.max(0, Math.abs(y - cy) - (size / 2 - radius - 0.5 - borderInset));
      const dist = Math.sqrt(dx * dx + dy * dy) - borderRadius;
      const a = Math.max(0, Math.min(1, borderStroke / 2 - Math.abs(dist)));
      blend(x, y, BORDER, a);
    }
  }

  function drawLine(x0, y0, x1, y1, stroke, color) {
    const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2) + 1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const lx = x0 + (x1 - x0) * t;
      const ly = y0 + (y1 - y0) * t;
      for (let py = Math.floor(ly - stroke); py <= Math.ceil(ly + stroke); py++) {
        for (let px = Math.floor(lx - stroke); px <= Math.ceil(lx + stroke); px++) {
          const d = Math.sqrt((px - lx) ** 2 + (py - ly) ** 2) - stroke / 2;
          const a = Math.max(0, Math.min(1, 0.5 - d));
          blend(px, py, color, a);
        }
      }
    }
  }

  function drawCircle(ccx, ccy, r, color) {
    for (let py = Math.floor(ccy - r - 1); py <= Math.ceil(ccy + r + 1); py++) {
      for (let px = Math.floor(ccx - r - 1); px <= Math.ceil(ccx + r + 1); px++) {
        const d = Math.sqrt((px - ccx) ** 2 + (py - ccy) ** 2) - r;
        const a = Math.max(0, Math.min(1, 0.5 - d));
        blend(px, py, color, a);
      }
    }
  }

  const stroke = Math.max(1, size * 0.05);
  const r = size * 0.1;
  const p1 = [size * 0.28, size * 0.5];
  const p2 = [size * 0.44, size * 0.68];
  const p3 = [size * 0.74, size * 0.32];

  drawLine(p1[0], p1[1], p2[0], p2[1], stroke, EDGE);
  drawLine(p2[0], p2[1], p3[0], p3[1], stroke, EDGE);
  drawCircle(p1[0], p1[1], r, ACCENT);
  drawCircle(p2[0], p2[1], r, ACCENT);
  drawCircle(p3[0], p3[1], r * 1.15, ACCENT);

  return encodePNG(size, size, pixels);
}

for (const size of [16, 48, 128]) {
  const buf = renderIcon(size);
  const outPath = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(outPath, buf);
  console.log(`Wrote ${outPath}`);
}
