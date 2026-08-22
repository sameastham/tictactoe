/**
 * Loads and validates the curriculum config: every `config/syllabus/*.json`
 * file, each one a `SyllabusLevel` (see `src/lib/contracts.ts`). Today
 * there's exactly one, `dyh7.json` (Dicho y hecho 7, UNAM CEPE). Adding a
 * later level is a drop-in: add `config/syllabus/dyh8.json` shaped like
 * `SyllabusLevelSchema` and it's picked up automatically — nothing in this
 * file, `src/server/syllabus/ingest.ts`, or `src/server/syllabus/progress.ts`
 * hardcodes "dyh7" (the level id is always a parameter), so no other change
 * is needed beyond authoring the new config and, for ingestion, pointing
 * `scripts/ingest-book.ts` at the new level's source PDFs.
 *
 * Config files are structure/facts (unit and section titles, paraphrased
 * objectives, construction names/descriptions) mined from the physical book
 * by a human/agent reading it — never verbatim book prose, and never
 * generated at runtime. This module only loads and validates what's already
 * on disk; it makes no model calls (see CLAUDE.md Sec.3 — model calls are
 * gated to `src/server/language/`, none of which this module touches).
 */
import fs from "node:fs";
import path from "node:path";
import { SyllabusLevelSchema, type SyllabusLevel, type SyllabusUnit } from "@/lib/contracts";

const SYLLABUS_CONFIG_DIR = path.join(process.cwd(), "config", "syllabus");

let cachedLevels: SyllabusLevel[] | undefined;

/**
 * Reads and validates every `config/syllabus/*.json` file, caching the
 * parsed result (same posture as `loadLearnerConfig` in
 * `src/server/learner.ts`). Throws (via `SyllabusLevelSchema.parse`) if a
 * config file doesn't match the schema — a malformed curriculum config is a
 * build-time/startup error, not something to silently skip.
 */
export function getSyllabusLevels(): SyllabusLevel[] {
  if (!cachedLevels) {
    const files = fs
      .readdirSync(SYLLABUS_CONFIG_DIR)
      .filter((name) => name.endsWith(".json"))
      .sort();
    cachedLevels = files.map((name) => {
      const raw = fs.readFileSync(path.join(SYLLABUS_CONFIG_DIR, name), "utf-8");
      try {
        return SyllabusLevelSchema.parse(JSON.parse(raw));
      } catch (error) {
        throw new Error(`getSyllabusLevels: invalid syllabus config ${name}: ${error}`);
      }
    });
  }
  return cachedLevels;
}

/** Looks up one syllabus level by id (e.g. "dyh7"), or undefined if no config defines it. */
export function getLevel(id: string): SyllabusLevel | undefined {
  return getSyllabusLevels().find((level) => level.id === id);
}

/** Looks up one unit within a syllabus level, or undefined if the level or unit doesn't exist. */
export function getUnit(levelId: string, unitId: string): SyllabusUnit | undefined {
  return getLevel(levelId)?.units.find((unit) => unit.id === unitId);
}
