import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getDb } from "@/db";
import { content } from "@/db/schema";
import { createContent } from "@/server/repo";

const SEED_TITLE = "El café de especialidad en México";

function main() {
  const db = getDb();
  migrate(db, { migrationsFolder: "./drizzle" });

  const existing = db.select().from(content).where(eq(content.title, SEED_TITLE)).get();
  if (existing) {
    console.log("already seeded");
    return;
  }

  const text = fs.readFileSync(path.join(process.cwd(), "fixtures", "article-es-mx.txt"), "utf-8");
  const created = createContent(db, {
    source: "paste",
    type: "article",
    title: SEED_TITLE,
    text,
  });

  console.log(`seeded content id: ${created.id}`);
}

main();
