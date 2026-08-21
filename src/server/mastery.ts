/**
 * Learner mastery model v1 (founding plan §5): mastery per item and per
 * taxonomy category, derived purely from the append-only event log plus the
 * `writings`/`talk_turns` tables — no new tables, no stored state, same
 * "surfaces are interfaces over the log" posture as `src/server/scheduler.ts`
 * and `src/server/report.ts`.
 *
 * Consistency outweighs any single success: one correct use is never
 * mastery. See `MASTERY_BANDS` (`src/lib/taxonomy.ts`) for the qualitative
 * bands this derives into — there is no numeric score anywhere in the UI,
 * only bands, counts, and examples (the internal score computed here is an
 * implementation detail, never rendered).
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { events, items as itemsTable, talkTurns, writings } from "@/db/schema";
import { DEFAULT_USER_ID } from "@/lib/ids";
import {
  AdjudicatedPayloadSchema,
  ItemAvoidedPayloadSchema,
  ProducedErrorPayloadSchema,
  ProducedOkPayloadSchema,
  ReviewedPayloadSchema,
  type JudgeResult,
} from "@/lib/contracts";
import { RUNGS, TAXONOMY, type MasteryBand, type TaxonomyTag } from "@/lib/taxonomy";
import type { EventRow, ItemRow } from "@/server/repo";
import { computeRecurrence, normalizeForMatch, TRANSFER_MIN_GAP_MS } from "@/server/report";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Decay constant (days) for `decayFactor`: `exp(-daysSince / DECAY_TAU_DAYS)`.
 * Named "tau", not "half-life" — a true half-life would need
 * `DECAY_TAU_DAYS * Math.LN2` (~31 days) to reach 0.5; at `DECAY_TAU_DAYS`
 * itself (45 days) the multiplier is `1/e` (~0.37). The plan's "45-day
 * half-life-ish" is this constant, described loosely — a signal is
 * meaningfully faded by ~6 weeks without being a hard cutoff.
 */
const DECAY_TAU_DAYS = 45;

/** Every positive/negative weight this model assigns, named — see the plan's per-signal spec. */
const WEIGHT_UNPROMPTED_PRODUCTION = 3;
const WEIGHT_PROMPTED_PRODUCTION = 2;
const WEIGHT_REVIEW_GOOD = 1; // "good" and "easy" both land here.
const WEIGHT_REVIEW_HARD = -0.5;
const WEIGHT_REVIEW_AGAIN = -2;
const WEIGHT_ITEM_AVOIDED = -1;
const WEIGHT_ADJUDICATED_NATURAL = 2;
const WEIGHT_CATEGORY_ERROR = -1.5;

/** An item needs at least this many positive signals to leave the "fragil" band, regardless of score. */
const CONSISTENCY_MIN_POSITIVE_SIGNALS = 3;
/** Item/category score thresholds: < FRAGIL_MAX is "fragil", <= SOLIDO_MIN is "en_progreso", above is "solido". */
const FRAGIL_MAX = 2;
const SOLIDO_MIN = 5;

/** How many blocking categories `deriveBlocking` ranks and returns. */
const BLOCKING_TOP_N = 3;
/** How many weakest items each blocking category carries. */
const BLOCKING_WEAKEST_ITEMS = 2;

const NATURAL_RUNG_INDEX = RUNGS.indexOf("natural");

/** Exponential decay multiplier for a signal dated `eventAt`, as of `now`. See `DECAY_TAU_DAYS`. */
function decayFactor(eventAt: Date, now: Date): number {
  const days = Math.max(0, (now.getTime() - eventAt.getTime()) / DAY_MS);
  return Math.exp(-days / DECAY_TAU_DAYS);
}

/** Pure score -> band mapping (no consistency gate) — shared by item and category mastery. */
function scoreToBand(score: number): MasteryBand {
  if (score < FRAGIL_MAX) return "fragil";
  if (score <= SOLIDO_MIN) return "en_progreso";
  return "solido";
}

/**
 * Item-mastery band: same score thresholds as {@link scoreToBand}, but an
 * item can never leave "fragil" with fewer than
 * {@link CONSISTENCY_MIN_POSITIVE_SIGNALS} positive signals — the plan's
 * consistency rule ("one correct use is not mastery"), enforced regardless
 * of how large a single signal's weight was.
 */
function itemBand(score: number, positiveSignals: number): MasteryBand {
  if (positiveSignals < CONSISTENCY_MIN_POSITIVE_SIGNALS) return "fragil";
  return scoreToBand(score);
}

/** One weighted, dated contribution to an item's mastery score. */
type Signal = { weight: number; createdAt: Date };

// -----------------------------------------------------------------------------
// unprompted-vs-prompted production
// -----------------------------------------------------------------------------

/**
 * One piece of learner-produced text considered for "unprompted production"
 * scanning: either a `writings` row (a Fix submission, or — since Talk joins
 * every learner turn into one writing at `endTalk` — an ended Talk session)
 * or one individual learner `talk_turns` row. `targetedItemIds` is the union
 * of that writing's judged `items_used`/`items_avoided` — items the learner
 * was actually asked to try, per the plan's investigation note: "produced_ok
 * events are only emitted for items in items_used, which only contains
 * TARGETED items — so today every produced_ok is prompted". `groupKey`
 * identifies the underlying writing/session so multiple pieces of text from
 * the same writing (an ended Talk session's joined writing plus its
 * individual turns) collapse to a single "per writing" opportunity — see
 * {@link unpromptedSignalsFor}'s "cap one per writing per item".
 */
type ProductionEvent = {
  text: string;
  createdAt: Date;
  targetedItemIds: Set<string>;
  groupKey: string;
};

/** The targeted item ids for a judgment: items the learner used, plus items they were asked to but avoided. */
function targetedIdsOf(judgment: JudgeResult | null): Set<string> {
  if (!judgment) return new Set();
  return new Set([...judgment.items_used, ...judgment.items_avoided]);
}

/**
 * Every piece of learner-produced text in the log, for unprompted-production
 * scanning — same two sources as `report.ts`'s `computeTransfer` (`writings`
 * rows and learner `talk_turns` rows), reusing its exact texts rather than
 * re-deriving them. A talk turn whose session has since been judged (an
 * ended Talk session always gets one `writings` row joining all its learner
 * turns, per `endTalk`) is grouped under that writing's `groupKey`, not its
 * own — the joined writing and its source turns are one production
 * opportunity, not several. A turn from a session never ended (no writing
 * yet) keeps its own session-scoped group.
 */
function loadProductionEvents(db: Db): ProductionEvent[] {
  const writingRows = db.select().from(writings).where(eq(writings.userId, DEFAULT_USER_ID)).all();
  const talkTurnRows = db
    .select()
    .from(talkTurns)
    .where(and(eq(talkTurns.userId, DEFAULT_USER_ID), eq(talkTurns.role, "learner")))
    .all();

  const writingBySession = new Map<string, (typeof writingRows)[number]>();
  for (const row of writingRows) {
    if (row.sessionId) writingBySession.set(row.sessionId, row);
  }

  const productionEvents: ProductionEvent[] = writingRows.map((row) => ({
    text: row.text,
    createdAt: row.createdAt,
    targetedItemIds: targetedIdsOf(row.judgment),
    groupKey: `w:${row.id}`,
  }));

  for (const turn of talkTurnRows) {
    const relatedWriting = writingBySession.get(turn.sessionId);
    productionEvents.push({
      text: turn.text,
      createdAt: turn.createdAt,
      targetedItemIds: targetedIdsOf(relatedWriting?.judgment ?? null),
      groupKey: relatedWriting ? `w:${relatedWriting.id}` : `s:${turn.sessionId}`,
    });
  }

  return productionEvents;
}

/**
 * Unprompted-production signals for one item: an occurrence of its chunk
 * (whitespace/case-normalized substring, via `report.ts`'s
 * `normalizeForMatch`) in a piece of production the item was NOT targeted in
 * (see `ProductionEvent.targetedItemIds`), at least `TRANSFER_MIN_GAP_MS`
 * after capture (report.ts's own transfer gap — the learner echoing back the
 * sentence they just captured it from doesn't count). Capped at one signal
 * per `groupKey` ("cap one per writing per item" per the plan) — when a
 * group has more than one matching occurrence, the most recent is kept, so
 * the signal's decay reflects the freshest evidence.
 */
function unpromptedSignalsFor(item: Pick<ItemRow, "id" | "chunk" | "createdAt">, productionEvents: ProductionEvent[]): Signal[] {
  const cutoffMs = item.createdAt.getTime() + TRANSFER_MIN_GAP_MS;
  const chunkNorm = normalizeForMatch(item.chunk);

  const latestByGroup = new Map<string, Date>();
  for (const evt of productionEvents) {
    if (evt.createdAt.getTime() < cutoffMs) continue;
    if (evt.targetedItemIds.has(item.id)) continue;
    if (!normalizeForMatch(evt.text).includes(chunkNorm)) continue;

    const existing = latestByGroup.get(evt.groupKey);
    if (!existing || evt.createdAt.getTime() > existing.getTime()) {
      latestByGroup.set(evt.groupKey, evt.createdAt);
    }
  }

  return [...latestByGroup.values()].map((createdAt) => ({ weight: WEIGHT_UNPROMPTED_PRODUCTION, createdAt }));
}

// -----------------------------------------------------------------------------
// per-item mastery
// -----------------------------------------------------------------------------

/** Event types that carry an `itemId` and feed item mastery directly (unlike `adjudicated`, matched by chunk text instead — see below). */
const ITEM_SCOPED_EVENT_TYPES = ["reviewed", "produced_ok", "item_avoided"] as const;

/** One item's derived mastery, as returned by {@link deriveItemMastery} — sorted weakest first. */
export type ItemMastery = {
  item: ItemRow;
  score: number;
  band: MasteryBand;
  signals: { positive: number; negative: number };
};

/** The weighted, dated signal one item-scoped event contributes, or null if it carries none (malformed payload, unrecognized type). */
function signalForItemScopedEvent(event: Pick<EventRow, "type" | "payload" | "createdAt">): Signal | null {
  if (event.type === "reviewed") {
    const parsed = ReviewedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) return null;
    const weight =
      parsed.data.rating === "again"
        ? WEIGHT_REVIEW_AGAIN
        : parsed.data.rating === "hard"
          ? WEIGHT_REVIEW_HARD
          : WEIGHT_REVIEW_GOOD; // "good" and "easy" both land here.
    return { weight, createdAt: event.createdAt };
  }
  if (event.type === "produced_ok") {
    const parsed = ProducedOkPayloadSchema.safeParse(event.payload);
    if (!parsed.success) return null;
    // Always prompted today — see this module's header doc and the
    // ProductionEvent doc above: every produced_ok is for a targeted item.
    return { weight: WEIGHT_PROMPTED_PRODUCTION, createdAt: event.createdAt };
  }
  if (event.type === "item_avoided") {
    const parsed = ItemAvoidedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) return null;
    return { weight: WEIGHT_ITEM_AVOIDED, createdAt: event.createdAt };
  }
  return null;
}

/**
 * Adjudicated-verdict signals for one item: an `adjudicated` event whose
 * sentence contains the item's chunk and whose `learnerRung` is "natural" or
 * "precise" — the learner's own verdict outranking the model's judgment on
 * that sentence. `adjudicated` events carry no `itemId` (see
 * `AdjudicatedPayloadSchema` — only the sentence text), so this matches by
 * normalized chunk-in-sentence substring, same rule as production scanning.
 */
function adjudicatedSignalsFor(
  item: Pick<ItemRow, "chunk">,
  adjudicatedEvents: Pick<EventRow, "payload" | "createdAt">[],
): Signal[] {
  const chunkNorm = normalizeForMatch(item.chunk);
  const signals: Signal[] = [];
  for (const event of adjudicatedEvents) {
    const parsed = AdjudicatedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) continue;
    if (RUNGS.indexOf(parsed.data.learnerRung) < NATURAL_RUNG_INDEX) continue;
    if (!normalizeForMatch(parsed.data.sentence).includes(chunkNorm)) continue;
    signals.push({ weight: WEIGHT_ADJUDICATED_NATURAL, createdAt: event.createdAt });
  }
  return signals;
}

/**
 * Derives every item's mastery from the event log as of `now`: a decayed
 * (see `decayFactor`/`DECAY_TAU_DAYS`), signal-weighted score, its band (see
 * `itemBand` — gated by the consistency rule), and its raw positive/negative
 * signal counts. Pure and deterministic for a fixed `now` — two calls with
 * the same arguments deep-equal. Sorted weakest (lowest score) first, so
 * callers needing "the N weakest items" can just slice.
 */
export function deriveItemMastery(db: Db, now: Date = new Date()): ItemMastery[] {
  const allItems = db.select().from(itemsTable).where(eq(itemsTable.userId, DEFAULT_USER_ID)).all();
  if (allItems.length === 0) return [];

  const itemScopedEvents = db
    .select()
    .from(events)
    .where(and(eq(events.userId, DEFAULT_USER_ID), inArray(events.type, ITEM_SCOPED_EVENT_TYPES)))
    .all();

  const eventsByItem = new Map<string, EventRow[]>();
  for (const event of itemScopedEvents) {
    if (!event.itemId) continue;
    const bucket = eventsByItem.get(event.itemId);
    if (bucket) bucket.push(event);
    else eventsByItem.set(event.itemId, [event]);
  }

  const adjudicatedEvents = db
    .select()
    .from(events)
    .where(and(eq(events.userId, DEFAULT_USER_ID), eq(events.type, "adjudicated")))
    .all();

  const productionEvents = loadProductionEvents(db);
  const nowMs = now.getTime();

  const results: ItemMastery[] = allItems.map((item) => {
    const signals: Signal[] = [];

    for (const event of eventsByItem.get(item.id) ?? []) {
      if (event.createdAt.getTime() > nowMs) continue;
      const signal = signalForItemScopedEvent(event);
      if (signal) signals.push(signal);
    }

    for (const signal of adjudicatedSignalsFor(item, adjudicatedEvents)) {
      if (signal.createdAt.getTime() > nowMs) continue;
      signals.push(signal);
    }

    for (const signal of unpromptedSignalsFor(item, productionEvents)) {
      if (signal.createdAt.getTime() > nowMs) continue;
      signals.push(signal);
    }

    const score = signals.reduce((sum, signal) => sum + signal.weight * decayFactor(signal.createdAt, now), 0);
    const positive = signals.filter((signal) => signal.weight > 0).length;
    const negative = signals.filter((signal) => signal.weight < 0).length;

    return { item, score, band: itemBand(score, positive), signals: { positive, negative } };
  });

  results.sort((a, b) => a.score - b.score || a.item.chunk.localeCompare(b.item.chunk));
  return results;
}

// -----------------------------------------------------------------------------
// per-category mastery
// -----------------------------------------------------------------------------

/** One taxonomy category's derived mastery, as returned by {@link deriveCategoryMastery}. */
export type CategoryMastery = {
  tag: TaxonomyTag;
  band: MasteryBand;
  /** `produced_error` events with this tag in the trailing 30 days — `report.ts`'s own recurrence window, reused via `computeRecurrence`. */
  errorCount30d: number;
  /** Current-30d vs. previous-30d error-count comparison (report.ts's own trend), omitted when the tag has no error evidence in either window. */
  trend?: "up" | "down" | "flat";
};

/** Every `produced_error` event row (with a valid `taxonomy` column) at or before `now`. */
function loadProducedErrorEvents(db: Db, now: Date): EventRow[] {
  const rows = db
    .select()
    .from(events)
    .where(and(eq(events.userId, DEFAULT_USER_ID), eq(events.type, "produced_error")))
    .all();
  return rows.filter((row) => row.taxonomy !== null && row.createdAt.getTime() <= now.getTime());
}

/**
 * Derives every taxonomy tag's mastery as of `now`: positive evidence is the
 * decayed sum of item scores (from {@link deriveItemMastery}) among items
 * carrying that tag; negative evidence is a decayed count of every
 * `produced_error` event carrying that tag (weight {@link WEIGHT_CATEGORY_ERROR}
 * each, decayed — not windowed, unlike `errorCount30d`). Returns all 11
 * `TAXONOMY` tags, even ones with zero evidence either way (score 0 ->
 * "fragil"), so a caller can render a complete category list. Pure and
 * deterministic for a fixed `now`.
 */
export function deriveCategoryMastery(db: Db, now: Date = new Date()): CategoryMastery[] {
  const itemMastery = deriveItemMastery(db, now);
  const recurrence = computeRecurrence(db, now);
  const recurrenceByTag = new Map(recurrence.map((row) => [row.tag, row]));
  const errorEvents = loadProducedErrorEvents(db, now);

  return TAXONOMY.map((tag) => {
    const positiveEvidence = itemMastery
      .filter((entry) => (entry.item.taxonomy ?? []).includes(tag))
      .reduce((sum, entry) => sum + entry.score, 0);

    const negativeEvidence = errorEvents
      .filter((row) => row.taxonomy === tag)
      .reduce((sum, row) => sum + WEIGHT_CATEGORY_ERROR * decayFactor(row.createdAt, now), 0);

    const score = positiveEvidence + negativeEvidence;
    const recurrenceRow = recurrenceByTag.get(tag);
    const trend: CategoryMastery["trend"] =
      recurrenceRow && (recurrenceRow.count > 0 || recurrenceRow.prevCount > 0)
        ? recurrenceRow.count > recurrenceRow.prevCount
          ? "up"
          : recurrenceRow.count < recurrenceRow.prevCount
            ? "down"
            : "flat"
        : undefined;

    return { tag, band: scoreToBand(score), errorCount30d: recurrenceRow?.count ?? 0, trend };
  });
}

// -----------------------------------------------------------------------------
// "what is blocking C1 this month"
// -----------------------------------------------------------------------------

/** One blocking category, as returned by {@link deriveBlocking} — ranked worst-first. */
export type BlockingCategory = {
  tag: TaxonomyTag;
  band: MasteryBand;
  errorCount30d: number;
  /** The most recent `produced_error` event's span -> fix for this tag, or null if none parsed cleanly. */
  example: { span: string; fix: string } | null;
  /** Up to `BLOCKING_WEAKEST_ITEMS` items carrying this tag, weakest first, excluding any already "solido". */
  weakestItems: ItemMastery[];
};

/**
 * The ranked "what is blocking C1 this month" list: the top
 * {@link BLOCKING_TOP_N} taxonomy tags by decayed negative evidence (recency
 * already baked in via `decayFactor` — a tag with the same raw error count
 * ranks worse when those errors are recent), each with its 30-day error
 * count, its most recent error's span -> fix as a concrete example, and its
 * weakest not-yet-"solido" items. A tag with zero `produced_error` evidence
 * ever is never included — this is deliberately empty on a fresh log (the
 * profile page's empty state covers that). Pure and deterministic for a
 * fixed `now`. Note: this also calls `deriveCategoryMastery` (for the
 * card's own band chip), which redundantly re-runs `deriveItemMastery` a
 * second time — an accepted, documented cost given this app's single-user,
 * tiny-data scale (same "a full replay per request is fine" posture as
 * `src/server/scheduler.ts`), not worth the extra plumbing to share.
 */
export function deriveBlocking(db: Db, now: Date = new Date()): BlockingCategory[] {
  const itemMastery = deriveItemMastery(db, now);
  const errorEvents = loadProducedErrorEvents(db, now);
  const recurrence = computeRecurrence(db, now);
  const recurrenceByTag = new Map(recurrence.map((row) => [row.tag, row]));
  const bandByTag = new Map(deriveCategoryMastery(db, now).map((row) => [row.tag, row.band]));

  const eventsByTag = new Map<TaxonomyTag, EventRow[]>();
  for (const row of errorEvents) {
    if (!row.taxonomy) continue;
    const bucket = eventsByTag.get(row.taxonomy);
    if (bucket) bucket.push(row);
    else eventsByTag.set(row.taxonomy, [row]);
  }

  const ranked = [...eventsByTag.entries()]
    .map(([tag, rows]) => {
      const negativeEvidence = rows.reduce((sum, row) => sum + WEIGHT_CATEGORY_ERROR * decayFactor(row.createdAt, now), 0);
      return { tag, rows, negativeEvidence };
    })
    // Most negative (largest-magnitude, most-recent-weighted) evidence first; tag name breaks ties for determinism.
    .sort((a, b) => a.negativeEvidence - b.negativeEvidence || a.tag.localeCompare(b.tag))
    .slice(0, BLOCKING_TOP_N);

  return ranked.map(({ tag, rows }) => {
    const mostRecent = rows.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const parsedExample = mostRecent ? ProducedErrorPayloadSchema.safeParse(mostRecent.payload) : undefined;
    const example = parsedExample?.success ? { span: parsedExample.data.span, fix: parsedExample.data.fix } : null;

    const weakestItems = itemMastery
      .filter((entry) => (entry.item.taxonomy ?? []).includes(tag) && entry.band !== "solido")
      .slice(0, BLOCKING_WEAKEST_ITEMS); // itemMastery is already sorted weakest-first.

    return {
      tag,
      band: bandByTag.get(tag) ?? "fragil",
      errorCount30d: recurrenceByTag.get(tag)?.count ?? 0,
      example,
      weakestItems,
    };
  });
}

