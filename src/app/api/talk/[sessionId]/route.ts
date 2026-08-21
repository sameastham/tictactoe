import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { getSession } from "@/server/repo";
import { getTalkTurns } from "@/server/talk";

/** A talk session plus its full turn transcript, oldest turn first. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await params;
    const db = getDb();

    const session = getSession(db, sessionId);
    if (!session || session.surface !== "talk") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const turns = getTalkTurns(db, sessionId);

    return NextResponse.json({
      session: {
        id: session.id,
        topic: session.topic,
        startedAt: session.startedAt.toISOString(),
        endedAt: session.endedAt ? session.endedAt.toISOString() : null,
      },
      turns: turns.map((turn) => ({ role: turn.role, text: turn.text, createdAt: turn.createdAt.toISOString() })),
    });
  } catch (error) {
    console.error("GET /api/talk/[sessionId] failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
