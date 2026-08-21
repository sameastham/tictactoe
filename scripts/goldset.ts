import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getDb } from "@/db";
import { buildNaturalControl, buildSeededErrors } from "@/server/goldset/build";

function main() {
  const db = getDb();
  migrate(db, { migrationsFolder: "./drizzle" });

  const natural = buildNaturalControl(db);
  console.log(
    `natural_control: inserted ${natural.inserted} new row(s) (window ${natural.windowSize}, ${
      natural.windowSize - natural.inserted
    } already present)`,
  );

  const seeded = buildSeededErrors(db);
  console.log(
    `seeded_error:    inserted ${seeded.inserted} new row(s) (window ${seeded.windowSize}, ${
      seeded.windowSize - seeded.inserted
    } already present)`,
  );
}

main();
