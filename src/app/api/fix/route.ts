import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { FixBodySchema, type JudgeTargetItem } from "@/lib/contracts";
import { buildLearnerBlock } from "@/server/learner";
import { JUDGE_PROMPT_VERSION } from "@/server/language/prompts";
import { ProviderError } from "@/server/language/providers/provider";
import { getLanguageService } from "@/server/language/service";
import {
  createWriting,
  getItemsByIds,
  listWritings,
  recordJudgmentEvents,
  saveJudgment,
  type WritingRow,
} from "@/server/repo";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function parseLimit(searchParams: URLSearchParams): number {
  const raw = searchParams.get("limit");
  if (raw === null) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(parsed)));
}

/** Narrow DTO for the writings list: excerpt instead of full text, rung counts instead of the full judgment. */
function toListDto(row: WritingRow) {
  const rungCounts: Partial<Record<string, number>> = {};
  if (row.judgment) {
    for (const sentence of row.judgment.sentences) {
      rungCounts[sentence.rung] = (rungCounts[sentence.rung] ?? 0) + 1;
    }
  }
  return {
    id: row.id,
    task: row.task,
    excerpt: row.text.slice(0, 80),
    createdAt: row.createdAt.toISOString(),
    judged: row.judgment !== null,
    rungCounts,
  };
}

export async function POST(request: NextRequest) {
  try {
    const parsed = FixBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_body", issues: z.treeifyError(parsed.error) }, { status: 400 });
    }
    const { text, task, targetItemIds } = parsed.data;
    const db = getDb();

    // Unknown target item ids are silently dropped rather than rejected.
    const itemRows = getItemsByIds(db, targetItemIds ?? []);
    const targetItems: JudgeTargetItem[] = itemRows.map((row) => ({ id: row.id, chunk: row.chunk }));

    // The writing row is created before the model call so a ProviderError
    // below still leaves a persisted (unjudged) writing behind.
    const writing = createWriting(db, { task: task ?? null, text });

    const learner = buildLearnerBlock(db);

    const { result, model } = await getLanguageService().judge(
      { text, task: task ?? null, target_items: targetItems },
      learner,
    );

    saveJudgment(db, writing.id, result, JUDGE_PROMPT_VERSION, model);
    recordJudgmentEvents(db, { writingId: writing.id, judgment: result, targetItems, task: task ?? null });

    return NextResponse.json({ writingId: writing.id, judgment: result }, { status: 201 });
  } catch (error) {
    if (error instanceof ProviderError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error("POST /api/fix failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseLimit(searchParams);
    const db = getDb();
    const rows = listWritings(db, limit);
    return NextResponse.json({ writings: rows.map(toListDto) });
  } catch (error) {
    console.error("GET /api/fix failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
