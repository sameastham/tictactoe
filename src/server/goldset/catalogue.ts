/**
 * Deterministic, rule-based B2->C1 error catalogue for the seeded-error gold
 * set (see `buildSeededErrors` in `src/server/goldset/build.ts`). This is a
 * v1 substitute for the founding plan's model-based error injection: a rule
 * match is trivially satisfiable by construction, but it needs no model call
 * and is fully reproducible, which is what a gold set actually needs.
 *
 * Each entry is a real, defensible B2->C1 error type in Mexican Spanish —
 * reviewed for linguistic correctness, not just pattern-matched. `natural`
 * matches (case-insensitively) the correct form in an authentic sentence;
 * `broken` is the substituted error form. Applied via first-match
 * replacement (see `applyInjector`) — a sentence only qualifies for seeding
 * when EXACTLY ONE injector matches it (see `findMatchingInjectors` and
 * `buildSeededErrors`), so two overlapping error types never collide in one
 * seeded sentence.
 */
import type { TaxonomyTag } from "@/lib/taxonomy";

export interface Injector {
  id: string;
  tag: TaxonomyTag;
  expectedRung: "incorrect" | "acceptable";
  natural: RegExp | string;
  broken: string;
}

export const CATALOGUE: Injector[] = [
  // --- word_choice: calques of English "to make sense" -------------------
  {
    id: "tiene_sentido",
    tag: "word_choice",
    expectedRung: "incorrect",
    natural: "tiene sentido",
    broken: "hace sentido",
  },
  {
    id: "tener_sentido",
    tag: "word_choice",
    expectedRung: "incorrect",
    natural: "tener sentido",
    broken: "hacer sentido",
  },

  // --- preposition ---------------------------------------------------------
  // Queísmo: dropping the required "de" before a "que" clause governed by
  // "depender". Genuinely misunderstood/marked when a learner does it
  // (unlike native colloquial queísmo elsewhere — see the grammar entry
  // below for that distinction).
  {
    id: "depende_de_que",
    tag: "preposition",
    expectedRung: "incorrect",
    natural: "depende de que",
    broken: "depende que",
  },
  // Calque of English "depend ON" -> wrong preposition on "depender".
  {
    id: "depender_de",
    tag: "preposition",
    expectedRung: "incorrect",
    natural: "depender de",
    broken: "depender en",
  },
  // Calque of English "dream OF/ABOUT" -> wrong preposition on "soñar".
  {
    id: "sonar_con",
    tag: "preposition",
    expectedRung: "incorrect",
    natural: "soñar con",
    broken: "soñar de",
  },

  // --- collocation: right words, wrong pairing ----------------------------
  // Calque of English "make a decision" -> "tomar" is the native verb.
  {
    id: "tomar_decision",
    tag: "collocation",
    expectedRung: "acceptable",
    natural: "tomar una decisión",
    broken: "hacer una decisión",
  },
  // Calque of English "make a mistake" -> "cometer" is the native verb.
  {
    id: "cometer_error",
    tag: "collocation",
    expectedRung: "acceptable",
    natural: "cometer un error",
    broken: "hacer un error",
  },

  // --- redundancy ------------------------------------------------------------
  // Doubling the intensifier instead of reaching for a stronger word
  // ("bien", "súper", "sumamente") or leaving "muy" alone. Matches a single
  // standalone "muy" (word boundary, no other injector overlap) via
  // first-match replacement — deliberately not global, so only the first
  // occurrence in the sentence is doubled.
  {
    id: "muy_redundant",
    tag: "redundancy",
    expectedRung: "acceptable",
    natural: /\bmuy\b/,
    broken: "muy muy",
  },

  // --- grammar ---------------------------------------------------------------
  // Queísmo after "darse cuenta de que": extremely common even among
  // educated native speakers in casual registers, hence "acceptable" (marked
  // but understood) rather than "incorrect" — unlike the learner-calque
  // preposition drop above, this one is a natural register variant, not a
  // comprehension failure.
  {
    id: "queismo_darse_cuenta",
    tag: "grammar",
    expectedRung: "acceptable",
    natural: "me di cuenta de que",
    broken: "me di cuenta que",
  },

  // --- idiomaticity ------------------------------------------------------------
  // Grammatically fine, transparently reconstructed from the pieces of the
  // real idiom ("a fin de cuentas") — a native almost never says it this way.
  {
    id: "a_fin_de_cuentas",
    tag: "idiomaticity",
    expectedRung: "acceptable",
    natural: "a fin de cuentas",
    broken: "al final de las cuentas",
  },
];

/** Escapes a string for safe interpolation into a `RegExp` source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive, non-global RegExp for an injector's `natural` pattern (first match only, per file doc). */
function patternFor(injector: Injector): RegExp {
  if (injector.natural instanceof RegExp) {
    // Re-flag defensively: force case-insensitive, strip "g" so `.match`
    // always returns the first occurrence rather than iterator state.
    return new RegExp(injector.natural.source, injector.natural.flags.replace(/[gi]/g, "") + "i");
  }
  return new RegExp(escapeRegExp(injector.natural), "i");
}

/** True if `injector`'s pattern matches anywhere in `sentence`. */
export function injectorMatches(injector: Injector, sentence: string): boolean {
  return patternFor(injector).test(sentence);
}

/** Every catalogue injector (default `CATALOGUE`) whose pattern matches `sentence`. */
export function findMatchingInjectors(sentence: string, catalogue: Injector[] = CATALOGUE): Injector[] {
  return catalogue.filter((injector) => injectorMatches(injector, sentence));
}

/** Uppercases `target`'s first letter when `source`'s first letter was uppercase, else leaves it as authored. */
function matchCase(source: string, target: string): string {
  if (source.length === 0 || target.length === 0) return target;
  const first = source.charAt(0);
  if (first === first.toUpperCase() && first !== first.toLowerCase()) {
    return target.charAt(0).toUpperCase() + target.slice(1);
  }
  return target;
}

/**
 * The exact original and replacement spans {@link applyInjector} would use
 * for `injector` against `sentence` — `original` is the verbatim matched
 * substring, `replacement` is `injector.broken` case-matched to it, `index`
 * is where the match starts. Returns `null` if the pattern doesn't match.
 * Exported so callers that need the literal spans (not just the mutated
 * sentence) — e.g. `FixtureProvider`'s "seed_error" purpose, which reuses
 * this catalogue to build a `SeedErrorWireResult` — don't have to
 * reimplement the matching/case logic.
 */
export function injectorSpans(
  injector: Injector,
  sentence: string,
): { original: string; replacement: string; index: number } | null {
  const match = sentence.match(patternFor(injector));
  if (!match || match.index === undefined) return null;
  const matchedText = match[0];
  return { original: matchedText, replacement: matchCase(matchedText, injector.broken), index: match.index };
}

/**
 * Applies `injector` to `sentence`: replaces the first (only) match of its
 * `natural` pattern with `broken`, capitalizing the replacement to match the
 * matched text's case (so a sentence-initial match stays capitalized).
 * Returns `sentence` unchanged if the pattern doesn't match — callers should
 * check {@link injectorMatches} first.
 */
export function applyInjector(injector: Injector, sentence: string): string {
  const spans = injectorSpans(injector, sentence);
  if (!spans) return sentence;
  return sentence.slice(0, spans.index) + spans.replacement + sentence.slice(spans.index + spans.original.length);
}
