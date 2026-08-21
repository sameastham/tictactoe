import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { buildSegments } from "@/lib/segments";
import { getContent } from "@/server/repo";

/**
 * GET /api/content/[id]/segments — derives dictation segments from the
 * content row's stored `wordTimestamps` via `buildSegments`. 409 if the
 * content hasn't been transcribed yet.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    const row = getContent(db, id);
    if (!row) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (!row.wordTimestamps) {
      return NextResponse.json({ error: "not_transcribed" }, { status: 409 });
    }

    const segments = buildSegments(row.wordTimestamps);
    return NextResponse.json({ segments });
  } catch (error) {
    console.error("GET /api/content/[id]/segments failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
