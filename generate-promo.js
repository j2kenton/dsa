#!/usr/bin/env node
// Generates the Chrome Web Store promo tiles for "Algo Coach":
//   store-assets/promo-1.png        440 x 280  (small promo tile)
//   store-assets/promo-marquee.png  1400 x 560 (marquee promo tile)
// Both share the green solved-path icon + wordmark. Rendered via Puppeteer.

const path = require("path");
const puppeteer = require("puppeteer");

const BG = "#202233";

// Icon recreated as SVG to match generate-icons.js exactly (viewBox 0..100):
//   rounded white tile, dark-gray checkbox border, green "solved path".
function iconSVG(size) {
  return `
<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="100" height="100" rx="20" fill="#ffffff"/>
  <rect x="3.15" y="3.15" width="93.7" height="93.7" rx="16.85"
        fill="none" stroke="#424242" stroke-width="4.5"/>
  <g fill="none" stroke="#1b5e20" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M28 50 L44 68 L74 32"/>
  </g>
  <g fill="#34a853">
    <circle cx="28" cy="50" r="10"/>
    <circle cx="44" cy="68" r="10"/>
    <circle cx="74" cy="32" r="11.5"/>
  </g>
</svg>`;
}

function buildHTML({ W, H, gap, iconSize, wordSize, tagSize, tagGap }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; }
  body {
    background: ${BG};
    display: flex;
    align-items: center;
    justify-content: center;
    gap: ${gap}px;
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
  }
  .icon { display: flex; }
  .word { color: #f4f6fb; line-height: 1.05; }
  .word .algo  { font-size: ${wordSize}px; font-weight: 700; letter-spacing: -0.5px; }
  .word .coach { font-size: ${wordSize}px; font-weight: 700; letter-spacing: -0.5px; color: #34a853; }
  .word .tag {
    margin-top: ${tagGap}px;
    font-size: ${tagSize}px;
    font-weight: 500;
    color: #9aa3b8;
    letter-spacing: 0.2px;
    white-space: nowrap;
  }
</style></head>
<body>
  <div class="icon">${iconSVG(iconSize)}</div>
  <div class="word">
    <div class="algo">Algo</div>
    <div class="coach">Coach</div>
    <div class="tag">Your AI coding-interview coach</div>
  </div>
</body></html>`;
}

const TILES = [
  {
    file: "promo-1.png",
    W: 440,
    H: 280,
    gap: 34,
    iconSize: 150,
    wordSize: 58,
    tagSize: 16,
    tagGap: 16,
  },
  {
    file: "promo-marquee.png",
    W: 1400,
    H: 560,
    gap: 90,
    iconSize: 320,
    wordSize: 128,
    tagSize: 34,
    tagGap: 34,
  },
];

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--force-device-scale-factor=1"],
  });
  for (const t of TILES) {
    const page = await browser.newPage();
    await page.setViewport({ width: t.W, height: t.H, deviceScaleFactor: 1 });
    await page.setContent(buildHTML(t), { waitUntil: "networkidle0" });
    const outPath = path.join(__dirname, "store-assets", t.file);
    await page.screenshot({
      path: outPath,
      clip: { x: 0, y: 0, width: t.W, height: t.H },
    });
    await page.close();
    console.log(`Wrote ${outPath} (${t.W}x${t.H})`);
  }
  await browser.close();
})();
