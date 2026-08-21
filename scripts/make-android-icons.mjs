// Renders the Android launcher icons (legacy square, round, and adaptive
// foreground layers) for the Capacitor `android/` project, replacing every
// default Capacitor mipmap asset. Mirrors the app's own icon design
// (scripts/make-icons.mjs: a rounded-square teal tile with a bold white "Ñ")
// via a headless Chromium tab, same as that script.
//
// Re-run with `node scripts/make-android-icons.mjs` any time the mark or
// palette changes, or after `npx cap add android` regenerates the project.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RES_DIR = path.join(__dirname, "..", "android", "app", "src", "main", "res");

const ACCENT = "#0e766a";
const GLYPH = "#ffffff";

// Legacy (pre-Android-8) launcher icon sizes, 48dp @ each density bucket.
const LEGACY_SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
// Adaptive icon foreground/background layer sizes, 108dp @ each density bucket.
const ADAPTIVE_SIZES = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

/**
 * Builds SVG markup for one icon variant.
 *
 *  - "legacy": opaque rounded-square tile, used for ic_launcher.png.
 *  - "round": opaque circle tile (transparent outside the circle), used for
 *    ic_launcher_round.png.
 *  - "foreground": glyph only, fully transparent background, glyph confined
 *    to Android's adaptive-icon safe zone (~66% of the canvas, centered) so
 *    it survives circle/squircle/rounded-square masking on any launcher.
 */
function svgIcon(variant, size) {
  let bg = "";
  let glyphSize;
  if (variant === "legacy") {
    const r = Math.round(size * (112 / 512));
    bg = `<rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${ACCENT}" />`;
    glyphSize = size * (320 / 512);
  } else if (variant === "round") {
    bg = `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${ACCENT}" />`;
    glyphSize = size * (320 / 512);
  } else {
    // foreground: no background rect at all — stays transparent. Same
    // glyph-to-canvas ratio as the app's own maskable PWA icon
    // (public/icon-maskable-512.png: 220/512), which was already sized to
    // sit inside the standard safe zone.
    glyphSize = size * (220 / 512);
  }
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

async function renderPng(browser, { size, variant, outFile }) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(htmlFor(svgIcon(variant, size), size));
  await page.waitForTimeout(50); // let web-safe font metrics settle
  // omitBackground keeps everything outside the drawn shape transparent —
  // required for ic_launcher_round.png (corners outside the circle) and for
  // every ic_launcher_foreground.png (fully transparent canvas).
  await page.screenshot({ path: outFile, omitBackground: true });
  await page.close();
  console.log(`wrote ${path.relative(process.cwd(), outFile)}`);
}

async function main() {
  const browser = await chromium.launch();
  try {
    for (const [density, size] of Object.entries(LEGACY_SIZES)) {
      const dir = path.join(RES_DIR, `mipmap-${density}`);
      await renderPng(browser, {
        size,
        variant: "legacy",
        outFile: path.join(dir, "ic_launcher.png"),
      });
      await renderPng(browser, {
        size,
        variant: "round",
        outFile: path.join(dir, "ic_launcher_round.png"),
      });
    }
    for (const [density, size] of Object.entries(ADAPTIVE_SIZES)) {
      const dir = path.join(RES_DIR, `mipmap-${density}`);
      await renderPng(browser, {
        size,
        variant: "foreground",
        outFile: path.join(dir, "ic_launcher_foreground.png"),
      });
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
