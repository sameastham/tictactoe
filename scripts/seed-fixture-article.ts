import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { content } from "@/db/schema";
import type { SttResult } from "@/server/stt/provider";
import { createContent, saveTranscript, type ContentRow } from "@/server/repo";

export const SEED_TITLE = "El café de especialidad en México";
export const SEED_AUDIO_TITLE = "En el tianguis";

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

/**
 * Idempotently inserts the fixture dictation audio (`fixtures/dictation-es-mx.wav`)
 * as an audio content row, keyed by title. Copies the wav into `data/media/`
 * and pre-applies the canned transcript/wordTimestamps from
 * `fixtures/dictation-es-mx.json` so the Listen surface's dictation exercise
 * works instantly, without needing an STT pass. Shared by `scripts/seed.ts`
 * and `e2e/global-setup.ts`, same as `seedFixtureArticle`.
 */
export function seedFixtureAudio(db: Db): { row: ContentRow; alreadySeeded: boolean } {
  const existing = db.select().from(content).where(eq(content.title, SEED_AUDIO_TITLE)).get();
  if (existing) {
    return { row: existing, alreadySeeded: true };
  }

  // Stable filename (not a fresh newId() per run) so repeated seeding — e.g.
  // e2e's globalSetup, which wipes and re-seeds the DB on every run —
  // overwrites the same file instead of accumulating orphans in data/media/.
  const relPath = path.join("data", "media", "seed-fixture-audio.wav");
  const absPath = path.join(process.cwd(), relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), "fixtures", "dictation-es-mx.wav"), absPath);

  const row = createContent(db, {
    source: "upload",
    type: "audio",
    title: SEED_AUDIO_TITLE,
    text: "",
    mediaPath: relPath,
  });

  const transcriptFixture: SttResult = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "fixtures", "dictation-es-mx.json"), "utf-8"),
  );
  saveTranscript(db, row.id, { transcript: transcriptFixture.text, wordTimestamps: transcriptFixture.words });

  return { row: db.select().from(content).where(eq(content.id, row.id)).get()!, alreadySeeded: false };
}
