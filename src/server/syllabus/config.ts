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

/**
 * Optional second directory of syllabus level JSON files, merged in
 * alongside `config/syllabus/` when `SYLLABUS_EXTRA_CONFIG_DIR` is set —
 * lets `e2e/plan-flow.spec.ts` exercise the full Plan UI against a tiny fake
 * level (`e2e/fixtures/plan-level.json`, matching `fixtures/libro-falso.pdf`)
 * without ever committing a fake level under `config/syllabus/` itself,
 * which would otherwise leak into every normal dev/production run's level
 * listing. Unset (and therefore a no-op) everywhere except the e2e
 * `webServer`'s own env — see `playwright.config.ts`.
 *
 * The `turbopackIgnore` comment below opts this env-dependent path out of
 * Turbopack's build-time file tracing (it would otherwise treat the whole
 * project as a dependency of this module, since it can't statically resolve
 * a `process.env`-derived path) — safe here because this directory is never
 * read outside the e2e `webServer` process, never part of the deployed
 * build's actual runtime.
 */
const EXTRA_SYLLABUS_CONFIG_DIR = process.env.SYLLABUS_EXTRA_CONFIG_DIR
  ? path.resolve(/* turbopackIgnore: true */ process.cwd(), process.env.SYLLABUS_EXTRA_CONFIG_DIR)
  : undefined;

let cachedLevels: SyllabusLevel[] | undefined;

/** Reads and validates every `*.json` file directly inside `dir` against `SyllabusLevelSchema`. */
function loadLevelsFromDir(dir: string): SyllabusLevel[] {
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  return files.map((name) => {
    const raw = fs.readFileSync(path.join(dir, name), "utf-8");
    try {
      return SyllabusLevelSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new Error(`getSyllabusLevels: invalid syllabus config ${name}: ${error}`);
    }
  });
}

/**
 * Reads and validates every `config/syllabus/*.json` file (plus, when set,
 * `SYLLABUS_EXTRA_CONFIG_DIR`'s own `*.json` files — see above), caching the
 * parsed result (same posture as `loadLearnerConfig` in
 * `src/server/learner.ts`). Throws (via `SyllabusLevelSchema.parse`) if a
 * config file doesn't match the schema — a malformed curriculum config is a
 * build-time/startup error, not something to silently skip.
 */
export function getSyllabusLevels(): SyllabusLevel[] {
  if (!cachedLevels) {
    cachedLevels = loadLevelsFromDir(SYLLABUS_CONFIG_DIR);
    if (EXTRA_SYLLABUS_CONFIG_DIR) {
      cachedLevels = [...cachedLevels, ...loadLevelsFromDir(EXTRA_SYLLABUS_CONFIG_DIR)];
    }
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

/** The level/unit pair immediately after `levelId`/`unitId` in curriculum order — used by the Plan UI's "advance" flow. */
export type NextUnit = { level: string; unit: string };

/**
 * The unit immediately after `levelId`/`unitId` in curriculum order: the
 * next unit within the same level, or the first unit of the next level (by
 * id, ascending — same ordering `getActiveUnit`'s fallback in
 * `src/server/syllabus/progress.ts` uses) when `unitId` is that level's last
 * unit. Returns null when `levelId`/`unitId` doesn't resolve to a real unit,
 * or when it's the last unit of the last level — nothing left to advance to.
 */
export function getNextUnit(levelId: string, unitId: string): NextUnit | null {
  const levels = [...getSyllabusLevels()].sort((a, b) => a.id.localeCompare(b.id));
  const levelIndex = levels.findIndex((level) => level.id === levelId);
  if (levelIndex === -1) return null;

  const level = levels[levelIndex];
  const unitIndex = level.units.findIndex((unit) => unit.id === unitId);
  if (unitIndex === -1) return null;

  if (unitIndex + 1 < level.units.length) {
    return { level: level.id, unit: level.units[unitIndex + 1].id };
  }
  const nextLevel = levels[levelIndex + 1];
  return nextLevel ? { level: nextLevel.id, unit: nextLevel.units[0].id } : null;
}
