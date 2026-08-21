/**
 * Spanish display labels for enum-ish values used across the UI. Client-safe:
 * no `fs`, no db.
 */
import type { Register, Rung } from "@/lib/taxonomy";
import type { TaxonomyTag } from "@/lib/taxonomy";

export const REGISTER_LABELS: Record<Register, string> = {
  neutral: "Neutro",
  formal: "Formal",
  coloquial_mx: "Coloquial (MX)",
  pan_hispanic: "Panhispánico",
};

/**
 * Full Tailwind class strings for each register's chip, keyed by register.
 * Written out in full (not built via template-literal interpolation) so
 * Tailwind's source scanner can statically discover every class it needs to
 * generate — a dynamically-interpolated class name like
 * `border-register-${x}-border` would never be emitted.
 */
export const REGISTER_CHIP_CLASSES: Record<Register, string> = {
  neutral: "border-register-neutral-border bg-register-neutral-bg text-register-neutral-fg",
  formal: "border-register-formal-border bg-register-formal-bg text-register-formal-fg",
  coloquial_mx: "border-register-coloquial-border bg-register-coloquial-bg text-register-coloquial-fg",
  pan_hispanic: "border-register-panhispanic-border bg-register-panhispanic-bg text-register-panhispanic-fg",
};

export const TAXONOMY_LABELS: Record<TaxonomyTag, string> = {
  grammar: "Gramática",
  preposition: "Preposición",
  word_choice: "Elección de palabra",
  collocation: "Colocación",
  register: "Registro",
  idiomaticity: "Idiomaticidad",
  discourse: "Discurso",
  redundancy: "Redundancia",
  word_order: "Orden de palabras",
  listening_reduction: "Reducción auditiva",
  listening_lexical: "Léxico auditivo",
};

export const SOURCE_LABELS: Record<"url" | "paste", string> = {
  url: "URL",
  paste: "Pegado",
};

/** Spanish labels for the Fix surface's naturalness ladder (`RUNGS`), low to high. */
export const RUNG_LABELS: Record<Rung, string> = {
  incorrect: "Incorrecta",
  acceptable: "Aceptable",
  natural: "Natural",
  precise: "Precisa",
};

/**
 * Full Tailwind class strings for a rung's chip/badge, keyed by rung.
 * Written out in full (not built via template-literal interpolation) so
 * Tailwind's source scanner can statically discover every class it needs to
 * generate — see the identical rationale on `REGISTER_CHIP_CLASSES` above.
 */
export const RUNG_CHIP_CLASSES: Record<Rung, string> = {
  incorrect: "border-rung-incorrect-border bg-rung-incorrect-bg text-rung-incorrect-fg",
  acceptable: "border-rung-acceptable-border bg-rung-acceptable-bg text-rung-acceptable-fg",
  natural: "border-rung-natural-border bg-rung-natural-bg text-rung-natural-fg",
  precise: "border-rung-precise-border bg-rung-precise-bg text-rung-precise-fg",
};

/**
 * Left-edge-only border color for a rung, used on sentence result cards
 * (paired with a neutral `border-line` on the other three sides). Kept out
 * of `RUNG_CHIP_CLASSES` because chips want all four sides colored, cards
 * want only the accent edge.
 */
export const RUNG_EDGE_CLASSES: Record<Rung, string> = {
  incorrect: "border-l-rung-incorrect-border",
  acceptable: "border-l-rung-acceptable-border",
  natural: "border-l-rung-natural-border",
  precise: "border-l-rung-precise-border",
};

export const SEVERITY_LABELS: Record<"minor" | "major", string> = {
  minor: "leve",
  major: "grave",
};
