import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { ProviderError } from "@/server/language/providers/provider";
import { getLanguageService } from "@/server/language/service";
import { startTalk } from "@/server/talk";

/**
 * Starts a new Talk session: no request body (the topic is server-seeded,
 * never client-chosen — see `TalkStartBodySchema`/`seedTopic`). Returns the
 * new session id, its seeded topic, and the tutor's opening line.
 */
export async function POST() {
  try {
    const db = getDb();
    const { sessionId, topic, opening } = await startTalk(db, getLanguageService());
    return NextResponse.json({ sessionId, topic, opening }, { status: 201 });
  } catch (error) {
    if (error instanceof ProviderError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error("POST /api/talk/start failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
