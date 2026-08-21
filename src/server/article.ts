import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

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

const MIN_ARTICLE_LENGTH = 200;

function isHtmlContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml";
}

/**
 * Fetches a URL, extracts its main article content via Readability, and
 * returns the cleaned title/text. Throws {@link ArticleFetchError} for any
 * failure, with a `status` telling the API route what to respond with.
 */
export async function fetchArticle(url: string): Promise<{ title: string | null; text: string }> {
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

  if (!isHtmlContentType(response.headers.get("content-type"))) {
    throw new ArticleFetchError("URL did not return an HTML page", 422);
  }

  const html = await response.text();
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();

  const textContent = article?.textContent ?? "";
  if (!article || textContent.trim().length < MIN_ARTICLE_LENGTH) {
    throw new ArticleFetchError("could not extract a readable article from this URL", 422);
  }

  return { title: article.title ?? null, text: cleanText(textContent) };
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
