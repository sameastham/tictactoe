/**
 * Thin CLI over `ingestBook` (`src/server/syllabus/ingest.ts`): reads one or
 * more Dicho y hecho PDF parts from disk (in the order given — book part
 * order matters, see `ingestBook`'s doc comment), runs the full ingestion
 * pipeline against the app's DB, and prints a per-unit report table.
 *
 * Usage: `npm run ingest-book -- <pdfPath...> --level dyh7`
 */
import fs from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getDb } from "@/db";
import { getLevel } from "@/server/syllabus/config";
import { ingestBook, type IngestReport } from "@/server/syllabus/ingest";

function parseArgs(argv: string[]): { pdfPaths: string[]; levelId: string } {
  const levelIndex = argv.indexOf("--level");
  if (levelIndex === -1 || !argv[levelIndex + 1]) {
    throw new Error("ingest-book: missing --level <id> (e.g. --level dyh7)");
  }
  const levelId = argv[levelIndex + 1];
  const pdfPaths = argv.filter((arg, i) => i !== levelIndex && i !== levelIndex + 1 && arg !== "--level");
  if (pdfPaths.length === 0) {
    throw new Error("ingest-book: no PDF paths given — usage: ingest-book <pdfPath...> --level <id>");
  }
  return { pdfPaths, levelId };
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
  const { pdfPaths, levelId } = parseArgs(process.argv.slice(2));

  const level = getLevel(levelId);
  if (!level) {
    throw new Error(`ingest-book: unknown syllabus level "${levelId}" — check config/syllabus/*.json`);
  }

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
