import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { getTalkReport, TalkSessionNotEndedError, TalkSessionNotFoundError } from "@/server/talk";

/**
 * Re-derives a Talk session's report from its already-stored writing/
 * judgment — no model call, safe to hit repeatedly. The path a learner
 * returning to an already-ended session takes (see `TalkClient`'s initial
 * load and `POST /api/talk/end`'s 409 "already_ended" recovery).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await params;
    const db = getDb();
    const report = getTalkReport(db, sessionId);
    return NextResponse.json({ report });
  } catch (error) {
    if (error instanceof TalkSessionNotFoundError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (error instanceof TalkSessionNotEndedError) {
      return NextResponse.json({ error: "not_ended" }, { status: 409 });
    }
    console.error("GET /api/talk/[sessionId]/report failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
