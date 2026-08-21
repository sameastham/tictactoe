import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "@/db/schema";

/**
 * Note: this module is imported by seed scripts and vitest outside of the
 * Next.js server runtime, so it intentionally does NOT `import "server-only"`.
 * Do not import it from client components.
 */

export type Db = BetterSQLite3Database<typeof schema>;

function openSqlite(filePath: string): Database.Database {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return sqlite;
}

// Cache the DB handle on globalThis so Next.js dev hot-reload doesn't leak
// open sqlite file handles across module reloads.
const globalForDb = globalThis as unknown as { __appDb__?: Db };

/** Lazy singleton drizzle instance over the on-disk sqlite database. */
export function getDb(): Db {
  if (!globalForDb.__appDb__) {
    const dbPath = process.env.DB_PATH ?? "data/app.db";
    globalForDb.__appDb__ = drizzle(openSqlite(dbPath), { schema });
  }
  return globalForDb.__appDb__;
}

/** Creates a fresh in-memory database with all migrations applied, for tests. */
export function createTestDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}
