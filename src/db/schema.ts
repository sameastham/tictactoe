import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { CEFR_LEVELS, EVENT_TYPES, REGISTERS, SURFACES, TAXONOMY, type TaxonomyTag } from "@/lib/taxonomy";
import type { EventPayload, JudgeResult, StoredExtraction, WordTimestamp } from "@/lib/contracts";

/** A piece of source content (article/paste/audio/video) the learner consumed. */
export const content = sqliteTable(
  "content",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    source: text("source", { enum: ["url", "paste"] }).notNull(),
    sourceUrl: text("source_url"),
    type: text("type", { enum: ["article", "paste", "audio", "video"] }).notNull(),
    title: text("title"),
    text: text("text").notNull(),
    transcript: text("transcript"),
    wordTimestamps: text("word_timestamps", { mode: "json" }).$type<WordTimestamp[]>(),
    difficulty: text("difficulty", { enum: CEFR_LEVELS }),
    extraction: text("extraction", { mode: "json" }).$type<StoredExtraction>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("content_user_created_idx").on(table.userId, table.createdAt)],
);

/** A captured, learnable multi-word chunk, tied back to the sentence it came from. */
export const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    chunk: text("chunk").notNull(),
    register: text("register", { enum: REGISTERS }).notNull(),
    contrastSet: text("contrast_set", { mode: "json" }).$type<string[]>(),
    originContentId: text("origin_content_id").references(() => content.id),
    originSentence: text("origin_sentence").notNull(),
    why: text("why").notNull(),
    taxonomy: text("taxonomy", { mode: "json" }).$type<TaxonomyTag[]>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("items_user_created_idx").on(table.userId, table.createdAt),
    index("items_origin_idx").on(table.originContentId),
  ],
);

/** A practice session on a given surface, optionally tied to a piece of content. */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    surface: text("surface", { enum: SURFACES }).notNull(),
    contentId: text("content_id").references(() => content.id),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    durationS: integer("duration_s"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("sessions_user_started_idx").on(table.userId, table.startedAt)],
);

/** A learner-produced piece of writing (Fix surface), and the judge's verdict on it once judged. */
export const writings = sqliteTable(
  "writings",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    task: text("task"),
    text: text("text").notNull(),
    judgment: text("judgment", { mode: "json" }).$type<JudgeResult>(),
    promptVersion: text("prompt_version"),
    model: text("model"),
    sessionId: text("session_id").references(() => sessions.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("writings_user_created_idx").on(table.userId, table.createdAt)],
);

/** The append-only event log — the single source of truth for everything that happens. */
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    type: text("type", { enum: EVENT_TYPES }).notNull(),
    surface: text("surface", { enum: SURFACES }).notNull(),
    taxonomy: text("taxonomy", { enum: TAXONOMY }),
    severity: text("severity", { enum: ["minor", "major"] }),
    confidence: real("confidence"),
    itemId: text("item_id").references(() => items.id),
    contentId: text("content_id").references(() => content.id),
    sessionId: text("session_id").references(() => sessions.id),
    payload: text("payload", { mode: "json" }).$type<EventPayload>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("events_user_created_idx").on(table.userId, table.createdAt),
    index("events_user_type_idx").on(table.userId, table.type),
    index("events_item_idx").on(table.itemId),
  ],
);

/** Hand-curated / adjudicated sentences used to evaluate judge model quality. */
export const goldSet = sqliteTable("gold_set", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  sentence: text("sentence").notNull(),
  // Column is named `set_name` in SQL to avoid the reserved word SET.
  set: text("set_name", { enum: ["natural_control", "seeded_error", "adjudicated"] }).notNull(),
  expectedRung: text("expected_rung"),
  expectedTags: text("expected_tags", { mode: "json" })
    .$type<TaxonomyTag[]>()
    .notNull()
    .default(sql`'[]'`),
  origin: text("origin"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/** A batch evaluation run of a prompt/model against the gold set. */
export const evalRuns = sqliteTable("eval_runs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  promptName: text("prompt_name").notNull(),
  promptVersion: text("prompt_version").notNull(),
  model: text("model").notNull(),
  agreement: text("agreement", { mode: "json" }).$type<Record<string, number>>(),
  costUsd: real("cost_usd"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  notes: text("notes"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/** Log of every model API call made, for cost/latency/error tracking. */
export const modelCalls = sqliteTable(
  "model_calls",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    purpose: text("purpose", { enum: ["extract", "judge", "converse"] }).notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull(),
    durationMs: integer("duration_ms").notNull(),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    error: text("error"),
    contentId: text("content_id").references(() => content.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("model_calls_user_created_idx").on(table.userId, table.createdAt)],
);
