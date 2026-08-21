import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { ListenProduceBodySchema } from "@/lib/contracts";
import { buildSegments } from "@/lib/segments";
import { buildLearnerBlock } from "@/server/learner";
import { JUDGE_PROMPT_VERSION } from "@/server/language/prompts";
import { ProviderError } from "@/server/language/providers/provider";
import { getLanguageService } from "@/server/language/service";
import { createWriting, getContent, recordJudgmentEvents, saveJudgment } from "@/server/repo";

/**
 * POST /api/listen/produce — the listening->production follow-up ("Ahora
 * dilo tú", plan §4.1): after attempting a dictation segment, the learner
 * reformulates what they heard in their own words. Judged exactly like a Fix
 * writing (same `judge` call, same `writings` row, same
 * `recordJudgmentEvents` event-log consequences) but tagged to its origin
 * segment (`task: "listen:reformula:<contentId>:<segmentIndex>"`) and
 * recorded with surface "listen" rather than "fix", so the event log
 * attributes this production to Listen, not Fix.
 *
 * Validates contentId/segmentIndex the same way POST /api/dictation does:
 * 404 if the content doesn't exist, 409 if it hasn't been transcribed yet,
 * 400 if segmentIndex is out of range for the transcript's segments.
 */
export async function POST(request: NextRequest) {
  try {
    const parsed = ListenProduceBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_body", issues: z.treeifyError(parsed.error) }, { status: 400 });
    }
    const { contentId, segmentIndex, text } = parsed.data;

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

    const task = `listen:reformula:${contentId}:${segmentIndex}`;

    // The writing row is created before the model call so a ProviderError
    // below still leaves a persisted (unjudged) writing behind — same
    // posture as POST /api/fix.
    const writing = createWriting(db, { task, text });

    const learner = buildLearnerBlock(db);
    const judgeTask = `Reformula con tus propias palabras lo que escuchaste: "${segment.text}"`;

    const { result, model } = await getLanguageService().judge(
      { text, task: judgeTask, target_items: [] },
      learner,
    );

    saveJudgment(db, writing.id, result, JUDGE_PROMPT_VERSION, model);
    recordJudgmentEvents(db, {
      writingId: writing.id,
      judgment: result,
      targetItems: [],
      task,
      surface: "listen",
    });

    return NextResponse.json({ writingId: writing.id, judgment: result }, { status: 201 });
  } catch (error) {
    if (error instanceof ProviderError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error("POST /api/listen/produce failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
