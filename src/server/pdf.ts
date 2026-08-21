import path from "node:path";
import { extractText, getDocumentProxy, getMeta, renderPageAsImage } from "unpdf";
import { createWorker, OEM } from "tesseract.js";

/**
 * Thrown by {@link extractPdfText} when a PDF can't be turned into usable
 * text (encrypted, image-only/scanned, corrupt, too large, or too many
 * pages). `status` is the HTTP status the caller should respond with —
 * mirrors {@link import("@/server/article").ArticleFetchError} and
 * {@link import("@/server/mediafetch").MediaFetchError}.
 */
export class PdfExtractError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PdfExtractError";
  }
}

/** Upload/fetch size cap shared by the multipart and URL-fetch PDF paths. */
export const PDF_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

/** Page-count cap — a PDF beyond this is rejected rather than partially processed. */
export const PDF_MAX_PAGES = 100;

/** Below this, cleaned text is treated as effectively empty (encrypted/image-only/junk PDF). */
const MIN_EXTRACTED_TEXT_LENGTH = 40;

/**
 * Below this many characters of RAW (pre-`cleanPdfText`) text across the
 * whole document, the embedded text layer is treated as absent/negligible —
 * a scanned page with a stray OCR-artifact character or two from a prior
 * pass, a watermark, a page number — and {@link extractPdfText} falls back
 * to OCR instead of returning that scrap. Comfortably above
 * `MIN_EXTRACTED_TEXT_LENGTH` (which is the floor applied to the *cleaned*
 * result of whichever path — text-layer or OCR — actually ran) and
 * comfortably below what even a single short paragraph of real body text
 * extracts to.
 */
const OCR_TRIGGER_MAX_RAW_CHARS = 200;

/** OCR processes at most this many pages; beyond it, the rest are skipped and `truncated: true` is returned. */
export const PDF_OCR_MAX_PAGES = 20;

/**
 * Rasterization scale passed to `unpdf`'s `renderPageAsImage` for the OCR
 * path — a PDF page's default viewport is 72 DPI, so `2.5` renders at ~180
 * DPI, comfortably inside the ~150-200 DPI band Tesseract needs to reliably
 * keep Spanish diacritics (á é í ó ú ü ñ) intact. Verified empirically
 * against fixtures/escaneo-es-mx.pdf (see src/server/pdf.test.ts) — lower
 * scales occasionally dropped or mangled accents, this one didn't.
 */
const OCR_RENDER_SCALE = 2.5;

/** Local directory holding the vendored Tesseract language data — see vendor/tessdata/README.md. */
const TESSDATA_DIR = path.join(process.cwd(), "vendor", "tessdata");

const NOT_EXTRACTABLE_MESSAGE = "el PDF no contiene texto extraíble";
const NOT_EXTRACTABLE_EVEN_WITH_OCR_MESSAGE = "el PDF no contiene texto extraíble, ni siquiera con OCR";

/** Junk `Title` metadata values we don't want to surface as a content title. */
const JUNK_TITLE_PATTERNS = [
  /\.(docx?|pdf|rtf|odt|pages)$/i,
  /^(untitled|sin\s*t[ií]tulo|documento\s*\d*|document\s*\d*|new\s*document)$/i,
  /^microsoft\s+word\s*-/i,
];

/** True when `title` is present and doesn't look like filesystem/producer junk. */
function isUsableTitle(title: string | null | undefined): title is string {
  if (!title) return false;
  const trimmed = title.trim();
  if (trimmed.length === 0) return false;
  return !JUNK_TITLE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Options accepted by {@link extractPdfText}. */
export type ExtractPdfTextOptions = {
  /**
   * Whether to fall back to OCR (tesseract.js, vendored Spanish
   * `tessdata_fast` data — see vendor/tessdata/README.md) when the PDF's
   * embedded text layer is absent or negligible. Default `true`. Passing
   * `false` restores the pre-OCR behavior: such a PDF throws
   * {@link PdfExtractError} immediately, without attempting OCR — used by
   * tests to exercise the text-layer-only path deterministically.
   */
  ocr?: boolean;
};

/** Result of {@link extractPdfText}. */
export type ExtractPdfTextResult = {
  title: string | null;
  text: string;
  /** `true` when the text came from OCR (no usable embedded text layer), `false` when it came from the PDF's own text layer. */
  ocr: boolean;
  /** `true` when OCR ran but the document had more than {@link PDF_OCR_MAX_PAGES} pages — only the first `PDF_OCR_MAX_PAGES` were processed. Always `false` when `ocr` is `false`. */
  truncated: boolean;
};

/**
 * Extracts title/text from a PDF buffer via `unpdf` (a serverless build of
 * PDF.js — see module doc comment at the bottom of this file for why it was
 * chosen). Throws {@link PdfExtractError} for anything that isn't a normal,
 * text-bearing (or, with OCR, scanned/image-only) PDF within the size/page
 * caps.
 *
 * When the embedded text layer is absent or negligible (raw extracted text
 * under {@link OCR_TRIGGER_MAX_RAW_CHARS} across the whole document — the
 * scanned-textbook case), falls back to OCR (tesseract.js, Spanish
 * `tessdata_fast`, one worker reused across pages) instead of throwing,
 * unless `options.ocr` is explicitly `false`.
 */
export async function extractPdfText(buf: Buffer, options: ExtractPdfTextOptions = {}): Promise<ExtractPdfTextResult> {
  const ocrEnabled = options.ocr ?? true;
  if (buf.length === 0) {
    throw new PdfExtractError(NOT_EXTRACTABLE_MESSAGE, 422);
  }
  if (buf.length > PDF_MAX_BYTES) {
    throw new PdfExtractError("el PDF supera el tamaño máximo permitido (20 MB)", 413);
  }

  // Copy (not a view over `buf`'s ArrayBuffer): PDF.js's internal fake-worker
  // message-passing can transfer/detach the underlying buffer, and callers
  // shouldn't have to worry about `buf` becoming unusable after this call.
  const data = new Uint8Array(buf);

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(data);
  } catch {
    // Covers encrypted PDFs (PasswordException), corrupt/non-PDF buffers
    // (InvalidPDFException), and anything else PDF.js refuses to open.
    throw new PdfExtractError(NOT_EXTRACTABLE_MESSAGE, 422);
  }

  if (pdf.numPages > PDF_MAX_PAGES) {
    throw new PdfExtractError(`el PDF tiene demasiadas páginas (máx. ${PDF_MAX_PAGES})`, 422);
  }

  let title: string | null = null;
  try {
    const meta = await getMeta(pdf);
    const rawTitle = typeof meta.info?.Title === "string" ? meta.info.Title : null;
    title = isUsableTitle(rawTitle) ? rawTitle.trim() : null;
  } catch {
    title = null;
  }

  let pages: string[];
  try {
    const result = await extractText(pdf, { mergePages: false });
    pages = result.text;
  } catch {
    throw new PdfExtractError(NOT_EXTRACTABLE_MESSAGE, 422);
  }

  // Page boundaries become paragraph breaks — safer than merging pages with
  // a single "\n" (which cleanPdfText would then join with a space,
  // potentially splicing a footer straight into the next page's first line).
  const raw = pages.join("\n\n");

  if (raw.trim().length >= OCR_TRIGGER_MAX_RAW_CHARS) {
    // Normal, text-bearing PDF — the path this function has always taken.
    const text = cleanPdfText(raw);
    if (text.length < MIN_EXTRACTED_TEXT_LENGTH) {
      throw new PdfExtractError(NOT_EXTRACTABLE_MESSAGE, 422);
    }
    return { title, text, ocr: false, truncated: false };
  }

  // Negligible/absent text layer — the scanned-textbook case.
  if (!ocrEnabled) {
    throw new PdfExtractError(NOT_EXTRACTABLE_MESSAGE, 422);
  }

  const pageCount = pdf.numPages;
  const ocrPageCount = Math.min(pageCount, PDF_OCR_MAX_PAGES);
  const truncated = pageCount > PDF_OCR_MAX_PAGES;

  let ocrPages: string[];
  try {
    ocrPages = await ocrPdfPages(pdf, ocrPageCount);
  } catch (error) {
    console.error("extractPdfText: OCR pass failed", error);
    throw new PdfExtractError(NOT_EXTRACTABLE_EVEN_WITH_OCR_MESSAGE, 422);
  }

  const text = cleanPdfText(ocrPages.join("\n\n"));
  if (text.length < MIN_EXTRACTED_TEXT_LENGTH) {
    // A scan of photos/blank pages with no recognizable text — OCR ran but
    // found nothing usable either.
    throw new PdfExtractError(NOT_EXTRACTABLE_EVEN_WITH_OCR_MESSAGE, 422);
  }

  return { title, text, ocr: true, truncated };
}

/**
 * Rasterizes and OCRs `numPages` pages (1-indexed, 1..`numPages`) of `pdf`
 * with a single tesseract.js worker reused across pages (spinning one up
 * per page would repeat the WASM-core + language-data load every time).
 * Spanish language data loads from {@link TESSDATA_DIR} — see
 * vendor/tessdata/README.md — never a network fetch. The worker is always
 * terminated, success or failure.
 */
async function ocrPdfPages(pdf: Awaited<ReturnType<typeof getDocumentProxy>>, numPages: number): Promise<string[]> {
  const worker = await createWorker("spa", OEM.LSTM_ONLY, {
    langPath: TESSDATA_DIR,
    // Skip tesseract.js's on-disk cache of the decompressed traineddata
    // (defaults to writing `./spa.traineddata` into process.cwd() on first
    // use) — the vendored .gz is small enough to gunzip on every worker
    // start, and this avoids a stray multi-MB file appearing in the repo
    // root/deployment dir.
    cacheMethod: "none",
    gzip: true,
  });

  try {
    const texts: string[] = [];
    for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
      const png = await renderPageAsImage(pdf, pageNumber, {
        canvasImport: () => import("@napi-rs/canvas"),
        scale: OCR_RENDER_SCALE,
      });
      const { data } = await worker.recognize(Buffer.from(png));
      texts.push(data.text);
    }
    return texts;
  } finally {
    await worker.terminate();
  }
}

// -----------------------------------------------------------------------------
// cleanPdfText
// -----------------------------------------------------------------------------

/** A line that is nothing but a page number, in the handful of shapes real documents use. */
const PAGE_NUMBER_LINE = /^[\s\-–—]*(?:p[aá]gina|page)?\s*\d{1,4}(?:\s*(?:de|of|\/)\s*\d{1,4})?[\s\-–—]*$/i;

/** A furniture line has to repeat at least this many times to be dropped as a header/footer. */
const FURNITURE_MIN_REPEATS = 3;

/** A non-blank line indented at least this many columns past the paragraph's own start counts as an "indent jump" — a new paragraph. */
const INDENT_JUMP_COLUMNS = 3;

/**
 * Removes lines that are pure page-number furniture ("12", "Página 12",
 * "- 12 -", "Page 12 of 40", …).
 */
function dropPageNumberLines(lines: string[]): string[] {
  return lines.filter((line) => !PAGE_NUMBER_LINE.test(line.trim()));
}

/**
 * Removes lines whose trimmed text repeats verbatim `FURNITURE_MIN_REPEATS`+
 * times across the whole document — running headers/footers ("SECRETARÍA DE
 * EDUCACIÓN PÚBLICA" on every page, etc.). Blank lines are left alone (they
 * carry paragraph-break information, not furniture).
 */
function dropRepeatedHeaderFooterLines(lines: string[]): string[] {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  return lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return true;
    return (counts.get(trimmed) ?? 0) < FURNITURE_MIN_REPEATS;
  });
}

/**
 * De-hyphenates line-wrap hyphens: "palabra-\ncontinuación" ->
 * "palabracontinuación". Only fires when the hyphen is the last character of
 * a line AND the next line starts (after any leading spaces) with a
 * lowercase letter — the signal that a single word was split across the
 * wrap, not a real hyphen that happened to fall at a line break (e.g.
 * "México-\nEstados Unidos", where the next line starts uppercase, is left
 * alone and falls through to the ordinary newline-to-space join instead).
 */
function dehyphenate(text: string): string {
  return text.replace(/([A-Za-zÀ-ÖØ-öø-ÿ])-\n[ \t]*(?=[a-zà-öø-ÿ])/g, "$1");
}

/** Leading-whitespace column count of a raw (untrimmed) line, tabs counted as one column each. */
function leadingColumns(line: string): number {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].length : 0;
}

/**
 * Groups cleaned lines into paragraphs: a blank line always starts a new
 * paragraph; a non-blank line indented `INDENT_JUMP_COLUMNS`+ columns more
 * than the paragraph-in-progress's own first line also starts a new one
 * (catches PDFs that mark a new paragraph with a first-line indent instead
 * of a blank line between paragraphs). Lines within one paragraph are joined
 * with a single space.
 */
function groupParagraphs(lines: string[]): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let currentIndent = 0;

  function flush(): void {
    if (current.length > 0) {
      paragraphs.push(current.join(" "));
    }
    current = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      flush();
      continue;
    }

    const indent = leadingColumns(line);
    const isIndentJump = current.length > 0 && indent >= currentIndent + INDENT_JUMP_COLUMNS;
    if (isIndentJump) {
      flush();
    }
    if (current.length === 0) {
      currentIndent = indent;
    }
    current.push(trimmed);
  }
  flush();

  return paragraphs;
}

/**
 * Cleans raw PDF-extracted text into prose that reads like
 * `normalizePaste`/`fetchArticle` output: de-hyphenates line-wrap
 * hyphenation, joins hard line breaks within a paragraph into spaces, turns
 * blank lines and first-line indents into paragraph breaks (`\n\n`),
 * collapses repeated whitespace, and drops page-number/repeated
 * header-footer furniture. Pure and deterministic — no PDF parsing here,
 * just string cleanup, so it's unit-testable independent of `unpdf`.
 */
export function cleanPdfText(raw: string): string {
  const normalized = raw.replace(/\r\n?/g, "\n");

  let lines = normalized.split("\n");
  lines = dropPageNumberLines(lines);
  lines = dropRepeatedHeaderFooterLines(lines);

  const dehyphenated = dehyphenate(lines.join("\n"));

  const paragraphs = groupParagraphs(dehyphenated.split("\n")).map((p) => p.replace(/[ \t]+/g, " ").trim());

  return paragraphs
    .filter((p) => p.length > 0)
    .join("\n\n")
    .trim();
}

// -----------------------------------------------------------------------------
// Library choice
// -----------------------------------------------------------------------------
//
// `unpdf` (a serverless build of Mozilla's PDF.js) was chosen for text
// extraction over `pdf-parse` (whose current major version pulls in
// `@napi-rs/canvas` unconditionally, even when all you want is text) and
// over reaching for `pdfjs-dist` directly (unpdf already wraps it with sane
// Node.js defaults — disableFontFace, standard font/CMap data — and its own
// bundling work already solves the "no separate worker file in a bundled
// server runtime" problem `pdfjs-dist`'s legacy build would leave to us).
// Text extraction itself still has no native dependency; `@napi-rs/canvas`
// only enters the picture for the OCR path below, where unpdf's own
// `renderPageAsImage` requires it in Node.js (see its `canvasImport` option).
//
// -----------------------------------------------------------------------------
// OCR engine choice
// -----------------------------------------------------------------------------
//
// `tesseract.js` (WASM, via the vendored `tesseract.js-core` WASM binaries
// it depends on) was chosen over shelling out to a native `tesseract` CLI or
// a hosted OCR API: no system dependency to install on the deployment target
// (a 2019 Intel MacBook Pro, no Apple Silicon — CLAUDE.md Sec.6) and no
// network call at OCR time, matching the vendored-language-data,
// no-CDN-fetch posture the rest of this module already has. It runs in a
// `worker_threads` worker (not a child process) — `createWorker`'s Node
// implementation (`tesseract.js/src/worker/node/`) spawns one and resolves
// its worker-script path via `__dirname` inside its own package directory,
// which only resolves correctly if webpack/turbopack leave the package
// unbundled — hence `tesseract.js` (and `@napi-rs/canvas`, for the same
// "resolve relative to its own package dir at runtime" reason) in
// `serverExternalPackages` (next.config.ts). Verified end-to-end — including
// the OCR path — against both `next dev` and a production `next build` +
// `npm start` server (see src/server/pdf.test.ts and e2e/read-pdf.spec.ts).
//
// Spanish language data (`vendor/tessdata/spa.traineddata.gz`, the
// `tessdata_fast` variant — see vendor/tessdata/README.md for origin and
// license) is loaded from local disk via `langPath`; left unset, tesseract.js
// defaults to fetching it from the jsdelivr CDN on first use, which this
// module deliberately avoids.
