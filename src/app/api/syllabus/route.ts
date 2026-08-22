import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getSyllabusLevels } from "@/server/syllabus/config";
import { getActiveUnit, getUnitEvidence } from "@/server/syllabus/progress";

/**
 * The syllabus state a client component needs: every configured level's
 * headline info, the learner's current active unit (if any), and that
 * unit's full evidence (constructions/tareas/sections). The Plan page and
 * home page read the underlying modules directly (server components, per
 * house pattern) — this route exists for the client-side bits that can't:
 * `FixComposer`'s Reto item pool (see `src/components/FixComposer.tsx`).
 */
export async function GET() {
  try {
    const db = getDb();
    const levels = getSyllabusLevels().map((level) => ({ id: level.id, name: level.name, cefr: level.cefr }));
    const active = getActiveUnit(db);
    const evidence = active ? getUnitEvidence(db, active.level, active.unit) : null;
    return NextResponse.json({ levels, active, evidence });
  } catch (error) {
    console.error("GET /api/syllabus failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
