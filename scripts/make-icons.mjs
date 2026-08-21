// Renders the app's PWA icons (a rounded-square teal tile with a bold white
// "Ñ") to PNG via a headless Chromium tab. Re-run with `node
// scripts/make-icons.mjs` any time the mark or palette changes.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "public");

const ACCENT = "#0e766a";
const GLYPH = "#ffffff";

/** Builds the SVG markup for one icon variant. */
function svgIcon({ maskable }) {
  const size = 512;
  const bg = maskable
    ? `<rect width="${size}" height="${size}" fill="${ACCENT}" />`
    : `<rect width="${size}" height="${size}" rx="112" ry="112" fill="${ACCENT}" />`;
  // Maskable icons must keep all meaningful content inside the ~80%-diameter
  // "safe zone" circle centered on the tile, since the OS may crop the
  // square to a circle/squircle/rounded-square without warning.
  const glyphSize = maskable ? 220 : 320;
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${bg}
  <text
    x="50%"
    y="53%"
    text-anchor="middle"
    dominant-baseline="middle"
    font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
    font-weight="700"
    font-size="${glyphSize}"
    fill="${GLYPH}"
  >Ñ</text>
</svg>`.trim();
}

function htmlFor(svg, size) {
  return `<!doctype html>
<html><head><meta charset="utf-8" /><style>
  html,body{margin:0;padding:0;background:transparent;}
  svg{display:block;width:${size}px;height:${size}px;}
</style></head>
<body>${svg}</body></html>`;
}

async function renderPng(browser, { size, maskable, outFile }) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(htmlFor(svgIcon({ maskable }), size));
  await page.waitForTimeout(50); // let web-safe font metrics settle
  await page.screenshot({ path: outFile, omitBackground: false });
  await page.close();
  console.log(`wrote ${path.relative(process.cwd(), outFile)}`);
}

async function main() {
  const browser = await chromium.launch();
  try {
    await renderPng(browser, {
      size: 192,
      maskable: false,
      outFile: path.join(OUT_DIR, "icon-192.png"),
    });
    await renderPng(browser, {
      size: 512,
      maskable: false,
      outFile: path.join(OUT_DIR, "icon-512.png"),
    });
    await renderPng(browser, {
      size: 512,
      maskable: true,
      outFile: path.join(OUT_DIR, "icon-maskable-512.png"),
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
