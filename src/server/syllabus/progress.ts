/**
 * Syllabus progress derivation — pure derivation over the append-only event
 * log plus `content`/`items`/`writings`, same "surfaces are interfaces over
 * the log" posture as `src/server/scheduler.ts`/`src/server/mastery.ts`. No
 * "current unit" state is ever stored: it's always replayed from the latest
 * `syllabus_advanced` event, falling back to a config-derived default.
 */
import { and, desc, eq, inArray, like } from "drizzle-orm";
import type { Db } from "@/db";
import { events, writings } from "@/db/schema";
import { DEFAULT_USER_ID, newId } from "@/lib/ids";
import { SyllabusAdvancedPayloadSchema, type SyllabusAdvancedPayload } from "@/lib/contracts";
import { RUNGS, type MasteryBand, type Rung } from "@/lib/taxonomy";
import { deriveItemMastery } from "@/server/mastery";
import { getContentBySyllabusRef, getItemsBySyllabusRef } from "@/server/repo";
import { getSyllabusLevels, getUnit } from "@/server/syllabus/config";
import type { SyllabusLevel, SyllabusUnit } from "@/lib/contracts";

/** Thrown by {@link recordAdvance} when `level`/`unit` doesn't match any config-defined syllabus unit. */
export class UnknownSyllabusUnitError extends Error {
  constructor(level: string, unit: string) {
    super(`Unknown syllabus unit: level "${level}", unit "${unit}" — check config/syllabus/*.json`);
    this.name = "UnknownSyllabusUnitError";
  }
}

export type ActiveUnit = { level: string; unit: string };

/** The first unit (in config order) of `level` with at least one ingested section, or undefined if none has been. */
function firstIngestedUnit(db: Db, level: SyllabusLevel): SyllabusUnit | undefined {
  return level.units.find((unit) =>
    unit.sections.some((section) => getContentBySyllabusRef(db, `${level.id}/${unit.id}/${section.id}`) !== undefined),
  );
}

/**
 * True when any section of `level` has already been ingested (a `content`
 * row exists under its `syllabusRef` prefix) — same underlying check
 * {@link getActiveUnit} uses to find the first ingested level, exposed
 * separately so the Plan UI can annotate every configured level's ingested
 * state, not just the currently active one.
 */
export function isLevelIngested(db: Db, level: SyllabusLevel): boolean {
  return firstIngestedUnit(db, level) !== undefined;
}

/**
 * The learner's current syllabus unit: replays the latest `syllabus_advanced`
 * event (a malformed payload is skipped defensively, same posture as
 * `buildLearnerBlock`'s handling of malformed `produced_error` payloads —
 * see `src/server/learner.ts`). With no such event yet, falls back to the
 * first ingested unit ({@link firstIngestedUnit}) of the lowest-id syllabus
 * level that has any ingested content — i.e. the first level actually
 * ingested (via `npm run ingest-book` or the Plan page's ingest form).
 * Returns null when no level has been ingested at all (syllabus not started).
 */
export function getActiveUnit(db: Db): ActiveUnit | null {
  const advancedEvents = db
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.userId, DEFAULT_USER_ID), eq(events.type, "syllabus_advanced")))
    .orderBy(desc(events.createdAt))
    .limit(1)
    .all();

  if (advancedEvents.length > 0) {
    const parsed = SyllabusAdvancedPayloadSchema.safeParse(advancedEvents[0].payload);
    if (parsed.success) return { level: parsed.data.level, unit: parsed.data.unit };
  }

  const levels = [...getSyllabusLevels()].sort((a, b) => a.id.localeCompare(b.id));
  for (const level of levels) {
    const unit = firstIngestedUnit(db, level);
    if (unit) return { level: level.id, unit: unit.id };
  }

  return null;
}

/**
 * Appends a `syllabus_advanced` event — the learner explicitly moving on to
 * a new unit. Validates `level`/`unit` against the loaded config first
 * (throws {@link UnknownSyllabusUnitError} rather than logging an
 * unrecoverable event, since `events` is append-only — see CLAUDE.md Sec.3).
 * A single insert, same idiom as `recordReview` in `src/server/repo.ts`: no
 * read-modify-write, "current unit" is never stored, only replayed.
 */
export function recordAdvance(db: Db, level: string, unit: string): { eventId: string } {
  if (!getUnit(level, unit)) {
    throw new UnknownSyllabusUnitError(level, unit);
  }

  const eventId = newId();
  const payload: SyllabusAdvancedPayload = { level, unit };
  db.insert(events)
    .values({
      id: eventId,
      userId: DEFAULT_USER_ID,
      type: "syllabus_advanced",
      surface: "read",
      payload,
      createdAt: new Date(),
    })
    .run();
  return { eventId };
}

/** The task-string prefix a Fix writing must start with to count as evidence for a given tarea — see {@link getUnitEvidence}. */
export function tareaTaskPrefix(levelId: string, unitId: string, tareaId: string): string {
  return `syllabus:${levelId}/${unitId}/${tareaId}:`;
}

/** One construction's evidence: its seeded item (if any) and that item's current mastery band. */
export type ConstructionEvidence = {
  constructionId: string;
  chunk: string;
  description: string;
  itemId: string | null;
  /** null only if the construction was never seeded as an item (shouldn't happen post-ingestion — defensive). */
  band: MasteryBand | null;
};

/** One tarea's evidence: how many Fix writings were submitted against it, and the judged rung distribution across all their sentences. */
export type TareaEvidence = {
  tareaId: string;
  prompt: string;
  writingsCount: number;
  rungDistribution: Record<Rung, number>;
};

/** One section's evidence: its ingested content row (if any) and how many of its extracted candidates have a keep/discard decision. */
export type SectionEvidence = {
  sectionId: string;
  title: string;
  contentId: string | null;
  decidedCount: number;
  candidateCount: number;
};

/** Full evidence for one syllabus unit — the typed shape a future UI wave renders a unit's progress from. */
export type UnitEvidence = {
  levelId: string;
  unitId: string;
  title: string;
  constructions: ConstructionEvidence[];
  tareas: TareaEvidence[];
  sections: SectionEvidence[];
};

function emptyRungDistribution(): Record<Rung, number> {
  return Object.fromEntries(RUNGS.map((rung) => [rung, 0])) as Record<Rung, number>;
}

/**
 * Derives one unit's full evidence, per-construction/per-tarea/per-section —
 * see {@link ConstructionEvidence}/{@link TareaEvidence}/{@link SectionEvidence}.
 * Returns null if `levelId`/`unitId` doesn't match a config-defined unit.
 * Pure derivation: no state stored anywhere beyond what's already in
 * `content`/`items`/`writings`/`events`.
 */
export function getUnitEvidence(db: Db, levelId: string, unitId: string): UnitEvidence | null {
  const unit = getUnit(levelId, unitId);
  if (!unit) return null;

  const unitSyllabusRef = `${levelId}/${unitId}`;
  const itemByChunk = new Map(getItemsBySyllabusRef(db, unitSyllabusRef).map((item) => [item.chunk, item]));
  const bandByItemId = new Map(deriveItemMastery(db).map((entry) => [entry.item.id, entry.band]));

  const constructions: ConstructionEvidence[] = unit.constructions.map((construction) => {
    const item = itemByChunk.get(construction.chunk);
    return {
      constructionId: construction.id,
      chunk: construction.chunk,
      description: construction.description,
      itemId: item?.id ?? null,
      band: item ? (bandByItemId.get(item.id) ?? null) : null,
    };
  });

  const tareas: TareaEvidence[] = unit.tareas.map((tarea) => {
    const prefix = tareaTaskPrefix(levelId, unitId, tarea.id);
    const rows = db
      .select()
      .from(writings)
      .where(and(eq(writings.userId, DEFAULT_USER_ID), like(writings.task, `${prefix}%`)))
      .all();

    const rungDistribution = emptyRungDistribution();
    for (const row of rows) {
      if (!row.judgment) continue;
      for (const sentence of row.judgment.sentences) {
        rungDistribution[sentence.rung]++;
      }
    }

    return { tareaId: tarea.id, prompt: tarea.prompt, writingsCount: rows.length, rungDistribution };
  });

  const sections: SectionEvidence[] = unit.sections.map((section) => {
    const contentRow = getContentBySyllabusRef(db, `${levelId}/${unitId}/${section.id}`);
    if (!contentRow) {
      return { sectionId: section.id, title: section.title, contentId: null, decidedCount: 0, candidateCount: 0 };
    }

    const decisionRows = db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.contentId, contentRow.id),
          eq(events.userId, DEFAULT_USER_ID),
          inArray(events.type, ["captured", "discarded"]),
        ),
      )
      .all();

    return {
      sectionId: section.id,
      title: section.title,
      contentId: contentRow.id,
      decidedCount: decisionRows.length,
      candidateCount: contentRow.extraction?.result.candidates.length ?? 0,
    };
  });

  return { levelId, unitId, title: unit.title, constructions, tareas, sections };
}
