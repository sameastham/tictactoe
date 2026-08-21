import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { content } from "@/db/schema";
import { createContent, type ContentRow } from "@/server/repo";

export const SEED_TITLE = "El café de especialidad en México";

/**
 * Idempotently inserts the fixture article (`fixtures/article-es-mx.txt`) as a
 * content row, keyed by title. Does NOT apply migrations — the caller is
 * responsible for running `migrate(db, { migrationsFolder: "./drizzle" })`
 * first.
 *
 * Shared by `scripts/seed.ts` (default DB_PATH) and `e2e/global-setup.ts`
 * (throwaway e2e DB_PATH) so both seed identically.
 */
export function seedFixtureArticle(db: Db): { row: ContentRow; alreadySeeded: boolean } {
  const existing = db.select().from(content).where(eq(content.title, SEED_TITLE)).get();
  if (existing) {
    return { row: existing, alreadySeeded: true };
  }

  const text = fs.readFileSync(path.join(process.cwd(), "fixtures", "article-es-mx.txt"), "utf-8");
  const row = createContent(db, {
    source: "paste",
    type: "article",
    title: SEED_TITLE,
    text,
  });

  return { row, alreadySeeded: false };
}
