import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { getContent } from "@/server/repo";
import { ListenClient } from "@/app/listen/[id]/listen-client";

export default async function ListenDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const row = getContent(db, id);
  // "video" rows (YouTube ingests via src/server/mediafetch/) are Listen
  // surface content too — both types carry a mediaPath and drive the same
  // dictation flow, they just differ in provenance.
  if (!row || (row.type !== "audio" && row.type !== "video")) {
    notFound();
  }

  return (
    <ListenClient contentId={row.id} title={row.title} initialTranscribed={row.transcript !== null} />
  );
}
