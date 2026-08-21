import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { CreateContentBodySchema } from "@/lib/contracts";
import { ArticleFetchError, fetchArticle, normalizePaste } from "@/server/article";
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

export async function POST(request: NextRequest) {
  try {
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
