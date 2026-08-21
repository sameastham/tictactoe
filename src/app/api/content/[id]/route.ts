import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { getContent, getDecisions } from "@/server/repo";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    const row = getContent(db, id);
    if (!row) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const decisions = getDecisions(db, id);

    return NextResponse.json({
      content: { ...row, createdAt: row.createdAt.toISOString() },
      decisions,
    });
  } catch (error) {
    console.error("GET /api/content/[id] failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
