import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { listRecentItems } from "@/server/repo";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function parseLimit(searchParams: URLSearchParams): number {
  const raw = searchParams.get("limit");
  if (raw === null) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(parsed)));
}

/**
 * Recent items (id, chunk, register, createdAt) — lets the Fix surface's
 * prompted-write mode offer target items before the FSRS scheduler (and its
 * `GET /api/items?due=`) exists.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseLimit(searchParams);
    const db = getDb();
    const rows = listRecentItems(db, limit);
    return NextResponse.json({
      items: rows.map((row) => ({
        id: row.id,
        chunk: row.chunk,
        register: row.register,
        createdAt: row.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("GET /api/items/recent failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
