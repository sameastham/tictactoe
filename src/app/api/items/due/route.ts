import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { getDueItems } from "@/server/scheduler";

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
 * Items currently due for review, priority-ordered by the Review scheduler
 * (`getDueItems` — see `src/server/scheduler.ts`). Consumed by Fix's Reto
 * composer (due items are offered before recent ones) and available for any
 * other surface that wants to prompt with due chunks.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseLimit(searchParams);
    const db = getDb();
    const items = getDueItems(db, limit);
    return NextResponse.json({ items });
  } catch (error) {
    console.error("GET /api/items/due failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
