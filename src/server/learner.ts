import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events } from "@/db/schema";
import { DEFAULT_USER_ID } from "@/lib/ids";
import { LearnerBlockSchema, type LearnerBlock } from "@/lib/contracts";
import { TAXONOMY, type TaxonomyTag } from "@/lib/taxonomy";
import { deriveBlocking } from "@/server/mastery";
import { deriveRecentErrorTagCounts, getDueItems, topWeakCategories } from "@/server/scheduler";

const LearnerConfigSchema = z.object({
  level: z.string(),
  goal: z.string(),
  weak_categories: z.array(z.enum(TAXONOMY)),
});
type LearnerConfig = z.infer<typeof LearnerConfigSchema>;

/** A single recent-error entry as we expect it to appear in a `produced_error` event payload. */
const RecentErrorPayloadSchema = z.object({
  tag: z.enum(TAXONOMY),
  example: z.string(),
});

let cachedConfig: LearnerConfig | undefined;

/**
 * Reads and validates `config/learner.json`, caching the parsed result.
 * Exported (not just used internally) so `src/server/scheduler.ts` can reuse
 * its static `weak_categories` as the fallback when there's no recent
 * `produced_error` event data to derive weak categories from.
 */
export function loadLearnerConfig(): LearnerConfig {
  if (!cachedConfig) {
    const filePath = path.join(process.cwd(), "config", "learner.json");
    const raw = fs.readFileSync(filePath, "utf-8");
    cachedConfig = LearnerConfigSchema.parse(JSON.parse(raw));
  }
  return cachedConfig;
}

/** Number of last-30-days `produced_error` events required before weak_categories switches from the config fallback to the derived top-3. */
const WEAK_CATEGORY_EVENT_THRESHOLD = 5;

/**
 * `weak_categories` for the learner block: once at least
 * {@link WEAK_CATEGORY_EVENT_THRESHOLD} `produced_error` events exist in the
 * last 30 days, prefer the mastery model's own ranked "blocking" tags
 * (`deriveBlocking`, `src/server/mastery.ts`) — negative-evidence-and-recency
 * ranked, so it agrees with what the `/profile` page's "Qué te está
 * frenando" headline shows; if that comes back empty for some reason, fall
 * back to the plain frequency-derived top-3 (reusing the scheduler's own
 * counting — see `deriveRecentErrorTagCounts` in `src/server/scheduler.ts`).
 * Below the threshold, the static `config/learner.json` fallback, same
 * posture as the scheduler's own weak-category bucket.
 */
function deriveWeakCategories(db: Db): TaxonomyTag[] {
  const { counts, total } = deriveRecentErrorTagCounts(db);
  if (total >= WEAK_CATEGORY_EVENT_THRESHOLD) {
    const blockingTags = deriveBlocking(db).map((entry) => entry.tag);
    return blockingTags.length > 0 ? blockingTags : topWeakCategories(counts);
  }
  return loadLearnerConfig().weak_categories;
}

/**
 * Builds the learner profile block injected into model prompts: static
 * config (level/goal, and weak_categories as a fallback) plus the most
 * recent production errors and due items pulled from/derived over the event
 * log — see {@link deriveWeakCategories} and `getDueItems`
 * (`src/server/scheduler.ts`).
 */
export function buildLearnerBlock(db: Db): LearnerBlock {
  const config = loadLearnerConfig();

  const recentErrorEvents = db
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.userId, DEFAULT_USER_ID), eq(events.type, "produced_error")))
    .orderBy(desc(events.createdAt))
    .limit(5)
    .all();

  const recent_errors: LearnerBlock["recent_errors"] = [];
  for (const { payload } of recentErrorEvents) {
    const parsed = RecentErrorPayloadSchema.safeParse(payload);
    if (parsed.success) {
      recent_errors.push(parsed.data);
    }
    // Malformed payloads are skipped defensively rather than throwing —
    // the event log is append-only and older/malformed rows shouldn't
    // break prompt construction.
  }

  const block: LearnerBlock = {
    level: config.level,
    variant: "Mexican Spanish",
    goal: config.goal,
    weak_categories: deriveWeakCategories(db),
    recent_errors,
    due_items: getDueItems(db, 5).map((item) => item.chunk),
  };

  return LearnerBlockSchema.parse(block);
}
