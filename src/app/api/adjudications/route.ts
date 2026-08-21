import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { AdjudicationBodySchema } from "@/lib/contracts";
import {
  SentenceIndexOutOfRangeError,
  WritingNotJudgedError,
  getWriting,
  hasAdjudication,
  recordAdjudication,
} from "@/server/repo";

export async function POST(request: NextRequest) {
  try {
    const parsed = AdjudicationBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_body", issues: z.treeifyError(parsed.error) }, { status: 400 });
    }
    const { writingId, sentenceIndex, learnerRung, note } = parsed.data;
    const db = getDb();

    const writing = getWriting(db, writingId);
    if (!writing || !writing.judgment) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    if (hasAdjudication(db, writingId, sentenceIndex)) {
      return NextResponse.json({ error: "already_adjudicated" }, { status: 409 });
    }

    const { goldSetId } = recordAdjudication(db, {
      writingId,
      sentenceIndex,
      learnerRung,
      note: note ?? null,
    });

    return NextResponse.json({ goldSetId }, { status: 201 });
  } catch (error) {
    if (error instanceof WritingNotJudgedError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (error instanceof SentenceIndexOutOfRangeError) {
      return NextResponse.json({ error: "invalid_sentence_index" }, { status: 400 });
    }
    console.error("POST /api/adjudications failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
