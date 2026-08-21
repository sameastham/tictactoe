import { extractText, getDocumentProxy, getMeta } from "unpdf";

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

const NOT_EXTRACTABLE_MESSAGE = "el PDF no contiene texto extraíble";

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

/**
 * Extracts title/text from a PDF buffer via `unpdf` (a serverless build of
 * PDF.js — see module doc comment at the bottom of this file for why it was
 * chosen). Throws {@link PdfExtractError} for anything that isn't a normal,
 * text-bearing PDF within the size/page caps.
 */
export async function extractPdfText(buf: Buffer): Promise<{ title: string | null; text: string }> {
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
  const text = cleanPdfText(raw);

  if (text.length < MIN_EXTRACTED_TEXT_LENGTH) {
    throw new PdfExtractError(NOT_EXTRACTABLE_MESSAGE, 422);
  }

  return { title, text };
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
// `unpdf` (a serverless build of Mozilla's PDF.js, no canvas/native
// dependency) was chosen over `pdf-parse` (whose current major version pulls
// in `@napi-rs/canvas`, a native addon — unnecessary weight for text-only
// extraction and a worse fit for the plan's single-user, no-native-deps
// posture) and over reaching for `pdfjs-dist` directly (unpdf already wraps
// it with sane Node.js defaults — disableFontFace, standard font/CMap data —
// and its own bundling work already solves the "no separate worker file in a
// bundled server runtime" problem `pdfjs-dist`'s legacy build would leave to
// us). Verified end-to-end against the Next 16 server runtime (see
// src/server/pdf.test.ts and e2e/read-pdf.spec.ts) with no
// `serverExternalPackages` entry needed — unpdf has no native dependency for
// webpack/turbopack to trip over.
