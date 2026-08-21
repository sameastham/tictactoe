import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { getContent, getDecisions } from "@/server/repo";
import { ReadClient } from "@/app/read/[id]/read-client";

export default async function ReadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const row = getContent(db, id);
  if (!row) {
    notFound();
  }

  const decisions = getDecisions(db, id);

  return (
    <ReadClient
      contentId={row.id}
      title={row.title}
      text={row.text}
      initialExtraction={row.extraction}
      initialDecisions={decisions}
    />
  );
}
