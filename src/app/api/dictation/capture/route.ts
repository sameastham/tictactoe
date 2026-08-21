import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { CaptureMissBodySchema } from "@/lib/contracts";
import { buildSegments } from "@/lib/segments";
import { captureFromMiss, getContent } from "@/server/repo";

/**
 * POST /api/dictation/capture — turns a dictation miss into a captured item
 * with audio context (segment transcript as `origin_sentence`), mirroring
 * the Read surface's "keep" decision but sourced from Listen instead of a
 * model extraction (see `captureFromMiss`).
 */
export async function POST(request: NextRequest) {
  try {
    const parsed = CaptureMissBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_body", issues: z.treeifyError(parsed.error) }, { status: 400 });
    }
    const { contentId, segmentIndex, chunk } = parsed.data;

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

    const { itemId } = captureFromMiss(db, {
      contentId,
      segmentIndex,
      chunk,
      segmentText: segment.text,
    });

    return NextResponse.json({ itemId }, { status: 201 });
  } catch (error) {
    console.error("POST /api/dictation/capture failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
