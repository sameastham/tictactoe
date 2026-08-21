import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { getWriting } from "@/server/repo";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    const row = getWriting(db, id);
    if (!row) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    return NextResponse.json({
      writing: {
        id: row.id,
        task: row.task,
        text: row.text,
        promptVersion: row.promptVersion,
        model: row.model,
        createdAt: row.createdAt.toISOString(),
      },
      judgment: row.judgment,
    });
  } catch (error) {
    console.error("GET /api/fix/[id] failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
