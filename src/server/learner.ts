import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events } from "@/db/schema";
import { DEFAULT_USER_ID } from "@/lib/ids";
import { LearnerBlockSchema, type LearnerBlock } from "@/lib/contracts";
import { TAXONOMY } from "@/lib/taxonomy";

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

/** Reads and validates `config/learner.json`, caching the parsed result. */
function loadLearnerConfig(): LearnerConfig {
  if (!cachedConfig) {
    const filePath = path.join(process.cwd(), "config", "learner.json");
    const raw = fs.readFileSync(filePath, "utf-8");
    cachedConfig = LearnerConfigSchema.parse(JSON.parse(raw));
  }
  return cachedConfig;
}

/**
 * Builds the learner profile block injected into model prompts: static
 * config (level/goal/weak_categories) plus the most recent production
 * errors pulled from the event log. `due_items` is always empty for now —
 * the spaced-repetition scheduler that would populate it doesn't exist yet.
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
    weak_categories: config.weak_categories,
    recent_errors,
    due_items: [],
  };

  return LearnerBlockSchema.parse(block);
}
