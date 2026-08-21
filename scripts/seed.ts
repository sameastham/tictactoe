import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getDb } from "@/db";
import { seedFixtureArticle } from "./seed-fixture-article";

function main() {
  const db = getDb();
  migrate(db, { migrationsFolder: "./drizzle" });

  const { row, alreadySeeded } = seedFixtureArticle(db);
  if (alreadySeeded) {
    console.log("already seeded");
    return;
  }

  console.log(`seeded content id: ${row.id}`);
}

main();
