import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getDb } from "@/db";
import { seedFixtureArticle, seedFixtureAudio, seedGoldSourceContent } from "./seed-fixture-article";

function main() {
  const db = getDb();
  migrate(db, { migrationsFolder: "./drizzle" });

  const article = seedFixtureArticle(db);
  if (article.alreadySeeded) {
    console.log("article already seeded");
  } else {
    console.log(`seeded article content id: ${article.row.id}`);
  }

  const audio = seedFixtureAudio(db);
  if (audio.alreadySeeded) {
    console.log("audio already seeded");
  } else {
    console.log(`seeded audio content id: ${audio.row.id}`);
  }

  const notes = seedGoldSourceContent(db);
  if (notes.alreadySeeded) {
    console.log("gold-source notes already seeded");
  } else {
    console.log(`seeded gold-source notes content id: ${notes.row.id}`);
  }
}

main();
