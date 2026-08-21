import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getDb } from "@/db";
import { buildNaturalControl, buildSeededErrors } from "@/server/goldset/build";
import { getLanguageService } from "@/server/language/service";
import { buildLearnerBlock } from "@/server/learner";

async function main() {
  const db = getDb();
  migrate(db, { migrationsFolder: "./drizzle" });

  const modelMode = process.argv.includes("--model");

  const natural = buildNaturalControl(db);
  console.log(
    `natural_control: inserted ${natural.inserted} new row(s) (window ${natural.windowSize}, ${
      natural.windowSize - natural.inserted
    } already present)`,
  );

  const seeded = modelMode
    ? await buildSeededErrors(db, undefined, {
        mode: "model",
        service: getLanguageService(),
        learner: buildLearnerBlock(db),
      })
    : await buildSeededErrors(db);

  const rejectedNote = modelMode ? `, ${seeded.rejectedByRuleCheck} rejected by rule check` : "";
  console.log(
    `seeded_error:    inserted ${seeded.inserted} new row(s) (mode ${modelMode ? "model" : "rules"}, window ${
      seeded.windowSize
    }, ${seeded.windowSize - seeded.inserted} already present${rejectedNote})`,
  );
}

main();
