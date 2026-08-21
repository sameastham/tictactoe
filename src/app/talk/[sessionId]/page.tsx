import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { getItemsByIds, getSession } from "@/server/repo";
import { getTalkReport, getTalkTurns } from "@/server/talk";
import { TalkClient } from "@/app/talk/[sessionId]/talk-client";

export default async function TalkSessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const db = getDb();

  const session = getSession(db, sessionId);
  if (!session || session.surface !== "talk") {
    notFound();
  }

  const turns = getTalkTurns(db, sessionId).map((turn) => ({
    role: turn.role,
    text: turn.text,
    createdAt: turn.createdAt.toISOString(),
  }));

  // Ended sessions load their report straight away (server-side, no model
  // call — `getTalkReport` only ever reads what `endTalk` already stored)
  // so a session visited again later renders its report immediately rather
  // than flashing the chat view first.
  const report = session.endedAt ? getTalkReport(db, sessionId) : null;

  const itemIds = report ? [...report.itemsUsed, ...report.itemsAvoided] : [];
  const itemRows = getItemsByIds(db, Array.from(new Set(itemIds)));
  const chunksById = Object.fromEntries(itemRows.map((item) => [item.id, item.chunk]));

  return (
    <TalkClient
      sessionId={sessionId}
      topic={session.topic}
      initialTurns={turns}
      initialEnded={session.endedAt !== null}
      initialReport={report}
      chunksById={chunksById}
    />
  );
}
