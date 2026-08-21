import fs from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getDb } from "@/db";
import { seedFixtureArticle, seedFixtureAudio } from "../scripts/seed-fixture-article";

/**
 * Must match `webServer.env.DB_PATH` in playwright.config.ts — this process
 * (the Playwright test runner) and the `next start` server it spawns each
 * need to agree on which sqlite file is "the" e2e database.
 */
const E2E_DB_PATH = ".tmp/e2e.db";

/** Removes the db file and any sqlite WAL/SHM/journal siblings, if present. */
function resetDbFile(dbPath: string): void {
  const abs = path.resolve(process.cwd(), dbPath);
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const target = `${abs}${suffix}`;
    if (fs.existsSync(target)) {
      fs.rmSync(target);
    }
  }
}

/**
 * Runs once before the whole e2e suite (before any test, and — per
 * Playwright's task ordering — after the `webServer` process has started
 * listening, but before it has served a single request, since our webServer
 * config uses a `port` readiness check, not a `url` one). Resets
 * `.tmp/e2e.db` to a clean, migrated, seeded state so every `npm run e2e`
 * invocation starts from the same fixture data, regardless of what a
 * previous run left behind.
 */
export default async function globalSetup(): Promise<void> {
  process.env.DB_PATH = E2E_DB_PATH;
  resetDbFile(E2E_DB_PATH);

  const db = getDb();
  migrate(db, { migrationsFolder: "./drizzle" });
  seedFixtureArticle(db);
  seedFixtureAudio(db);
}
