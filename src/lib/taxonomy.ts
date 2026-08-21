/** Error/skill categories used to tag items, errors, and captured chunks. */
export const TAXONOMY = [
  "grammar",
  "preposition",
  "word_choice",
  "collocation",
  "register",
  "idiomaticity",
  "discourse",
  "redundancy",
  "word_order",
  "listening_reduction",
  "listening_lexical",
] as const;
export type TaxonomyTag = (typeof TAXONOMY)[number];

/** Speech register / dialectal scope of a captured chunk. */
export const REGISTERS = ["neutral", "formal", "coloquial_mx", "pan_hispanic"] as const;
export type Register = (typeof REGISTERS)[number];

/** Kinds of entries in the append-only event log. */
export const EVENT_TYPES = [
  "captured",
  "discarded",
  "produced_ok",
  "produced_error",
  "dictation_miss",
  "adjudicated",
  "evaluator_disagreement",
  "reviewed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** App surfaces the learner can practice on. */
export const SURFACES = ["read", "listen", "fix", "talk", "review"] as const;
export type Surface = (typeof SURFACES)[number];

/** CEFR proficiency levels used to rate content difficulty. */
export const CEFR_LEVELS = ["A2", "B1", "B2", "C1", "C2"] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];
