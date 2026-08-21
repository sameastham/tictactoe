// Writes fixtures/escaneo-es-mx.pdf: the same article as
// fixtures/article-es-mx.txt, rendered as a *scanned* PDF — each page is a
// full-page raster PNG (drawn with @napi-rs/canvas, the same canvas library
// src/server/pdf.ts uses at runtime to rasterize pages for OCR) embedded via
// pdf-lib with no text layer at all. This exercises the OCR fallback in
// extractPdfText end to end: a real scanned-textbook-style PDF, not a
// hand-typed string.
//
// Sibling to scripts/make-fixture-pdf.mjs (which produces a PDF WITH a text
// layer, hand-wrapped to exercise cleanPdfText's de-hyphenation). This script
// deliberately never calls page.drawText — pdf-lib only emits a text
// operator when you ask it to, so a page built purely from page.drawImage
// has no extractable text, which is exactly the "scanned/image-only PDF"
// case OCR needs to handle.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(__dirname, "..", "fixtures", "article-es-mx.txt");
const OUT_PATH = path.join(__dirname, "..", "fixtures", "escaneo-es-mx.pdf");

// Page raster: US Letter at 200 DPI — comfortably above the ~150-200 DPI
// tesseract needs for clean Spanish-accent recognition (verified empirically
// against this exact fixture in src/server/pdf.test.ts).
const DPI = 200;
const PAGE_WIDTH_PT = 612; // US Letter, points (72pt/in)
const PAGE_HEIGHT_PT = 792;
const PAGE_WIDTH_PX = Math.round((PAGE_WIDTH_PT * DPI) / 72);
const PAGE_HEIGHT_PX = Math.round((PAGE_HEIGHT_PT * DPI) / 72);
const MARGIN_PX = Math.round(0.75 * DPI);
const FONT_SIZE_PX = 34;
const LINE_HEIGHT_PX = 48;
const PARAGRAPH_GAP_PX = 24;
const FONT = `${FONT_SIZE_PX}px "DejaVu Sans", "Liberation Sans", sans-serif`;

/** Greedy word-wrap using real measured text width (not a character count). */
function wrapParagraph(ctx, text, maxWidthPx) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length > 0 ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidthPx && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/** Renders one page's paragraphs onto a fresh canvas, returns a PNG buffer. */
function renderPage(paragraphs) {
  const canvas = createCanvas(PAGE_WIDTH_PX, PAGE_HEIGHT_PX);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, PAGE_WIDTH_PX, PAGE_HEIGHT_PX);
  ctx.fillStyle = "black";
  ctx.font = FONT;
  ctx.textBaseline = "alphabetic";

  const maxWidth = PAGE_WIDTH_PX - 2 * MARGIN_PX;
  let y = MARGIN_PX + FONT_SIZE_PX;
  for (const paragraph of paragraphs) {
    const lines = wrapParagraph(ctx, paragraph, maxWidth);
    for (const line of lines) {
      if (y > PAGE_HEIGHT_PX - MARGIN_PX) {
        throw new Error("make-fixture-scanned-pdf: paragraph overflowed the page — shorten the article or raise page height");
      }
      ctx.fillText(line, MARGIN_PX, y);
      y += LINE_HEIGHT_PX;
    }
    y += PARAGRAPH_GAP_PX;
  }

  return canvas.toBuffer("image/png");
}

async function main() {
  const raw = fs.readFileSync(SRC_PATH, "utf-8");
  const paragraphs = raw
    .trim()
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim());

  if (paragraphs.length < 2) {
    throw new Error("make-fixture-scanned-pdf: expected at least 2 paragraphs to split across 2 pages");
  }

  // Split roughly in half across 2 pages.
  const mid = Math.ceil(paragraphs.length / 2);
  const pages = [paragraphs.slice(0, mid), paragraphs.slice(mid)];

  const doc = await PDFDocument.create();
  // Deliberately distinct from both the seeded article's title and the
  // text-layer PDF fixture's title (make-fixture-pdf.mjs) so e2e specs can
  // tell all three home-page cards apart.
  doc.setTitle("Café de especialidad (escaneo de prueba)");
  doc.setLanguage("es-MX");
  doc.setAuthor("Español Coach fixtures");

  for (const paragraphsOnPage of pages) {
    const pngBytes = renderPage(paragraphsOnPage);
    const png = await doc.embedPng(pngBytes);
    const page = doc.addPage([PAGE_WIDTH_PT, PAGE_HEIGHT_PT]);
    // Full-bleed image, scaled from its native raster size down to the
    // page's point dimensions — a real scanner's output, no text operators.
    page.drawImage(png, { x: 0, y: 0, width: PAGE_WIDTH_PT, height: PAGE_HEIGHT_PT });
  }

  const bytes = await doc.save();
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, bytes);
  console.log(`wrote ${path.relative(process.cwd(), OUT_PATH)} — ${bytes.length} bytes, ${pages.length} pages`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
