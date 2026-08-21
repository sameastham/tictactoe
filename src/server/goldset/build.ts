/**
 * Gold-set builders for the eval harness (`scripts/eval.ts`) — see plan
 * Sec.6.3. Two deterministic builders draw from the same sentence pool (every
 * content row's text, split into sentences, 8-30 words, deduped):
 *
 *   - `buildNaturalControl`: sentences as-is, `expectedRung: "natural"` —
 *     natural by construction, so every flag the judge raises on them is a
 *     false positive.
 *   - `buildSeededErrors`: sentences with exactly one catalogue injector
 *     applied (see `src/server/goldset/catalogue.ts`), `expectedRung`/
 *     `expectedTags` known in advance from the injector.
 *
 * The third gold set (`adjudicated`) is NOT built here — it grows
 * organically from the learner's Fix-surface overrides, written directly by
 * `recordAdjudication` in `src/server/repo.ts`.
 *
 * Both builders are idempotent: the candidate window (the first `max`
 * eligible sentences, in a fixed deterministic order) is derived purely from
 * `content`, never from what's already in `gold_set` — so a re-run always
 * considers the same window and only ever skips rows already present,
 * inserting nothing new.
 */
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { content, goldSet } from "@/db/schema";
import { DEFAULT_USER_ID, newId } from "@/lib/ids";
import { applyInjector, findMatchingInjectors, type Injector } from "@/server/goldset/catalogue";

const MIN_WORDS = 8;
const MAX_WORDS = 30;
const DEFAULT_MAX = 20;

type SentenceRef = {
  contentId: string;
  sentence: string;
};

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/**
 * Every content row's text, split into sentences, filtered to 8-30 words,
 * deduped by exact sentence text, in deterministic order: content
 * `createdAt` ascending, then sentence order within that content. No
 * randomness — same DB state always yields the same pool in the same order.
 */
function buildSentencePool(db: Db): SentenceRef[] {
  const rows = db
    .select({ id: content.id, text: content.text, createdAt: content.createdAt })
    .from(content)
    .where(eq(content.userId, DEFAULT_USER_ID))
    .orderBy(asc(content.createdAt))
    .all();

  const seen = new Set<string>();
  const pool: SentenceRef[] = [];
  for (const row of rows) {
    for (const sentence of splitSentences(row.text)) {
      const words = wordCount(sentence);
      if (words < MIN_WORDS || words > MAX_WORDS) continue;
      if (seen.has(sentence)) continue;
      seen.add(sentence);
      pool.push({ contentId: row.id, sentence });
    }
  }
  return pool;
}

/** Every sentence currently stored in `gold_set`, across all three sets. */
function existingGoldSentences(db: Db): Set<string> {
  const rows = db.select({ sentence: goldSet.sentence }).from(goldSet).where(eq(goldSet.userId, DEFAULT_USER_ID)).all();
  return new Set(rows.map((r) => r.sentence));
}

export type BuildResult = {
  /** Rows actually inserted by this call. */
  inserted: number;
  /** Size of the deterministic candidate window considered (inserted + already-present + unusable). */
  windowSize: number;
};

/**
 * Inserts up to `max` `natural_control` gold rows: real sentences straight
 * from the content store, `expectedRung: "natural"`, `expectedTags: []`.
 * Skips a sentence already present anywhere in `gold_set` (any set).
 */
export function buildNaturalControl(db: Db, max = DEFAULT_MAX): BuildResult {
  const pool = buildSentencePool(db);
  const window = pool.slice(0, max);
  const existing = existingGoldSentences(db);
  const now = new Date();

  let inserted = 0;
  for (const ref of window) {
    if (existing.has(ref.sentence)) continue;
    db.insert(goldSet)
      .values({
        id: newId(),
        userId: DEFAULT_USER_ID,
        sentence: ref.sentence,
        set: "natural_control",
        expectedRung: "natural",
        expectedTags: [],
        origin: `content:${ref.contentId}`,
        createdAt: now,
      })
      .run();
    inserted++;
  }
  return { inserted, windowSize: window.length };
}

/**
 * Inserts up to `max` `seeded_error` gold rows: sentences from the same pool
 * that match EXACTLY ONE catalogue injector (see `findMatchingInjectors`),
 * with that injector applied. `expectedRung`/`expectedTags` come straight
 * from the injector. Skips a mutated sentence already present anywhere in
 * `gold_set` (any set).
 */
export function buildSeededErrors(db: Db, max = DEFAULT_MAX): BuildResult {
  const pool = buildSentencePool(db);

  const eligible: { contentId: string; mutated: string; injector: Injector }[] = [];
  for (const ref of pool) {
    const matches = findMatchingInjectors(ref.sentence);
    if (matches.length !== 1) continue;
    const [injector] = matches;
    eligible.push({ contentId: ref.contentId, mutated: applyInjector(injector, ref.sentence), injector });
  }

  const window = eligible.slice(0, max);
  const existing = existingGoldSentences(db);
  const now = new Date();

  let inserted = 0;
  for (const { contentId, mutated, injector } of window) {
    if (existing.has(mutated)) continue;
    db.insert(goldSet)
      .values({
        id: newId(),
        userId: DEFAULT_USER_ID,
        sentence: mutated,
        set: "seeded_error",
        expectedRung: injector.expectedRung,
        expectedTags: [injector.tag],
        origin: `seeded:${injector.id}:content:${contentId}`,
        createdAt: now,
      })
      .run();
    inserted++;
  }
  return { inserted, windowSize: window.length };
}
