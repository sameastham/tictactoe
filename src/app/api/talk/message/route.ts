import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { TalkMessageBodySchema, type ConverseInput } from "@/lib/contracts";
import { ProviderError } from "@/server/language/providers/provider";
import { getLanguageService } from "@/server/language/service";
import { buildLearnerBlock } from "@/server/learner";
import {
  getOpenTalkSession,
  getTalkTurns,
  recordLearnerTurn,
  recordTutorTurn,
  TalkSessionEndedError,
  TalkSessionNotFoundError,
} from "@/server/talk";

/**
 * Sends one learner message in an open Talk session and returns the
 * tutor's reply — no correction, no evaluation, just the next conversational
 * turn (`converse` over the full turn history so far). The learner's turn is
 * recorded before the model call, so a `ProviderError` below (-> 502) still
 * leaves it persisted; only the tutor's reply is missing.
 */
export async function POST(request: NextRequest) {
  try {
    const parsed = TalkMessageBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_body", issues: z.treeifyError(parsed.error) }, { status: 400 });
    }
    const { sessionId, text, meta } = parsed.data;
    const db = getDb();
    const session = getOpenTalkSession(db, sessionId);

    recordLearnerTurn(db, sessionId, text, meta ?? null);

    const turns = getTalkTurns(db, sessionId);
    const messages: ConverseInput["messages"] = turns.map((turn) => ({ role: turn.role, text: turn.text }));
    const learner = buildLearnerBlock(db);

    const { result } = await getLanguageService().converse({ topic: session.topic ?? "", messages }, learner);
    recordTutorTurn(db, sessionId, result.reply);

    return NextResponse.json({ reply: result.reply }, { status: 201 });
  } catch (error) {
    if (error instanceof TalkSessionNotFoundError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (error instanceof TalkSessionEndedError) {
      return NextResponse.json({ error: "ended" }, { status: 409 });
    }
    if (error instanceof ProviderError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error("POST /api/talk/message failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
