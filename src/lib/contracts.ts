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
  topic: z.string(),
  messages: z.array(z.object({ role: z.enum(["learner", "tutor"]), text: z.string() })),
});
export type ConverseInput = z.infer<typeof ConverseInputSchema>;

/** Result of the conversational tutor model call. */
export const ConverseResultSchema = z.object({
  reply: z.string(),
});
export type ConverseResult = z.infer<typeof ConverseResultSchema>;

// -----------------------------------------------------------------------------
// seed_error — gold-set error injection (never a user-facing surface; used only
// by `src/server/goldset/build.ts`'s model mode, see CLAUDE.md Sec.3/Sec.5).
// -----------------------------------------------------------------------------

/** Input to the seed-error model call: one confirmed-natural sentence + which error-type tags may be injected. */
export const SeedErrorInputSchema = z.object({
  sentence: z.string().min(8),
  allowed_tags: z.array(z.enum(TAXONOMY)).min(1),
});
export type SeedErrorInput = z.infer<typeof SeedErrorInputSchema>;

/**
 * Raw seed-error model output — the wire shape used directly as the
 * `zodOutputFormat` schema for the seed_error model call. When `can_inject`
 * is `false`, every other field is `null` (the model found nothing
 * realistically injectable of the offered `allowed_tags`, or the sentence
 * already reads as marked/incorrect). When `can_inject` is `true`, all five
 * other fields are non-null: `original_span`/`mutated_span` are the exact
 * substring replaced and its replacement (both verbatim), and `mutated` is
 * `sentence` with that one replacement applied — `verifySingleChange`
 * (`src/server/goldset/build.ts`) is the rule check that confirms the model
 * actually held to that contract before a mutation is ever inserted into
 * `gold_set`.
 */
export const SeedErrorWireResultSchema = z.object({
  can_inject: z.boolean(),
  mutated: z.string().nullable(),
  tag: z.enum(TAXONOMY).nullable(),
  expected_rung: z.enum(["incorrect", "acceptable"]).nullable(),
  /** Verbatim substring of the input `sentence` — the span that was replaced. */
  original_span: z.string().nullable(),
  /** Its replacement — the broken form actually spliced into `mutated`. */
  mutated_span: z.string().nullable(),
});
export type SeedErrorWireResult = z.infer<typeof SeedErrorWireResultSchema>;

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
  | DictationMissPayload
  | SyllabusAdvancedPayload
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

/**
 * Body of the "ingest media from a URL" (POST /api/media, JSON branch) API
 * request — the Listen surface's YouTube/podcast ingestion path (plan §4.1,
 * see `src/server/mediafetch/`). The existing multipart-upload branch of
 * `POST /api/media` is untouched; this is the alternate `application/json`
 * body the route also accepts.
 */
export const MediaUrlBodySchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
});
export type MediaUrlBody = z.infer<typeof MediaUrlBodySchema>;

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

/**
 * Fluency markers derived from one spoken turn's word timestamps — pure,
 * client-safe (`computeFluency` in `src/lib/fluency.ts`), never model-judged.
 * `durationMs`/`wordCount`/`wordsPerMin`/`pausesOver800Ms`/`longestPauseMs`/
 * `fillerCount` are all zero for a zero-word transcript.
 */
export const FluencyMetricsSchema = z.object({
  durationMs: z.number().int().nonnegative(),
  wordCount: z.number().int().nonnegative(),
  wordsPerMin: z.number().nonnegative(),
  pausesOver800Ms: z.number().int().nonnegative(),
  longestPauseMs: z.number().int().nonnegative(),
  fillerCount: z.number().int().nonnegative(),
});
export type FluencyMetrics = z.infer<typeof FluencyMetricsSchema>;

/** One transcript segment cut for dictation practice — see `buildSegments` in `src/lib/segments.ts`. */
export const TranscriptSegmentSchema = z.object({
  index: z.number().int(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  text: z.string(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

/**
 * How a dictation miss was classified (Listen surface). `lexical`/`reduction`
 * map onto the taxonomy (`listening_lexical`/`listening_reduction`);
 * `proper_noun`/`near_miss` are tracked in the payload only — they are not
 * acquisition gaps, see `missClassToTaxonomy` in `src/lib/dictation.ts`.
 */
export const DictationMissClassSchema = z.enum(["lexical", "reduction", "proper_noun", "near_miss"]);
export type DictationMissClass = z.infer<typeof DictationMissClassSchema>;

/** One miss found by diffing a dictation attempt's typed text against its segment transcript. */
export const DictationMissSchema = z.object({
  expected: z.string(),
  heard: z.string().nullable(),
  class: DictationMissClassSchema,
});
export type DictationMiss = z.infer<typeof DictationMissSchema>;

/** Payload of a `dictation_miss` event: one miss within one dictation attempt. */
export const DictationMissPayloadSchema = z.object({
  contentId: z.string(),
  segmentIndex: z.number().int(),
  segmentText: z.string(),
  expected: z.string(),
  heard: z.string().nullable(),
  missClass: DictationMissClassSchema,
  attemptId: z.string(),
});
export type DictationMissPayload = z.infer<typeof DictationMissPayloadSchema>;

/** Body of the "submit a dictation attempt" (POST /api/dictation) API request. */
export const DictationAttemptBodySchema = z.object({
  contentId: z.string(),
  segmentIndex: z.number().int().min(0),
  typed: z.string(),
});
export type DictationAttemptBody = z.infer<typeof DictationAttemptBodySchema>;

/** Body of the "capture an item from a dictation miss" (POST /api/dictation/capture) API request. */
export const CaptureMissBodySchema = z.object({
  contentId: z.string(),
  segmentIndex: z.number().int().min(0),
  chunk: z.string(),
});
export type CaptureMissBody = z.infer<typeof CaptureMissBodySchema>;

/**
 * Body of the "reformulate a dictation segment in your own words" (POST
 * /api/listen/produce) API request — the listening->production follow-up
 * ("Ahora dilo tú", plan §4.1).
 */
export const ListenProduceBodySchema = z.object({
  contentId: z.string(),
  segmentIndex: z.number().int().min(0),
  text: z.string().min(1).max(1000),
});
export type ListenProduceBody = z.infer<typeof ListenProduceBodySchema>;

// -----------------------------------------------------------------------------
// Talk surface
// -----------------------------------------------------------------------------

/** Body of "start a Talk session" (POST /api/talk/start) — empty: the topic is server-seeded, never client-chosen. */
export const TalkStartBodySchema = z.object({});
export type TalkStartBody = z.infer<typeof TalkStartBodySchema>;

/**
 * Metadata attached to one learner turn recorded via the voice-mode
 * recorder (plan §4.3 week 7). Tutor turns never carry `meta`. `kind` is a
 * discriminant left room to grow (e.g. a future `"reduction_drill"` turn
 * kind) without breaking existing stored rows.
 */
export const TalkTurnMetaSchema = z.object({
  kind: z.literal("voice"),
  fluency: FluencyMetricsSchema,
});
export type TalkTurnMeta = z.infer<typeof TalkTurnMetaSchema>;

/** Body of "send a Talk message" (POST /api/talk/message). */
export const TalkMessageBodySchema = z.object({
  sessionId: z.string(),
  text: z.string().min(1).max(1000),
  /** Present when this turn originated from the voice recorder — see `TalkTurnMetaSchema`. */
  meta: TalkTurnMetaSchema.optional(),
});
export type TalkMessageBody = z.infer<typeof TalkMessageBodySchema>;

/** Body of "end a Talk session" (POST /api/talk/end). */
export const TalkEndBodySchema = z.object({
  sessionId: z.string(),
});
export type TalkEndBody = z.infer<typeof TalkEndBodySchema>;

/**
 * Fluency markers aggregated across a Talk session's voice-mode learner
 * turns (see `TalkTurnMetaSchema`) — plain stats, no naturalness judgment.
 * `avgWordsPerMin` averages each voice turn's own `wordsPerMin` (not a
 * pooled recompute over merged word arrays, since separate turns' word
 * timestamps aren't a single continuous timeline).
 */
export const FluencyAggregateSchema = z.object({
  voiceTurns: z.number().int().nonnegative(),
  avgWordsPerMin: z.number().nonnegative(),
  totalPausesOver800Ms: z.number().int().nonnegative(),
  totalFillers: z.number().int().nonnegative(),
});
export type FluencyAggregate = z.infer<typeof FluencyAggregateSchema>;

/**
 * Post-session Talk report: evaluation runs asynchronously after the
 * conversation ends (never mid-chat), and this is its full shape — the
 * judged transcript, which target items came up and which didn't, and up to
 * three concrete practice pointers derived from the judgment's issue tags.
 * `judgment` is `null` when the session ended with nothing to judge (no
 * learner turns) or the judge call itself failed. `fluency` is `null` when
 * the session had no voice-mode learner turns.
 */
export const TalkReportSchema = z.object({
  sessionId: z.string(),
  topic: z.string().nullable(),
  judgment: JudgeResultSchema.nullable(),
  itemsUsed: z.array(z.string()),
  itemsAvoided: z.array(z.string()),
  practiceNext: z.array(z.string()).max(3),
  fluency: FluencyAggregateSchema.nullable(),
});
export type TalkReport = z.infer<typeof TalkReportSchema>;

// -----------------------------------------------------------------------------
// Syllabus (Dicho y hecho curriculum) — see src/server/syllabus/config.ts
// -----------------------------------------------------------------------------

/** One section within a syllabus unit: its title and a tight paraphrase of the book's stated objectives. */
export const SyllabusSectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  objectives: z.array(z.string()),
});
export type SyllabusSection = z.infer<typeof SyllabusSectionSchema>;

/** A Fix-ready writing prompt derived from a unit's task-based goal, targeting one or more of the unit's constructions. */
export const SyllabusTareaSchema = z.object({
  id: z.string(),
  /** Spanish, actionable writing task — passed straight to the Fix surface as `task`. */
  prompt: z.string(),
  targetConstructionIds: z.array(z.string()),
});
export type SyllabusTarea = z.infer<typeof SyllabusTareaSchema>;

/** One grammatical construction/chunk the book explicitly teaches in a unit, mined from its grammar boxes and/or the grammar annex. */
export const SyllabusConstructionSchema = z.object({
  id: z.string(),
  /** The construction as a capturable chunk, e.g. "por más que". */
  chunk: z.string(),
  description: z.string(),
  tag: z.enum(TAXONOMY),
});
export type SyllabusConstruction = z.infer<typeof SyllabusConstructionSchema>;

/** One unit of a syllabus level: its sections, target constructions, and Fix tareas. */
export const SyllabusUnitSchema = z.object({
  id: z.string(),
  title: z.string(),
  theme: z.string(),
  sections: z.array(SyllabusSectionSchema),
  constructions: z.array(SyllabusConstructionSchema),
  tareas: z.array(SyllabusTareaSchema),
});
export type SyllabusUnit = z.infer<typeof SyllabusUnitSchema>;

/** A full curriculum level (e.g. "dyh7") — one `config/syllabus/*.json` file validates against this. */
export const SyllabusLevelSchema = z.object({
  id: z.string(),
  series: z.literal("dicho-y-hecho"),
  name: z.string(),
  cefr: z.string(),
  units: z.array(SyllabusUnitSchema).min(1),
});
export type SyllabusLevel = z.infer<typeof SyllabusLevelSchema>;

/** Payload of a `syllabus_advanced` event: the learner explicitly moved on to a new syllabus level/unit. */
export const SyllabusAdvancedPayloadSchema = z.object({
  level: z.string(),
  unit: z.string(),
});
export type SyllabusAdvancedPayload = z.infer<typeof SyllabusAdvancedPayloadSchema>;

/** Body of "advance to a new syllabus unit" (POST /api/syllabus/advance) API request. */
export const AdvanceSyllabusBodySchema = z.object({
  level: z.string(),
  unit: z.string(),
});
export type AdvanceSyllabusBody = z.infer<typeof AdvanceSyllabusBodySchema>;

// -----------------------------------------------------------------------------
// Book ingestion report — src/server/syllabus/ingest.ts's `ingestBook`, shared
// by scripts/ingest-book.ts (CLI) and POST /api/syllabus/ingest (Plan page's
// UI-driven ingest form). Both render the SAME report shape; only the
// presentation differs (a printed table vs. JSON).
// -----------------------------------------------------------------------------

/** One section's ingestion outcome within one syllabus unit. */
export const SectionIngestResultSchema = z.object({
  unitId: z.string(),
  sectionId: z.string(),
  syllabusRef: z.string(),
  title: z.string(),
  contentId: z.string(),
  textLength: z.number().int().nonnegative(),
  alreadyExisted: z.boolean(),
});
export type SectionIngestResult = z.infer<typeof SectionIngestResultSchema>;

/** One construction's ingestion outcome. */
export const ConstructionIngestResultSchema = z.object({
  constructionId: z.string(),
  chunk: z.string(),
  status: z.enum(["found", "unfound", "already_seeded"]),
  /** The section id the chunk's first occurrence was found in — only set when `status === "found"`. */
  foundInSectionId: z.string().optional(),
});
export type ConstructionIngestResult = z.infer<typeof ConstructionIngestResultSchema>;

/** One unit's full ingestion outcome — the shape both the CLI and the ingest API render as the per-unit report. */
export const UnitIngestResultSchema = z.object({
  unitId: z.string(),
  title: z.string(),
  sections: z.array(SectionIngestResultSchema),
  constructions: z.array(ConstructionIngestResultSchema),
});
export type UnitIngestResult = z.infer<typeof UnitIngestResultSchema>;

/** Full ingestion run outcome — returned by `ingestBook` and served as `POST /api/syllabus/ingest`'s `{ report }` body. */
export const IngestReportSchema = z.object({
  levelId: z.string(),
  units: z.array(UnitIngestResultSchema),
  /** Config sections for which NO page of any given PDF was found (heading never matched) — a real mismatch worth investigating, not just an empty section. */
  missingSections: z.array(z.string()),
});
export type IngestReport = z.infer<typeof IngestReportSchema>;
