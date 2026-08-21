import { z } from "zod";
import { CEFR_LEVELS, REGISTERS, RUNGS, TAXONOMY } from "@/lib/taxonomy";

/** Learner profile block injected into model prompts. */
export const LearnerBlockSchema = z.object({
  level: z.string(),
  variant: z.literal("Mexican Spanish"),
  goal: z.string(),
  weak_categories: z.array(z.enum(TAXONOMY)),
  recent_errors: z.array(z.object({ tag: z.enum(TAXONOMY), example: z.string() })),
  due_items: z.array(z.string()),
});
export type LearnerBlock = z.infer<typeof LearnerBlockSchema>;

/** A single multi-word chunk extracted from a piece of content. */
export const CandidateSchema = z.object({
  id: z.string(),
  chunk: z.string(),
  origin_sentence: z.string(),
  register: z.enum(REGISTERS),
  why: z.string(),
  contrast_set: z.array(z.string()).nullable(),
  taxonomy: z.array(z.enum(TAXONOMY)).nullable(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

/** Result of extracting learnable chunks from a piece of content. */
export const ExtractResultSchema = z.object({
  difficulty: z.enum(CEFR_LEVELS),
  candidates: z.array(CandidateSchema).min(1).max(12),
});
export type ExtractResult = z.infer<typeof ExtractResultSchema>;

/** Input to the extraction model call. */
export const ExtractInputSchema = z.object({
  title: z.string().nullable(),
  text: z.string().min(40),
});
export type ExtractInput = z.infer<typeof ExtractInputSchema>;

/** One item the learner was asked (or chose) to try to use in this writing. */
export const JudgeTargetItemSchema = z.object({
  id: z.string(),
  chunk: z.string(),
});
export type JudgeTargetItem = z.infer<typeof JudgeTargetItemSchema>;

/** Input to the judge model call: a full learner-produced writing, judged sentence by sentence. */
export const JudgeInputSchema = z.object({
  text: z.string().min(1),
  task: z.string().nullable(),
  target_items: z.array(JudgeTargetItemSchema),
});
export type JudgeInput = z.infer<typeof JudgeInputSchema>;

/** A single issue found within one judged sentence. */
export const JudgeIssueSchema = z.object({
  tag: z.enum(TAXONOMY),
  severity: z.enum(["minor", "major"]),
  /** Verbatim substring of the sentence being judged. */
  span: z.string(),
  /** The corrected span. */
  fix: z.string(),
  /** One line: why this is an issue. */
  note: z.string(),
});
export type JudgeIssue = z.infer<typeof JudgeIssueSchema>;

/**
 * One judged sentence exactly as the model returns it — the wire shape used
 * directly as the `zodOutputFormat` schema for the judge model call.
 */
export const JudgedSentenceWireSchema = z.object({
  /** Verbatim substring of the input text — anchors UI rendering. */
  sentence: z.string(),
  rung: z.enum(RUNGS),
  issues: z.array(JudgeIssueSchema),
  /** Null when `rung` is "natural"/"precise" and there is nothing to add — no invented improvements. */
  better_version: z.string().nullable(),
});
export type JudgedSentenceWire = z.infer<typeof JudgedSentenceWireSchema>;

/** Raw judge model output: one entry per sentence in the learner's writing. */
export const JudgeWireResultSchema = z.object({
  sentences: z.array(JudgedSentenceWireSchema).min(1),
  /** Ids (from `target_items`) the learner productively used. */
  items_used: z.array(z.string()),
  /** Ids (from `target_items`) that were never used. */
  items_avoided: z.array(z.string()),
});
export type JudgeWireResult = z.infer<typeof JudgeWireResultSchema>;

/**
 * A judged sentence enriched by `LanguageService.judge`: adds whether the
 * proposed `better_version` is attested (verbatim, whitespace-normalized) in
 * the content store, rather than merely model-invented.
 */
export const JudgedSentenceSchema = JudgedSentenceWireSchema.extend({
  better_version_attested: z.boolean(),
});
export type JudgedSentence = z.infer<typeof JudgedSentenceSchema>;

/**
 * Full judge result: what `service.judge` returns and what gets persisted on
 * a `writings` row and served to the client.
 */
export const JudgeResultSchema = z.object({
  sentences: z.array(JudgedSentenceSchema),
  items_used: z.array(z.string()),
  items_avoided: z.array(z.string()),
});
export type JudgeResult = z.infer<typeof JudgeResultSchema>;

/** Input to the conversational tutor model call. */
export const ConverseInputSchema = z.object({
  messages: z.array(z.object({ role: z.enum(["learner", "tutor"]), text: z.string() })),
});
export type ConverseInput = z.infer<typeof ConverseInputSchema>;

/** Result of the conversational tutor model call. */
export const ConverseResultSchema = z.object({
  reply: z.string(),
});
export type ConverseResult = z.infer<typeof ConverseResultSchema>;

/** Payload of a `captured` event: a candidate the learner chose to keep. */
export const CapturedPayloadSchema = z.object({
  candidateId: z.string(),
  candidate: CandidateSchema,
  promptVersion: z.string(),
});
export type CapturedPayload = z.infer<typeof CapturedPayloadSchema>;

/** Payload of a `discarded` event: a candidate the learner chose to drop. */
export const DiscardedPayloadSchema = z.object({
  candidateId: z.string(),
  candidate: CandidateSchema,
  promptVersion: z.string(),
});
export type DiscardedPayload = z.infer<typeof DiscardedPayloadSchema>;

/** Payload of a `produced_ok` event: a target item used correctly (or an already-natural sentence). */
export const ProducedOkPayloadSchema = z.object({
  itemId: z.string().nullable(),
  chunk: z.string().nullable(),
  sentence: z.string(),
  rung: z.enum(RUNGS),
  writingId: z.string(),
});
export type ProducedOkPayload = z.infer<typeof ProducedOkPayloadSchema>;

/** Payload of a `produced_error` event: one judged issue within one sentence of a writing. */
export const ProducedErrorPayloadSchema = z.object({
  tag: z.enum(TAXONOMY),
  severity: z.enum(["minor", "major"]),
  span: z.string(),
  fix: z.string(),
  note: z.string(),
  sentence: z.string(),
  writingId: z.string(),
});
export type ProducedErrorPayload = z.infer<typeof ProducedErrorPayloadSchema>;

/** Payload of an `item_avoided` event: a target item the learner never used in a writing. */
export const ItemAvoidedPayloadSchema = z.object({
  itemId: z.string(),
  chunk: z.string(),
  writingId: z.string(),
  task: z.string().nullable(),
});
export type ItemAvoidedPayload = z.infer<typeof ItemAvoidedPayloadSchema>;

/** The four FSRS review ratings, spelled out for wire payloads/bodies. */
export const REVIEW_RATINGS = ["again", "hard", "good", "easy"] as const;
export type ReviewRating = (typeof REVIEW_RATINGS)[number];

/** Payload of a `reviewed` event: a home-screen Repaso card answered by the learner. */
export const ReviewedPayloadSchema = z.object({
  itemId: z.string(),
  chunk: z.string(),
  rating: z.enum(REVIEW_RATINGS),
  mode: z.literal("card"),
});
export type ReviewedPayload = z.infer<typeof ReviewedPayloadSchema>;

/** Payload of an `adjudicated` event: the learner's override of the model's rung for one sentence. */
export const AdjudicatedPayloadSchema = z.object({
  writingId: z.string(),
  sentenceIndex: z.number().int().nonnegative(),
  sentence: z.string(),
  modelRung: z.enum(RUNGS),
  learnerRung: z.enum(RUNGS),
  note: z.string().nullable(),
});
export type AdjudicatedPayload = z.infer<typeof AdjudicatedPayloadSchema>;

/**
 * Union of all event payload shapes. Other event types get real schemas
 * once their surfaces are built; until then they fall back to a loose record.
 */
export type EventPayload =
  | CapturedPayload
  | DiscardedPayload
  | ProducedOkPayload
  | ProducedErrorPayload
  | ItemAvoidedPayload
  | AdjudicatedPayload
  | ReviewedPayload
  | Record<string, unknown>;

/** A model extraction result as persisted on a content row, with provenance. */
export const StoredExtractionSchema = z.object({
  promptVersion: z.string(),
  model: z.string(),
  provider: z.string(),
  extractedAt: z.number(),
  result: ExtractResultSchema,
});
export type StoredExtraction = z.infer<typeof StoredExtractionSchema>;

/** Body of the "create content" API request: either a URL to fetch or raw text. */
export const CreateContentBodySchema = z.union([
  z.object({ url: z.string().url() }),
  z.object({ text: z.string().min(40), title: z.string().optional() }),
]);
export type CreateContentBody = z.infer<typeof CreateContentBodySchema>;

/** Body of the "decide on a candidate" API request. */
export const DecisionBodySchema = z.object({
  contentId: z.string(),
  candidateId: z.string(),
  action: z.enum(["keep", "discard"]),
});
export type DecisionBody = z.infer<typeof DecisionBodySchema>;

/** Body of the "submit a writing for judgment" (Fix) API request. */
export const FixBodySchema = z.object({
  text: z.string().min(1).max(4000),
  task: z.string().optional(),
  targetItemIds: z.array(z.string()).optional(),
});
export type FixBody = z.infer<typeof FixBodySchema>;

/** Body of the "adjudicate a judged sentence" API request. */
export const AdjudicationBodySchema = z.object({
  writingId: z.string(),
  sentenceIndex: z.number().int().min(0),
  learnerRung: z.enum(RUNGS),
  note: z.string().optional(),
});
export type AdjudicationBody = z.infer<typeof AdjudicationBodySchema>;

/** Body of the "review a Repaso card" (POST /api/reviews) API request. */
export const ReviewBodySchema = z.object({
  itemId: z.string(),
  rating: z.enum(REVIEW_RATINGS),
});
export type ReviewBody = z.infer<typeof ReviewBodySchema>;

/**
 * Why the scheduler surfaced this item ahead of others due at the same time —
 * see `getDueItems`'s priority weighting in `src/server/scheduler.ts`.
 */
export const PRIORITY_REASONS = ["recurring_error", "weak_category", "recent", "standard"] as const;
export type PriorityReason = (typeof PRIORITY_REASONS)[number];

/** A due item as served by `GET /api/items/due` and consumed by the Repaso queue. */
export const DueItemSchema = z.object({
  id: z.string(),
  chunk: z.string(),
  register: z.enum(REGISTERS),
  originSentence: z.string(),
  contrastSet: z.array(z.string()).nullable(),
  /** ISO 8601 — the ts-fsrs card's `due` at derivation time. */
  due: z.string(),
  priorityReason: z.enum(PRIORITY_REASONS),
});
export type DueItem = z.infer<typeof DueItemSchema>;

/** A single word's timing within an audio/video transcript. */
export type WordTimestamp = { w: string; startMs: number; endMs: number };
