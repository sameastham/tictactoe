import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { AdvanceSyllabusBodySchema } from "@/lib/contracts";
import { recordAdvance, UnknownSyllabusUnitError } from "@/server/syllabus/progress";

/**
 * Advances the learner's active syllabus unit to `{ level, unit }` — the
 * "Avanzar a la siguiente unidad" action on `/plan`. Validates against the
 * loaded config (via `recordAdvance`) before writing anything; an unknown
 * level/unit is a 400, not a crash.
 */
export async function POST(request: NextRequest) {
  try {
    const parsed = AdvanceSyllabusBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_body", issues: z.treeifyError(parsed.error) }, { status: 400 });
    }
    const { level, unit } = parsed.data;

    const db = getDb();
    const { eventId } = recordAdvance(db, level, unit);
    return NextResponse.json({ eventId }, { status: 201 });
  } catch (error) {
    if (error instanceof UnknownSyllabusUnitError) {
      return NextResponse.json({ error: "unknown_unit" }, { status: 400 });
    }
    console.error("POST /api/syllabus/advance failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
