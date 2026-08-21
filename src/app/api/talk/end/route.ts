import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { TalkEndBodySchema } from "@/lib/contracts";
import { ProviderError } from "@/server/language/providers/provider";
import { getLanguageService } from "@/server/language/service";
import { endTalk, TalkSessionEndedError, TalkSessionNotFoundError } from "@/server/talk";

/**
 * Ends a Talk session and runs the (single) post-session judgment. Not
 * idempotent by design: a session that's already ended returns 409 rather
 * than silently recomputing — `GET /api/talk/[sessionId]/report` is the
 * re-derive-without-recomputing path for a session visited again later.
 */
export async function POST(request: NextRequest) {
  try {
    const parsed = TalkEndBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_body", issues: z.treeifyError(parsed.error) }, { status: 400 });
    }
    const { sessionId } = parsed.data;
    const db = getDb();

    const report = await endTalk(db, sessionId, getLanguageService());
    return NextResponse.json({ report }, { status: 200 });
  } catch (error) {
    if (error instanceof TalkSessionNotFoundError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (error instanceof TalkSessionEndedError) {
      return NextResponse.json({ error: "already_ended" }, { status: 409 });
    }
    if (error instanceof ProviderError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error("POST /api/talk/end failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
