/**
 * The weekly report (`/report`): a read-only derivation over the append-only
 * event log plus the writings/talk_turns/eval_runs tables — no writes, same
 * "surfaces are interfaces over the log" posture as `src/server/scheduler.ts`.
 */
import { and, desc, eq, gte, lt, lte } from "drizzle-orm";
import type { Db } from "@/db";
import { events, evalRuns, items, talkTurns, writings } from "@/db/schema";
import { DEFAULT_USER_ID } from "@/lib/ids";
import { DictationMissPayloadSchema, type DictationMissClass } from "@/lib/contracts";
import type { TaxonomyTag } from "@/lib/taxonomy";

const DAY_MS = 24 * 60 * 60 * 1000;
const RECURRENCE_WINDOW_MS = 30 * DAY_MS;
const DICTATION_WINDOW_MS = 30 * DAY_MS;
/**
 * Minimum gap between an item's capture and its next appearance in
 * production for that appearance to count as "transfer" rather than the
 * learner echoing back the very sentence they just captured it from.
 * Exported so `src/server/mastery.ts` can apply the identical gap when
 * deriving unprompted-production signals for item mastery (plan §5) —
 * one shared policy instead of two competing constants.
 */
export const TRANSFER_MIN_GAP_MS = DAY_MS;

/** UTC calendar-day key (YYYY-MM-DD) — used to count distinct active days without pulling in a timezone library. */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * trim + collapse whitespace + lowercase, for substring "did this chunk show
 * up in their production" matching. Exported so `src/server/mastery.ts`
 * reuses this exact matching rule for its own production-text scans instead
 * of re-implementing it.
 */
export function normalizeForMatch(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

export type WeeklyReport = {
  /** Distinct UTC calendar days, in the trailing 7 days, with at least one event. */
  daysUsedLast7: number;
  /** Which of those trailing-7-day UTC day-keys (YYYY-MM-DD) were active — what the page's Mon-Sun dots render from. */
  activeDays: string[];
  /** `captured` events in the trailing 7 days. */
  itemsCapturedLast7: number;
  /**
   * Items whose chunk turns up (whitespace-normalized, case-insensitive
   * substring) in a writing or a learner talk_turns message created at least
   * one day after the item was captured. Named "transfer" loosely — this is
   * textual appearance, not a claim about correct or fluent usage (a judge
   * verdict, separately, covers that).
   */
  transfer: { count: number; chunks: string[] };
  /** Per-taxonomy `produced_error` counts in the last 30 days vs. the 30 days before that, sorted by current count desc. */
  recurrence: { tag: TaxonomyTag; count: number; prevCount: number }[];
  /** `dictation_miss` counts by miss class in the last 30 days, sorted by count desc. */
  dictation: { missClass: DictationMissClass; count: number }[];
  /** The newest `eval_runs` row, or null if `npm run eval` has never been run. */
  latestEval: { agreement: Record<string, number>; model: string; createdAt: Date } | null;
};

function computeTransfer(db: Db): { count: number; chunks: string[] } {
  const itemRows = db.select().from(items).where(eq(items.userId, DEFAULT_USER_ID)).all();
  if (itemRows.length === 0) return { count: 0, chunks: [] };

  const writingRows = db
    .select({ text: writings.text, createdAt: writings.createdAt })
    .from(writings)
    .where(eq(writings.userId, DEFAULT_USER_ID))
    .all();
  const learnerTurnRows = db
    .select({ text: talkTurns.text, createdAt: talkTurns.createdAt })
    .from(talkTurns)
    .where(and(eq(talkTurns.userId, DEFAULT_USER_ID), eq(talkTurns.role, "learner")))
    .all();

  const production = [...writingRows, ...learnerTurnRows].map((row) => ({
    text: normalizeForMatch(row.text),
    createdAt: row.createdAt,
  }));

  const chunks: string[] = [];
  for (const item of itemRows) {
    const cutoff = item.createdAt.getTime() + TRANSFER_MIN_GAP_MS;
    const chunkNorm = normalizeForMatch(item.chunk);
    const appeared = production.some((p) => p.createdAt.getTime() >= cutoff && p.text.includes(chunkNorm));
    if (appeared) chunks.push(item.chunk);
  }
  return { count: chunks.length, chunks };
}

/**
 * Per-taxonomy `produced_error` counts, this 30-day window vs. the 30 days
 * before that. Exported so `src/server/mastery.ts` reuses this exact
 * current-vs-previous window comparison for its category `errorCount30d` and
 * `trend` (up/down/flat) instead of re-deriving it — the report page's own
 * `TrendBadge` (up/down/flat by `count` vs `prevCount`) is the presentation
 * this feeds in both places.
 */
export function computeRecurrence(db: Db, now: Date): { tag: TaxonomyTag; count: number; prevCount: number }[] {
  const windowStart = new Date(now.getTime() - RECURRENCE_WINDOW_MS);
  const prevWindowStart = new Date(now.getTime() - 2 * RECURRENCE_WINDOW_MS);

  const currentRows = db
    .select({ taxonomy: events.taxonomy })
    .from(events)
    .where(
      and(
        eq(events.userId, DEFAULT_USER_ID),
        eq(events.type, "produced_error"),
        gte(events.createdAt, windowStart),
        lte(events.createdAt, now),
      ),
    )
    .all();
  const prevRows = db
    .select({ taxonomy: events.taxonomy })
    .from(events)
    .where(
      and(
        eq(events.userId, DEFAULT_USER_ID),
        eq(events.type, "produced_error"),
        gte(events.createdAt, prevWindowStart),
        lt(events.createdAt, windowStart),
      ),
    )
    .all();

  const currentCounts = new Map<TaxonomyTag, number>();
  for (const { taxonomy } of currentRows) {
    if (taxonomy) currentCounts.set(taxonomy, (currentCounts.get(taxonomy) ?? 0) + 1);
  }
  const prevCounts = new Map<TaxonomyTag, number>();
  for (const { taxonomy } of prevRows) {
    if (taxonomy) prevCounts.set(taxonomy, (prevCounts.get(taxonomy) ?? 0) + 1);
  }

  const tags = new Set<TaxonomyTag>([...currentCounts.keys(), ...prevCounts.keys()]);
  return [...tags]
    .map((tag) => ({ tag, count: currentCounts.get(tag) ?? 0, prevCount: prevCounts.get(tag) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

function computeDictation(db: Db, now: Date): { missClass: DictationMissClass; count: number }[] {
  const windowStart = new Date(now.getTime() - DICTATION_WINDOW_MS);
  const rows = db
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.userId, DEFAULT_USER_ID),
        eq(events.type, "dictation_miss"),
        gte(events.createdAt, windowStart),
        lte(events.createdAt, now),
      ),
    )
    .all();

  const counts = new Map<DictationMissClass, number>();
  for (const { payload } of rows) {
    const parsed = DictationMissPayloadSchema.safeParse(payload);
    if (!parsed.success) continue;
    counts.set(parsed.data.missClass, (counts.get(parsed.data.missClass) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([missClass, count]) => ({ missClass, count }))
    .sort((a, b) => b.count - a.count);
}

function getLatestEval(db: Db): WeeklyReport["latestEval"] {
  const row = db.select().from(evalRuns).where(eq(evalRuns.userId, DEFAULT_USER_ID)).orderBy(desc(evalRuns.createdAt)).limit(1).get();
  if (!row) return null;
  return { agreement: row.agreement ?? {}, model: row.model, createdAt: row.createdAt };
}

/** Builds the weekly report as of `now` (defaults to the current time). */
export function buildWeeklyReport(db: Db, now: Date = new Date()): WeeklyReport {
  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);

  const recentEventRows = db
    .select({ type: events.type, createdAt: events.createdAt })
    .from(events)
    .where(and(eq(events.userId, DEFAULT_USER_ID), gte(events.createdAt, sevenDaysAgo), lte(events.createdAt, now)))
    .all();

  const activeDays = [...new Set(recentEventRows.map((r) => dayKey(r.createdAt)))].sort();
  const itemsCapturedLast7 = recentEventRows.filter((r) => r.type === "captured").length;

  return {
    daysUsedLast7: activeDays.length,
    activeDays,
    itemsCapturedLast7,
    transfer: computeTransfer(db),
    recurrence: computeRecurrence(db, now),
    dictation: computeDictation(db, now),
    latestEval: getLatestEval(db),
  };
}
