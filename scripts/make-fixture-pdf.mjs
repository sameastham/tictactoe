// Writes fixtures/articulo-es-mx.pdf: the same article as
// fixtures/article-es-mx.txt, laid out as a hand-wrapped multi-page PDF (one
// paragraph per page) so its raw PDF.js text extraction contains genuine
// mid-sentence hard line breaks — plus, deliberately, at least one
// line-wrap hyphenation (a long word split across two lines with a trailing
// "-") — exercising src/server/pdf.ts's cleanPdfText for real rather than
// against a hand-typed test string. Uses pdf-lib (no auto text-wrapping, so
// every line break is one we chose) with the built-in Helvetica standard
// font, which — verified below and in src/server/pdf.test.ts — renders and
// round-trips Mexican Spanish diacritics (á é í ó ú ñ ¿ ¡ — WinAnsiEncoding
// covers Latin-1) without needing an embedded TTF.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(__dirname, "..", "fixtures", "article-es-mx.txt");
const OUT_PATH = path.join(__dirname, "..", "fixtures", "articulo-es-mx.pdf");

const WRAP_WIDTH = 58; // characters per line — comfortably fits a Letter page at 11pt Helvetica.
const FONT_SIZE = 11;
const LINE_HEIGHT = 16;
const PAGE_WIDTH = 612; // US Letter, points — SEP/gob.mx documents are typically Letter, not A4.
const PAGE_HEIGHT = 792;
const MARGIN = 72;

/** Greedy word-wrap: breaks only at spaces, never mid-word. */
function wrapParagraph(text, width) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length > 0 ? `${current} ${word}` : word;
    if (candidate.length > width && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

const PLAIN_WORD = /^[a-záéíóúüñ][a-záéíóúüñ]*$/;

/**
 * Finds the first line (across every paragraph, in order) whose last word is
 * a plain lowercase word of at least `minLen` characters, and splits that
 * word across the line break with a trailing hyphen — mutating `paragraphs`
 * in place. Returns the split word, or null if no eligible line was found
 * (the caller treats that as a fixture-generation error: the whole point of
 * this fixture is to exercise de-hyphenation).
 */
function forceOneHyphenatedWrap(paragraphs, minLen = 7) {
  for (const lines of paragraphs) {
    for (let i = 0; i < lines.length - 1; i++) {
      const words = lines[i].split(" ");
      const last = words[words.length - 1];
      if (PLAIN_WORD.test(last) && last.length >= minLen) {
        const splitAt = Math.ceil(last.length * 0.55);
        const head = last.slice(0, splitAt);
        const tail = last.slice(splitAt);
        words[words.length - 1] = `${head}-`;
        lines[i] = words.join(" ");
        lines[i + 1] = `${tail} ${lines[i + 1]}`;
        return { word: last, head, tail };
      }
    }
  }
  return null;
}

async function main() {
  const raw = fs.readFileSync(SRC_PATH, "utf-8");
  const paragraphs = raw
    .trim()
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim());

  const wrapped = paragraphs.map((p) => wrapParagraph(p, WRAP_WIDTH));

  const forced = forceOneHyphenatedWrap(wrapped);
  if (!forced) {
    throw new Error(
      "make-fixture-pdf: could not find an eligible word to hyphenate across a line wrap — " +
        "adjust WRAP_WIDTH or the source article so at least one line ends in a plain word >= 7 chars",
    );
  }
  console.log(`forced hyphenated wrap: "${forced.word}" -> "${forced.head}-" / "${forced.tail}"`);

  const doc = await PDFDocument.create();
  // Deliberately distinct from the seeded article's title ("El café de
  // especialidad en México", src/lib fixtures/seed) even though the body
  // text is the same article — e2e/read-pdf.spec.ts needs to tell the two
  // home-page cards apart.
  doc.setTitle("Café de especialidad (PDF de prueba)");
  doc.setLanguage("es-MX");
  doc.setAuthor("Español Coach fixtures");
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const available = PAGE_WIDTH - 2 * MARGIN;
  for (const lines of wrapped) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let y = PAGE_HEIGHT - MARGIN;
    for (const line of lines) {
      const width = font.widthOfTextAtSize(line, FONT_SIZE);
      if (width > available) {
        throw new Error(`make-fixture-pdf: line exceeds page width (${width.toFixed(1)} > ${available}): "${line}"`);
      }
      if (y < MARGIN) {
        throw new Error("make-fixture-pdf: paragraph overflowed one page — reduce WRAP_WIDTH or increase page height");
      }
      page.drawText(line, { x: MARGIN, y, size: FONT_SIZE, font, color: rgb(0, 0, 0) });
      y -= LINE_HEIGHT;
    }
  }

  const bytes = await doc.save();
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, bytes);
  console.log(`wrote ${path.relative(process.cwd(), OUT_PATH)} — ${bytes.length} bytes, ${wrapped.length} pages`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
