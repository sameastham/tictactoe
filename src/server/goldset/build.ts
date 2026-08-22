/**
 * Gold-set builders for the eval harness (`scripts/eval.ts`) — see plan
 * Sec.6.3. Two builders draw from the same sentence pool (every content
 * row's text, split into sentences, 8-30 words, deduped):
 *
 *   - `buildNaturalControl`: sentences as-is, `expectedRung: "natural"` —
 *     natural by construction, so every flag the judge raises on them is a
 *     false positive.
 *   - `buildSeededErrors`: sentences with exactly one error injected,
 *     `expectedRung`/`expectedTags` known in advance. Two modes:
 *       - `"rules"` (default): a deterministic catalogue injector applied
 *         directly (see `src/server/goldset/catalogue.ts`) — no model call,
 *         fully reproducible.
 *       - `"model"`: a second model call (`LanguageService.seedError`, the
 *         `seed_error` purpose) does the injection following the same
 *         catalogue's error families, per plan Sec.6.3 ("a second model does
 *         the injection following the catalogue; a rule check confirms only
 *         one change was made"). `verifySingleChange` is that rule check —
 *         a model mutation that fails it is counted and skipped, never
 *         inserted.
 *
 * The third gold set (`adjudicated`) is NOT built here — it grows
 * organically from the learner's Fix-surface overrides, written directly by
 * `recordAdjudication` in `src/server/repo.ts`.
 *
 * `buildNaturalControl` and rules-mode `buildSeededErrors` are idempotent:
 * the candidate window (the first `max` eligible sentences, in a fixed
 * deterministic order) is derived purely from `content`, never from what's
 * already in `gold_set` — so a re-run always considers the same window and
 * only ever skips rows already present, inserting nothing new. Model-mode
 * `buildSeededErrors` is idempotent in the same sense but re-calls the model
 * for every sentence in the window on every run (its eligibility can't be
 * known without a model call), so re-running it is not free the way the
 * other two are.
 */
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { content, goldSet } from "@/db/schema";
import { DEFAULT_USER_ID, newId } from "@/lib/ids";
import type { LearnerBlock } from "@/lib/contracts";
import { TAXONOMY, type TaxonomyTag } from "@/lib/taxonomy";
import { applyInjector, findMatchingInjectors, type Injector } from "@/server/goldset/catalogue";
import type { LanguageService } from "@/server/language/service";

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
 *
 * Excludes `didactic: true` rows (syllabus-ingested textbook content — see
 * `src/server/syllabus/ingest.ts`): both gold sets built from this pool
 * (`buildNaturalControl`, `buildSeededErrors`) exist to measure the judge
 * against real Mexican Spanish usage, and pedagogically engineered textbook
 * prose (exercise sentences, gap-fills, grammar-box examples) is not a
 * sample of that — it must not define the naturalness baseline. Contrast
 * `isAttested` (`src/server/language/service.ts`), which deliberately KEEPS
 * didactic content: a phrase attested in a textbook is still legitimate
 * evidence that the phrase is real Spanish.
 */
function buildSentencePool(db: Db): SentenceRef[] {
  const rows = db
    .select({ id: content.id, text: content.text, createdAt: content.createdAt })
    .from(content)
    .where(and(eq(content.userId, DEFAULT_USER_ID), eq(content.didactic, false)))
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
 * Rule check for a model-injected mutation (plan Sec.6.3): true iff `mutated`
 * equals `original` with EXACTLY the first occurrence of `originalSpan`
 * replaced by `mutatedSpan` — a string-build comparison, not a diff — AND
 * `mutated !== original` AND `originalSpan` actually occurs in `original`.
 * Any other shape (two changes, a fabricated span, no change at all) fails.
 * Pure and side-effect-free so it's trivial to unit test independent of any
 * model or DB.
 */
export function verifySingleChange(
  original: string,
  mutated: string,
  originalSpan: string,
  mutatedSpan: string,
): boolean {
  if (originalSpan.length === 0) return false;
  const index = original.indexOf(originalSpan);
  if (index === -1) return false;

  const rebuilt = original.slice(0, index) + mutatedSpan + original.slice(index + originalSpan.length);
  if (rebuilt !== mutated) return false;
  if (mutated === original) return false;
  return true;
}

/** Every taxonomy tag except the two Listen-only ones — what model-mode `buildSeededErrors` offers `service.seedError` as `allowed_tags`. */
const SEED_ERROR_ALLOWED_TAGS: TaxonomyTag[] = TAXONOMY.filter(
  (tag) => tag !== "listening_reduction" && tag !== "listening_lexical",
);

export type BuildSeededErrorsMode = "rules" | "model";

export type BuildSeededErrorsOptions = {
  mode?: BuildSeededErrorsMode;
  /** Required when `mode === "model"`. */
  service?: LanguageService;
  /** Required when `mode === "model"`. */
  learner?: LearnerBlock;
};

export type SeededErrorsBuildResult = BuildResult & {
  /**
   * Model-mode only: mutations the model claimed were valid but that failed
   * `verifySingleChange` — counted and skipped, never inserted. Always 0 in
   * rules mode (a catalogue injector's replacement is correct by
   * construction).
   */
  rejectedByRuleCheck: number;
};

/**
 * Inserts up to `max` `seeded_error` gold rows. Default `mode: "rules"`:
 * sentences from the sentence pool that match EXACTLY ONE catalogue injector
 * (see `findMatchingInjectors`), with that injector applied —
 * `expectedRung`/`expectedTags` come straight from the injector, no model
 * call. `mode: "model"` (requires `opts.service`/`opts.learner`): the first
 * `max` pool sentences are each offered to `service.seedError` with
 * `allowed_tags` = every non-listening taxonomy tag; a sentence the model
 * says it can't inject into is skipped; a mutation that fails
 * `verifySingleChange` is counted in `rejectedByRuleCheck` and skipped,
 * never inserted. Both modes skip a mutated sentence already present
 * anywhere in `gold_set` (any set).
 */
export async function buildSeededErrors(
  db: Db,
  max = DEFAULT_MAX,
  opts: BuildSeededErrorsOptions = {},
): Promise<SeededErrorsBuildResult> {
  const mode = opts.mode ?? "rules";

  if (mode === "rules") {
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
    return { inserted, windowSize: window.length, rejectedByRuleCheck: 0 };
  }

  // mode === "model"
  const { service, learner } = opts;
  if (!service || !learner) {
    throw new Error('buildSeededErrors: mode "model" requires opts.service and opts.learner');
  }

  const pool = buildSentencePool(db);
  const window = pool.slice(0, max);
  const existing = existingGoldSentences(db);
  const now = new Date();

  let inserted = 0;
  let rejectedByRuleCheck = 0;
  for (const ref of window) {
    const { result } = await service.seedError(
      { sentence: ref.sentence, allowed_tags: SEED_ERROR_ALLOWED_TAGS },
      learner,
    );
    if (!result.can_inject) continue;
    // The seed_error wire contract guarantees these five fields are non-null
    // together with can_inject: true — guarded anyway since this is model
    // output, not app-constructed data.
    if (
      result.mutated === null ||
      result.tag === null ||
      result.expected_rung === null ||
      result.original_span === null ||
      result.mutated_span === null
    ) {
      continue;
    }

    const verified = verifySingleChange(ref.sentence, result.mutated, result.original_span, result.mutated_span);
    if (!verified) {
      rejectedByRuleCheck++;
      console.warn(
        `goldset (model mode): rejected by rule check — content:${ref.contentId}: "${ref.sentence}" -> "${result.mutated}"`,
      );
      continue;
    }
    if (existing.has(result.mutated)) continue;

    db.insert(goldSet)
      .values({
        id: newId(),
        userId: DEFAULT_USER_ID,
        sentence: result.mutated,
        set: "seeded_error",
        expectedRung: result.expected_rung,
        expectedTags: [result.tag],
        origin: `seeded-model:content:${ref.contentId}`,
        createdAt: now,
      })
      .run();
    inserted++;
  }

  return { inserted, windowSize: window.length, rejectedByRuleCheck };
}
