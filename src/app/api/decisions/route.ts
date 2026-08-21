import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { DecisionBodySchema } from "@/lib/contracts";
import { AlreadyDecidedError, getContent, recordDecision } from "@/server/repo";

export async function POST(request: NextRequest) {
  try {
    const parsed = DecisionBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_body", issues: z.treeifyError(parsed.error) }, { status: 400 });
    }
    const { contentId, candidateId, action } = parsed.data;

    const db = getDb();
    const row = getContent(db, contentId);
    if (!row) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (!row.extraction) {
      return NextResponse.json({ error: "not_extracted" }, { status: 409 });
    }

    const candidate = row.extraction.result.candidates.find((c) => c.id === candidateId);
    if (!candidate) {
      return NextResponse.json({ error: "unknown_candidate" }, { status: 404 });
    }

    const { itemId } = recordDecision(db, {
      contentId,
      candidateId,
      action,
      candidate,
      promptVersion: row.extraction.promptVersion,
    });

    return NextResponse.json({ itemId }, { status: 201 });
  } catch (error) {
    if (error instanceof AlreadyDecidedError) {
      return NextResponse.json({ error: "already_decided" }, { status: 409 });
    }
    console.error("POST /api/decisions failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
