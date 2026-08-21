import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { getContent } from "@/server/repo";
import { ListenClient } from "@/app/listen/[id]/listen-client";

export default async function ListenDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const row = getContent(db, id);
  if (!row || row.type !== "audio") {
    notFound();
  }

  return (
    <ListenClient contentId={row.id} title={row.title} initialTranscribed={row.transcript !== null} />
  );
}
