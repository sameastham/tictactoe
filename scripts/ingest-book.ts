/**
 * Thin CLI over `ingestBook` (`src/server/syllabus/ingest.ts`): reads one or
 * more Dicho y hecho PDF parts from disk (in the order given — book part
 * order matters, see `ingestBook`'s doc comment), runs the full ingestion
 * pipeline against the app's DB, and prints a per-unit report table.
 *
 * Usage: `npm run ingest-book -- <pdfPath...> --level dyh7`
 *
 * `--config <path>` is an alternate way to name the level: it loads and
 * validates a `SyllabusLevel` JSON file directly from `path` instead of
 * looking `--level`'s id up in `config/syllabus/` (`getLevel`) — the level's
 * own `id` field is used, so `--level` is not needed alongside it. This
 * exists so `e2e/plan-flow.spec.ts` can ingest `fixtures/libro-falso.pdf`
 * against a tiny fake level (`e2e/fixtures/plan-level.json`) without that
 * fake level ever being committed under `config/syllabus/` itself (which
 * would otherwise leak into every normal dev/production level listing — see
 * `src/server/syllabus/config.ts`'s `SYLLABUS_EXTRA_CONFIG_DIR`). Small and
 * generally useful beyond that: it's also the natural way to dry-run a new
 * level's config against its PDFs before committing it to `config/syllabus/`.
 */
import fs from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getDb } from "@/db";
import { SyllabusLevelSchema, type SyllabusLevel } from "@/lib/contracts";
import { getLevel } from "@/server/syllabus/config";
import { ingestBook, type IngestReport } from "@/server/syllabus/ingest";

function parseArgs(argv: string[]): { pdfPaths: string[]; levelId?: string; configPath?: string } {
  const levelIndex = argv.indexOf("--level");
  const configIndex = argv.indexOf("--config");
  const levelId = levelIndex !== -1 ? argv[levelIndex + 1] : undefined;
  const configPath = configIndex !== -1 ? argv[configIndex + 1] : undefined;

  if (!configPath && (levelIndex === -1 || !levelId)) {
    throw new Error("ingest-book: missing --level <id> (e.g. --level dyh7) — or pass --config <path> instead");
  }

  const consumed = new Set<number>();
  if (levelIndex !== -1) {
    consumed.add(levelIndex);
    consumed.add(levelIndex + 1);
  }
  if (configIndex !== -1) {
    consumed.add(configIndex);
    consumed.add(configIndex + 1);
  }

  const pdfPaths = argv.filter((_arg, i) => !consumed.has(i));
  if (pdfPaths.length === 0) {
    throw new Error("ingest-book: no PDF paths given — usage: ingest-book <pdfPath...> --level <id> [--config <path>]");
  }
  return { pdfPaths, levelId, configPath };
}

/** Resolves the `SyllabusLevel` to ingest: from `--config <path>` directly, or via `--level <id>` and `getLevel`. */
function loadLevel(levelId: string | undefined, configPath: string | undefined): SyllabusLevel {
  if (configPath) {
    const raw = fs.readFileSync(path.resolve(process.cwd(), configPath), "utf-8");
    try {
      return SyllabusLevelSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new Error(`ingest-book: invalid --config file ${configPath}: ${error}`);
    }
  }
  const level = getLevel(levelId!);
  if (!level) {
    throw new Error(`ingest-book: unknown syllabus level "${levelId}" — check config/syllabus/*.json`);
  }
  return level;
}

function printReport(report: IngestReport): void {
  console.log(`\nsyllabus level: ${report.levelId}\n`);

  for (const unit of report.units) {
    console.log(`## ${unit.unitId} — ${unit.title}`);

    console.log("  sections:");
    for (const s of unit.sections) {
      const status = s.alreadyExisted ? "already existed" : "ingested";
      console.log(`    ${s.sectionId} (${s.syllabusRef}) [${status}] — "${s.title}" — ${s.textLength} chars — content:${s.contentId}`);
    }

    console.log("  constructions:");
    for (const c of unit.constructions) {
      const detail = c.status === "found" ? ` (in ${c.foundInSectionId})` : "";
      console.log(`    ${c.constructionId} "${c.chunk}" — ${c.status}${detail}`);
    }

    const found = unit.constructions.filter((c) => c.status === "found").length;
    const unfound = unit.constructions.filter((c) => c.status === "unfound").length;
    const alreadySeeded = unit.constructions.filter((c) => c.status === "already_seeded").length;
    console.log(`  summary: ${found} found, ${unfound} unfound, ${alreadySeeded} already seeded\n`);
  }

  if (report.missingSections.length > 0) {
    console.log(`WARNING — config sections with no matching content found in the PDFs: ${report.missingSections.join(", ")}`);
  } else {
    console.log("Every config section was found in the given PDFs.");
  }
}

async function main() {
  const { pdfPaths, levelId, configPath } = parseArgs(process.argv.slice(2));
  const level = loadLevel(levelId, configPath);

  const db = getDb();
  migrate(db, { migrationsFolder: "./drizzle" });

  const pdfs = pdfPaths.map((p) => ({ source: path.basename(p), buf: fs.readFileSync(p) }));

  const report = await ingestBook(db, level, pdfs);
  printReport(report);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
