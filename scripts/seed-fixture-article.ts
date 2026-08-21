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

export const SEED_NOTES_TITLE = "Notas del taller";

/**
 * Authored (not copied from anywhere) natural Mexican-Spanish sentences,
 * several of which deliberately contain a catalogue injector's `natural`
 * form verbatim (see `src/server/goldset/catalogue.ts`) — this is what makes
 * `npm run goldset` produce a non-trivial `seeded_error` set on a fresh
 * install, not just whatever the café article happens to contain.
 */
const SEED_NOTES_TEXT = [
  "Ayer platicamos en el taller sobre argumentación y a varios compañeros les costó ver que su punto no tiene sentido sin un ejemplo concreto.",
  "La coordinadora explicó que casi siempre depende de que uno se prepare bien antes de exponer su idea frente al grupo.",
  "Al final, entre risas, alguien dijo que tomar una decisión en equipo es más difícil que escribir el ensayo solo.",
  "Yo me di cuenta de que corrijo mejor cuando leo en voz alta lo que escribí la noche anterior.",
  "A fin de cuentas, lo que más nos ayudó fue comparar nuestros borradores con los de compañeros más avanzados.",
  "Varios coincidimos en que el registro formal todavía se nos escapa cuando estamos nerviosos frente a la clase.",
  "El profesor insistió en que conviene revisar la concordancia de género antes de entregar cualquier trabajo escrito.",
  "Para la próxima sesión, quedamos en traer un párrafo corto sobre un tema que realmente nos importe.",
].join(" ");

/**
 * Idempotently inserts a second, small paste content row (`SEED_NOTES_TITLE`)
 * of authored natural Mexican-Spanish sentences — gold-set source material
 * for `npm run goldset` (see `src/server/goldset/build.ts`), keyed by title
 * like the other two seed helpers. Shared by `scripts/seed.ts` and
 * `e2e/global-setup.ts`.
 */
export function seedGoldSourceContent(db: Db): { row: ContentRow; alreadySeeded: boolean } {
  const existing = db.select().from(content).where(eq(content.title, SEED_NOTES_TITLE)).get();
  if (existing) {
    return { row: existing, alreadySeeded: true };
  }

  const row = createContent(db, {
    source: "paste",
    type: "paste",
    title: SEED_NOTES_TITLE,
    text: SEED_NOTES_TEXT,
  });

  return { row, alreadySeeded: false };
}
