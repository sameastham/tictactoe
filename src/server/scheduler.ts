/**
 * The Review scheduler. NOT a flashcard mode: it is a priority-ordered
 * derivation layer over the append-only event log that feeds the other
 * surfaces (due items into Fix's Reto prompts first, a small home-screen
 * queue second) — production first, recognition never.
 *
 * Scheduling state is DERIVED, never stored (see CLAUDE.md's "Architecture
 * rule" for this feature): every item's ts-fsrs `Card` is rebuilt at request
 * time by replaying that item's `captured` -> `reviewed` / `produced_ok` /
 * `item_avoided` events chronologically through `fsrs()`. Single-user, tiny
 * data — a full replay per request is fine and keeps faith with "surfaces
 * are interfaces over the log", not a second source of truth.
 */
import { and, eq, gte, inArray } from "drizzle-orm";
import { createEmptyCard, fsrs, Rating, type Card, type Grade } from "ts-fsrs";
import type { Db } from "@/db";
import { events, items } from "@/db/schema";
import { DEFAULT_USER_ID } from "@/lib/ids";
import {
  DueItemSchema,
  ItemAvoidedPayloadSchema,
  ProducedOkPayloadSchema,
  ReviewedPayloadSchema,
  type DueItem,
  type PriorityReason,
} from "@/lib/contracts";
import type { TaxonomyTag } from "@/lib/taxonomy";
import { loadLearnerConfig } from "@/server/learner";
import type { EventRow, ItemRow } from "@/server/repo";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEAK_CATEGORY_WINDOW_MS = 30 * DAY_MS;
const RECENT_CAPTURE_WINDOW_MS = 7 * DAY_MS;
const RECURRING_ERROR_THRESHOLD = 3;
const TOP_WEAK_CATEGORIES = 3;
const DEFAULT_QUEUE_MAX = 10;

/** Event types that can move an item's FSRS schedule — see `deriveItemSchedule`. */
const SCHEDULABLE_EVENT_TYPES = ["captured", "reviewed", "produced_ok", "item_avoided"] as const;

/** One shared `fsrs()` scheduler instance — default parameters, per CLAUDE.md ("FSRS via ts-fsrs, never a custom algorithm"). */
const scheduler = fsrs();

const RATING_BY_LABEL: Record<"again" | "hard" | "good" | "easy", Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

const BUCKET_ORDER: Record<PriorityReason, number> = {
  recurring_error: 0,
  weak_category: 1,
  recent: 2,
  standard: 3,
};

/** Minimal shape of an `events` row needed to replay one item's schedule. */
export type SchedulingEvent = Pick<EventRow, "type" | "payload" | "createdAt">;

/**
 * The FSRS grade one event represents, or null if it carries no review
 * signal for this item (or its payload fails schema validation — skipped
 * defensively, same posture as `buildLearnerBlock`'s malformed-row handling
 * in `src/server/learner.ts`, since the log is append-only and can't be
 * cleaned up after the fact).
 */
function gradeForEvent(event: SchedulingEvent): Grade | null {
  switch (event.type) {
    case "reviewed": {
      const parsed = ReviewedPayloadSchema.safeParse(event.payload);
      return parsed.success ? RATING_BY_LABEL[parsed.data.rating] : null;
    }
    case "produced_ok": {
      // Using a captured chunk correctly in a Fix paragraph is a genuine
      // production, not mere recognition — it counts as a full "Good" review,
      // per the product spec ("every production event, not just card reviews").
      const parsed = ProducedOkPayloadSchema.safeParse(event.payload);
      return parsed.success ? Rating.Good : null;
    }
    case "item_avoided": {
      // The learner had the chance to use this chunk in a writing and chose
      // not to. That's a mild negative signal, not a wrong-usage failure, so
      // it maps to Hard rather than Again: the review interval shrinks
      // without forcing the card through a full relearning reset the way an
      // actually-forgotten (Again) card would.
      const parsed = ItemAvoidedPayloadSchema.safeParse(event.payload);
      return parsed.success ? Rating.Hard : null;
    }
    default:
      return null;
  }
}

/**
 * Replays one item's events chronologically through ts-fsrs and returns the
 * resulting card (due date, stability, difficulty, ...) as of `now`. Pure —
 * no I/O, no mutation. `events` should already be scoped to this item (e.g.
 * by `events.item_id`); events with `createdAt > now` are ignored
 * (defensive — a signal from "later" than the point being scheduled for
 * must never influence it).
 */
export function deriveItemSchedule(
  events: SchedulingEvent[],
  item: Pick<ItemRow, "id" | "createdAt">,
  now: Date,
): Card {
  const nowMs = now.getTime();
  const sorted = events
    .filter((event) => event.createdAt.getTime() <= nowMs)
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  // Card birth: `captured` is when the item entered the log. Fall back to
  // the item row's own createdAt if the captured event is somehow missing
  // from the slice passed in (defensive only — CLAUDE.md's hard rules mean
  // every item has one).
  const birthEvent = sorted.find((event) => event.type === "captured");
  let card: Card = createEmptyCard(birthEvent?.createdAt ?? item.createdAt);

  for (const event of sorted) {
    if (event.type === "captured") continue;
    const grade = gradeForEvent(event);
    if (grade === null) continue;
    card = scheduler.next(card, event.createdAt, grade).card;
  }

  return card;
}

/**
 * Derives the last-30-days weak-category signals used by `getDueItems`'s
 * priority weighting: which taxonomy tags are "recurring" (>=3 produced_error
 * events) and the top-3 weak categories by recent error frequency. Falls
 * back to `config/learner.json`'s static `weak_categories` when there's no
 * recent error data at all — same fallback posture `buildLearnerBlock` uses
 * for the model-prompt learner block, reused here via `loadLearnerConfig`
 * rather than re-implemented.
 */
function deriveWeakCategorySignals(
  db: Db,
  now: Date,
): { recurringTags: Set<TaxonomyTag>; weakCategories: TaxonomyTag[] } {
  const cutoff = new Date(now.getTime() - WEAK_CATEGORY_WINDOW_MS);
  const rows = db
    .select({ taxonomy: events.taxonomy })
    .from(events)
    .where(and(eq(events.userId, DEFAULT_USER_ID), eq(events.type, "produced_error"), gte(events.createdAt, cutoff)))
    .all();

  const counts = new Map<TaxonomyTag, number>();
  for (const { taxonomy } of rows) {
    if (!taxonomy) continue;
    counts.set(taxonomy, (counts.get(taxonomy) ?? 0) + 1);
  }

  const recurringTags = new Set<TaxonomyTag>();
  for (const [tag, count] of counts) {
    if (count >= RECURRING_ERROR_THRESHOLD) recurringTags.add(tag);
  }

  const weakCategories =
    counts.size > 0
      ? [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, TOP_WEAK_CATEGORIES)
          .map(([tag]) => tag)
      : loadLearnerConfig().weak_categories;

  return { recurringTags, weakCategories };
}

/** Why `item` is being surfaced now, per the product spec's priority weighting (checked in order). */
function priorityReasonFor(
  item: Pick<ItemRow, "taxonomy" | "createdAt">,
  recurringTags: Set<TaxonomyTag>,
  weakCategories: TaxonomyTag[],
  now: Date,
): PriorityReason {
  const tags = item.taxonomy ?? [];
  if (tags.some((tag) => recurringTags.has(tag))) return "recurring_error";
  if (tags.some((tag) => weakCategories.includes(tag))) return "weak_category";
  if (now.getTime() - item.createdAt.getTime() <= RECENT_CAPTURE_WINDOW_MS) return "recent";
  return "standard";
}

function toDueItemDto(item: ItemRow, card: Card, priorityReason: PriorityReason): DueItem {
  return DueItemSchema.parse({
    id: item.id,
    chunk: item.chunk,
    register: item.register,
    originSentence: item.originSentence,
    contrastSet: item.contrastSet ?? null,
    due: card.due.toISOString(),
    priorityReason,
  });
}

/**
 * Every item currently due, ordered by the product spec's priority
 * weighting — recurring-error items (>=3 occurrences of one of the item's
 * tags in the last 30 days) first, then items in the current top-3 weak
 * categories, then items captured in the last 7 days, then everything else;
 * within each bucket, earliest `due` first. `limit` caps the returned list
 * (it does not limit how many items are considered — priority ordering has
 * to see everything due before it can rank it).
 */
export function getDueItems(db: Db, limit = 20, now: Date = new Date()): DueItem[] {
  const allItems = db.select().from(items).where(eq(items.userId, DEFAULT_USER_ID)).all();
  if (allItems.length === 0) return [];

  const relevantEvents = db
    .select()
    .from(events)
    .where(and(eq(events.userId, DEFAULT_USER_ID), inArray(events.type, SCHEDULABLE_EVENT_TYPES)))
    .all();

  const eventsByItem = new Map<string, SchedulingEvent[]>();
  for (const event of relevantEvents) {
    if (!event.itemId) continue;
    const bucket = eventsByItem.get(event.itemId);
    if (bucket) bucket.push(event);
    else eventsByItem.set(event.itemId, [event]);
  }

  const { recurringTags, weakCategories } = deriveWeakCategorySignals(db, now);

  const dueRows = allItems
    .map((item) => ({ item, card: deriveItemSchedule(eventsByItem.get(item.id) ?? [], item, now) }))
    .filter(({ card }) => card.due.getTime() <= now.getTime())
    .map(({ item, card }) => ({
      item,
      card,
      priorityReason: priorityReasonFor(item, recurringTags, weakCategories, now),
    }));

  dueRows.sort((a, b) => {
    const bucketDiff = BUCKET_ORDER[a.priorityReason] - BUCKET_ORDER[b.priorityReason];
    return bucketDiff !== 0 ? bucketDiff : a.card.due.getTime() - b.card.due.getTime();
  });

  return dueRows.slice(0, limit).map(({ item, card, priorityReason }) => toDueItemDto(item, card, priorityReason));
}

/** One home-screen Repaso card: the cloze prompt plus what answering it needs. */
export type QueueCard = {
  item: DueItem;
  cloze: string;
  answer: string;
  contrast: string[] | null;
};

/**
 * Replaces the first verbatim occurrence of `chunk` in `originSentence` with
 * a blank. Falls back to the bare chunk as the prompt when it can't be found
 * — defensive only: the capture-time invariant enforced by
 * `cleanExtractResult` (chunk is always a verbatim substring of
 * origin_sentence) means this branch should be unreachable in practice.
 */
export function buildCloze(originSentence: string, chunk: string): string {
  const idx = originSentence.indexOf(chunk);
  if (idx === -1) return chunk;
  return `${originSentence.slice(0, idx)}____${originSentence.slice(idx + chunk.length)}`;
}

/** The home-screen Repaso queue: due items mapped to renderable card data, capped at `max` (default 10). */
export function getQueueCards(db: Db, max = DEFAULT_QUEUE_MAX, now: Date = new Date()): QueueCard[] {
  return getDueItems(db, max, now).map((item) => ({
    item,
    cloze: buildCloze(item.originSentence, item.chunk),
    answer: item.chunk,
    contrast: item.contrastSet,
  }));
}
