import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { extractPdfText, PdfExtractError, PDF_MAX_BYTES } from "@/server/pdf";

/** Thrown by {@link fetchArticle} when a URL can't be turned into a readable article. */
export class ArticleFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ArticleFetchError";
  }
}

const FETCH_TIMEOUT_MS = 10_000;

// A realistic desktop browser UA — some sites serve stripped-down markup
// (or block outright) to obvious bot/script user agents.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Exported so the multipart PDF-upload branch (POST /api/content) applies the same floor. */
export const MIN_ARTICLE_LENGTH = 200;

function isHtmlContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml";
}

function isPdfContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  return type === "application/pdf";
}

const PDF_MAGIC = Buffer.from("%PDF-", "latin1");

/** True when `buf` starts with the `%PDF-` signature every PDF file begins with. */
function looksLikePdf(buf: Buffer): boolean {
  return buf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

/**
 * Reads a fetch `Response` body into a `Buffer`, rejecting (before or after
 * the read, whichever catches it first) anything over `capBytes`. Used only
 * by the PDF branch of {@link fetchArticle} — the HTML branch keeps its
 * original, uncapped `response.text()` read untouched.
 */
async function readCappedBuffer(response: Response, capBytes: number): Promise<Buffer> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > capBytes) {
    throw new ArticleFetchError("el PDF supera el tamaño máximo permitido (20 MB)", 413);
  }
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > capBytes) {
    throw new ArticleFetchError("el PDF supera el tamaño máximo permitido (20 MB)", 413);
  }
  return Buffer.from(arrayBuffer);
}

/** Runs a PDF buffer through {@link extractPdfText}, applying the same {@link MIN_ARTICLE_LENGTH} floor the HTML path uses. */
async function extractPdfArticle(buf: Buffer): Promise<{ title: string | null; text: string; truncated: boolean }> {
  let extracted: Awaited<ReturnType<typeof extractPdfText>>;
  try {
    extracted = await extractPdfText(buf);
  } catch (error) {
    if (error instanceof PdfExtractError) {
      throw new ArticleFetchError(error.message, error.status);
    }
    throw error;
  }

  if (extracted.text.trim().length < MIN_ARTICLE_LENGTH) {
    throw new ArticleFetchError("could not extract a readable article from this URL", 422);
  }

  return { title: extracted.title, text: extracted.text, truncated: extracted.truncated };
}

/**
 * Fetches a URL, extracts its main article content via Readability, and
 * returns the cleaned title/text. Throws {@link ArticleFetchError} for any
 * failure, with a `status` telling the API route what to respond with.
 * `truncated` is `true` only for a PDF URL whose OCR fallback
 * ({@link extractPdfText}) hit the {@link import("@/server/pdf").PDF_OCR_MAX_PAGES}
 * cap — always `false` for the HTML path.
 */
export async function fetchArticle(url: string): Promise<{ title: string | null; text: string; truncated: boolean }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ArticleFetchError(`invalid URL: ${url}`, 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ArticleFetchError(`unsupported URL scheme: ${parsed.protocol}`, 400);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ArticleFetchError(`failed to fetch article: ${message}`, 502);
  }

  if (!response.ok) {
    throw new ArticleFetchError(`failed to fetch article: HTTP ${response.status}`, 502);
  }

  const contentType = response.headers.get("content-type");

  if (isPdfContentType(contentType)) {
    const buf = await readCappedBuffer(response, PDF_MAX_BYTES);
    return extractPdfArticle(buf);
  }

  if (isHtmlContentType(contentType)) {
    const html = await response.text();
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();

    const textContent = article?.textContent ?? "";
    if (!article || textContent.trim().length < MIN_ARTICLE_LENGTH) {
      throw new ArticleFetchError("could not extract a readable article from this URL", 422);
    }

    return { title: article.title ?? null, text: cleanText(textContent), truncated: false };
  }

  // Content-type didn't say PDF, but some servers mislabel PDFs (e.g.
  // application/octet-stream) — if the URL itself looks like one, sniff the
  // body's magic bytes before giving up.
  if (parsed.pathname.toLowerCase().endsWith(".pdf")) {
    const buf = await readCappedBuffer(response, PDF_MAX_BYTES);
    if (looksLikePdf(buf)) {
      return extractPdfArticle(buf);
    }
  }

  throw new ArticleFetchError("URL did not return an HTML page", 422);
}

/**
 * Normalizes raw extracted/pasted text: CRLF -> LF, trims each line's
 * trailing/leading whitespace, collapses runs of spaces/tabs within a line
 * to one space, collapses 3+ consecutive newlines down to exactly 2 (so
 * paragraph breaks survive as blank lines), and trims the whole string.
 */
function cleanText(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim());
  const collapsed = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  return collapsed.trim();
}

/** Normalizes a raw pasted-text submission the same way {@link fetchArticle} normalizes article text. */
export function normalizePaste(text: string): string {
  return cleanText(text);
}
