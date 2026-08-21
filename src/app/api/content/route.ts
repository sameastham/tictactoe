import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { CreateContentBodySchema } from "@/lib/contracts";
import { ArticleFetchError, fetchArticle, MIN_ARTICLE_LENGTH, normalizePaste } from "@/server/article";
import { extractPdfText, PdfExtractError, PDF_MAX_BYTES } from "@/server/pdf";
import { createContent, listContent, type ContentListItem, type ContentRow } from "@/server/repo";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** Narrow DTO returned for a freshly created content row. */
function toSummaryDto(row: ContentRow) {
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    type: row.type,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Serializes a listContent row for JSON: Date -> ISO string, everything else passed through. */
function toListDto(row: ContentListItem) {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

function parseLimit(searchParams: URLSearchParams): number {
  const raw = searchParams.get("limit");
  if (raw === null) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(parsed)));
}

/**
 * Handles the multipart branch of `POST /api/content`: uploads a PDF for the
 * Read surface, extracting its text via `extractPdfText`/`cleanPdfText`
 * (src/server/pdf.ts) and creating a `content` row (source "upload", type
 * "article") — same shape and status as the URL/paste branches below, just a
 * different way of getting text onto a content row. Mirrors
 * POST /api/media's `handleUpload` multipart idiom.
 */
async function handlePdfUpload(request: NextRequest): Promise<NextResponse> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid_form_data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing_file" }, { status: 400 });
  }
  if (file.type !== "application/pdf") {
    return NextResponse.json({ error: "unsupported_media_type", contentType: file.type }, { status: 400 });
  }
  if (file.size > PDF_MAX_BYTES) {
    return NextResponse.json({ error: "file_too_large", maxBytes: PDF_MAX_BYTES }, { status: 413 });
  }

  const titleRaw = formData.get("title");
  const titleOverride = typeof titleRaw === "string" && titleRaw.trim().length > 0 ? titleRaw.trim() : null;

  const buf = Buffer.from(await file.arrayBuffer());

  let extracted: { title: string | null; text: string };
  try {
    extracted = await extractPdfText(buf);
  } catch (error) {
    if (error instanceof PdfExtractError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  // Same readability floor the URL/HTML path applies (see MIN_ARTICLE_LENGTH
  // in src/server/article.ts) — a technically-extracted but tiny PDF (a
  // cover page, a mostly-blank form) isn't worth turning into content.
  if (extracted.text.trim().length < MIN_ARTICLE_LENGTH) {
    return NextResponse.json({ error: "el PDF no contiene texto extraíble" }, { status: 422 });
  }

  const db = getDb();
  const created = createContent(db, {
    source: "upload",
    type: "article",
    title: titleOverride ?? extracted.title,
    text: extracted.text,
  });

  return NextResponse.json({ content: toSummaryDto(created) }, { status: 201 });
}

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return await handlePdfUpload(request);
    }

    const parsed = CreateContentBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_body", issues: z.treeifyError(parsed.error) }, { status: 400 });
    }
    const body = parsed.data;
    const db = getDb();

    let created: ContentRow;
    if ("url" in body) {
      const { title, text } = await fetchArticle(body.url);
      created = createContent(db, { source: "url", sourceUrl: body.url, type: "article", title, text });
    } else {
      created = createContent(db, {
        source: "paste",
        type: "paste",
        title: body.title,
        text: normalizePaste(body.text),
      });
    }

    return NextResponse.json({ content: toSummaryDto(created) }, { status: 201 });
  } catch (error) {
    if (error instanceof ArticleFetchError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof PdfExtractError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("POST /api/content failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseLimit(searchParams);
    const db = getDb();
    const rows = listContent(db, limit);
    return NextResponse.json({ contents: rows.map(toListDto) });
  } catch (error) {
    console.error("GET /api/content failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
