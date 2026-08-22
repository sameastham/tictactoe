import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { getItemsByIds } from "@/server/repo";

const MAX_IDS = 50;

/**
 * Resolves item ids to their display chunk text (and register) —
 * `?ids=a,b,c`. Backs TalkClient's credit chips: the Talk report page can
 * only compute `chunksById` server-side from whatever report existed at
 * initial page load, but ending a session happens client-side without a
 * navigation (see `POST /api/talk/end`), so a freshly-received report's item
 * ids need a client-side lookup instead of a stale server-rendered map.
 * `register` rides along for `FixComposer`'s syllabus-construction item
 * lookup (see `src/components/FixComposer.tsx`), which needs it to build a
 * Reto chip the same shape as its due/recent ones. Unknown ids are silently
 * dropped, same posture as `getItemsByIds` itself.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const raw = searchParams.get("ids") ?? "";
    const ids = raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
      .slice(0, MAX_IDS);

    const db = getDb();
    const rows = getItemsByIds(db, ids);
    return NextResponse.json({
      items: rows.map((row) => ({ id: row.id, chunk: row.chunk, register: row.register })),
    });
  } catch (error) {
    console.error("GET /api/items/by-ids failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
