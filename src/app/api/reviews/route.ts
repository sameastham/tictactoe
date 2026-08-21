import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { ReviewBodySchema } from "@/lib/contracts";
import { getItemsByIds, recordReview } from "@/server/repo";

/**
 * Records one Repaso card answer: validates the item exists, then appends a
 * `reviewed` event (see `recordReview` in `src/server/repo.ts`). Scheduling
 * state itself is never written here — the next read of `/api/items/due` or
 * `/api/queue` replays this event back into an FSRS grade.
 */
export async function POST(request: NextRequest) {
  try {
    const parsed = ReviewBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_body", issues: z.treeifyError(parsed.error) }, { status: 400 });
    }
    const { itemId, rating } = parsed.data;

    const db = getDb();
    const [item] = getItemsByIds(db, [itemId]);
    if (!item) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    recordReview(db, { item, rating });

    return NextResponse.json({}, { status: 201 });
  } catch (error) {
    console.error("POST /api/reviews failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
