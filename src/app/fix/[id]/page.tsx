import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { getItemsByIds, getWriting } from "@/server/repo";
import { ResultClient } from "@/app/fix/[id]/result-client";

export default async function FixResultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const row = getWriting(db, id);
  if (!row) {
    notFound();
  }

  // The judgment only carries item *ids* (items_used/items_avoided) — resolve
  // them to display chunks here, server-side via the repo, rather than adding
  // a new API route just for this lookup.
  const itemIds = row.judgment ? [...row.judgment.items_used, ...row.judgment.items_avoided] : [];
  const itemRows = getItemsByIds(db, Array.from(new Set(itemIds)));
  const chunksById = Object.fromEntries(itemRows.map((item) => [item.id, item.chunk]));

  return (
    <ResultClient writingId={row.id} task={row.task} text={row.text} judgment={row.judgment} chunksById={chunksById} />
  );
}
