import { z } from "zod";
import { CEFR_LEVELS, REGISTERS, TAXONOMY } from "@/lib/taxonomy";

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

/** Input to the judge model call: a learner-produced sentence to evaluate. */
export const JudgeInputSchema = z.object({
  sentence: z.string(),
  task: z.string().nullable(),
  targetItemIds: z.array(z.string()),
});
export type JudgeInput = z.infer<typeof JudgeInputSchema>;

/**
 * Judge verdict. `rung` is the product's core naturalness ladder:
 * incorrect < acceptable < natural < precise.
 */
export const JudgeResultSchema = z.object({
  rung: z.enum(["incorrect", "acceptable", "natural", "precise"]),
  errors: z.array(
    z.object({
      tag: z.enum(TAXONOMY),
      severity: z.enum(["minor", "major"]),
      span: z.string(),
      fix: z.string(),
      note: z.string(),
    }),
  ),
  better_version: z.string().nullable(),
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

/**
 * Union of all event payload shapes. Other event types get real schemas
 * once their surfaces are built; until then they fall back to a loose record.
 */
export type EventPayload = CapturedPayload | DiscardedPayload | Record<string, unknown>;

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

/** A single word's timing within an audio/video transcript. */
export type WordTimestamp = { w: string; startMs: number; endMs: number };
