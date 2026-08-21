import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { DictationAttemptBodySchema } from "@/lib/contracts";
import { diffDictation } from "@/lib/dictation";
import { buildSegments } from "@/lib/segments";
import { newId } from "@/lib/ids";
import { getContent, recordDictationAttempt } from "@/server/repo";

/**
 * POST /api/dictation — submits one dictation attempt: diffs `typed` against
 * the target segment's transcript text, classifies each miss, records the
 * event-log consequences (see `recordDictationAttempt`), and returns the
 * diff tokens + misses for the UI to render.
 */
export async function POST(request: NextRequest) {
  try {
    const parsed = DictationAttemptBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_body", issues: z.treeifyError(parsed.error) }, { status: 400 });
    }
    const { contentId, segmentIndex, typed } = parsed.data;

    const db = getDb();
    const row = getContent(db, contentId);
    if (!row) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (!row.wordTimestamps) {
      return NextResponse.json({ error: "not_transcribed" }, { status: 409 });
    }

    const segments = buildSegments(row.wordTimestamps);
    const segment = segments[segmentIndex];
    if (!segment) {
      return NextResponse.json({ error: "invalid_segment_index", segmentCount: segments.length }, { status: 400 });
    }

    const { tokens, misses } = diffDictation(segment.text, typed);
    const attemptId = newId();

    recordDictationAttempt(db, {
      contentId,
      segmentIndex,
      segmentText: segment.text,
      misses,
      attemptId,
    });

    return NextResponse.json({ attemptId, tokens, misses }, { status: 201 });
  } catch (error) {
    console.error("POST /api/dictation failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
