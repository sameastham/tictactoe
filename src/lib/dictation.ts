import type { DictationMiss, DictationMissClass } from "@/lib/contracts";
import type { TaxonomyTag } from "@/lib/taxonomy";

// -----------------------------------------------------------------------------
// normalization
// -----------------------------------------------------------------------------

const PUNCTUATION_RE = /[¿¡.,;:!?"«»…—]/g; // ¿¡.,;:!?"«»…—

/**
 * A private-use-area placeholder that protects `ñ` from NFD accent-stripping
 * — chosen because it can never occur in real transcript/typed text and is
 * itself unaffected by `.normalize("NFD")`.
 */
const NTILDE_PLACEHOLDER = "";

/** Combining diacritical marks block (U+0300-U+036F) — what NFD splits accents into. */
const COMBINING_MARKS_RE = /[̀-ͯ]/g;

/**
 * Normalizes one token for dictation comparison: lowercase, strip
 * punctuation, strip accents via NFD decomposition — except `ñ`, which stays
 * distinct from `n` (Spanish treats them as different letters; "año" and
 * "ano" must not compare equal). Whitespace is not touched — callers
 * tokenize on whitespace before calling this.
 */
export function normalizeToken(t: string): string {
  const noPunct = t.replace(PUNCTUATION_RE, "");
  const lower = noPunct.toLowerCase();
  const protectedNtilde = lower.split("ñ").join(NTILDE_PLACEHOLDER); // ñ -> placeholder
  const stripped = protectedNtilde.normalize("NFD").replace(COMBINING_MARKS_RE, "");
  return stripped.split(NTILDE_PLACEHOLDER).join("ñ"); // placeholder -> ñ
}

// -----------------------------------------------------------------------------
// classification
// -----------------------------------------------------------------------------

/**
 * Spanish function words: articles, common prepositions, clitic pronouns,
 * short auxiliary/conjunction forms. A miss on one of these is very often a
 * connected-speech reduction (elision/liaison swallowing an unstressed
 * grammatical particle) rather than a vocabulary gap — see `classifyMiss`.
 */
const FUNCTION_WORDS = new Set([
  "de", "la", "el", "los", "las", "un", "una", "se", "le", "lo", "me", "te", "nos",
  "ha", "he", "has", "han", "y", "o", "a", "en", "que", "es", "al", "del", "con",
  "por", "para", "su", "sus", "mi", "tu", "ya", "no", "si",
]);

/** Small inline Levenshtein (edit distance) over two strings — O(len(a)*len(b)), rolling-row DP. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const prevRow = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prevRow[j] = j;

  for (let i = 1; i <= m; i++) {
    let diag = prevRow[0];
    prevRow[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = prevRow[j];
      prevRow[j] = a[i - 1] === b[j - 1] ? diag : 1 + Math.min(diag, prevRow[j], prevRow[j - 1]);
      diag = temp;
    }
  }
  return prevRow[n];
}

/** True if `raw`'s first character is uppercase and it's not the first word of a sentence. */
function isCapitalizedMidSentence(raw: string, sentenceInitial: boolean): boolean {
  if (sentenceInitial) return false;
  const first = raw.charAt(0);
  return first.length > 0 && first === first.toUpperCase() && first !== first.toLowerCase();
}

export type ClassifyMissInput = {
  /** Normalized (see `normalizeToken`) expected word. */
  expected: string;
  /** Normalized heard word, or null if the word was dropped entirely (no substitution). */
  heard: string | null;
  /** Raw (un-normalized) expected word, for the capitalization check. */
  expectedRaw: string;
  /** Whether `expectedRaw` is the first word of its sentence (a capital there is not a proper noun signal). */
  sentenceInitial: boolean;
};

/**
 * Classifies one dictation miss. Checked in order — the first match wins:
 *
 * 1. `proper_noun` — `expectedRaw` is capitalized outside sentence-initial
 *    position (a name, not a grammar/vocab gap).
 * 2. `reduction` — `expected` is a Spanish function word (article/preposition/
 *    clitic/etc.), the class of word connected speech swallows. v1 keeps this
 *    rule simple (function-word list only); detecting a heard word that's a
 *    fusion/split of its neighbors is deferred to a later version.
 * 3. `near_miss` — a heard word was produced and it's within edit distance 2
 *    of what was expected (mishearing, not a knowledge gap).
 * 4. `lexical` — none of the above: the learner didn't know the word/chunk.
 */
export function classifyMiss(input: ClassifyMissInput): DictationMissClass {
  const { expected, heard, expectedRaw, sentenceInitial } = input;

  if (isCapitalizedMidSentence(expectedRaw, sentenceInitial)) {
    return "proper_noun";
  }
  if (FUNCTION_WORDS.has(expected)) {
    return "reduction";
  }
  if (heard !== null && levenshtein(expected, heard) <= 2) {
    return "near_miss";
  }
  return "lexical";
}

// -----------------------------------------------------------------------------
// diff
// -----------------------------------------------------------------------------

/** One rendered token of a dictation diff, for UI display. */
export type DictationDiffToken = {
  kind: "match" | "miss" | "extra";
  /** Raw (un-normalized) expected word. Present for "match"/"miss". */
  expected?: string;
  /** Raw (un-normalized) heard/typed word. Present for "match"/"extra", and for a "miss" that's a substitution. */
  heard?: string;
};

export type DiffDictationResult = {
  tokens: DictationDiffToken[];
  misses: DictationMiss[];
};

type ExpectedToken = { raw: string; norm: string; sentenceInitial: boolean };
type TypedToken = { raw: string; norm: string };

/** Splits on whitespace, dropping empty tokens (repeated spaces, leading/trailing whitespace). */
function tokenizeRaw(text: string): string[] {
  return text.split(/\s+/).filter((s) => s.length > 0);
}

function tokenizeExpected(text: string): ExpectedToken[] {
  let nextIsSentenceInitial = true;
  return tokenizeRaw(text).map((raw) => {
    const token: ExpectedToken = { raw, norm: normalizeToken(raw), sentenceInitial: nextIsSentenceInitial };
    nextIsSentenceInitial = /[.!?]["»]?$/.test(raw); // sentence ends with . ! ? (optionally followed by " or »)
    return token;
  });
}

function tokenizeTyped(text: string): TypedToken[] {
  return tokenizeRaw(text).map((raw) => ({ raw, norm: normalizeToken(raw) }));
}

type LcsOp =
  | { op: "match"; e: ExpectedToken; t: TypedToken }
  | { op: "delete"; e: ExpectedToken }
  | { op: "insert"; t: TypedToken };

/**
 * Standard LCS-alignment diff (DP table + backtrack) over normalized tokens,
 * O(len(expected) * len(typed)) — fine at dictation-segment scale (a
 * handful of words). Matches compare on `.norm`; the raw token is carried
 * through on every op for display and for constructing `DictationMiss`es.
 */
function computeLcsOps(expected: ExpectedToken[], typed: TypedToken[]): LcsOp[] {
  const m = expected.length;
  const n = typed.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        expected[i].norm === typed[j].norm ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: LcsOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (expected[i].norm === typed[j].norm) {
      ops.push({ op: "match", e: expected[i], t: typed[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ op: "delete", e: expected[i] });
      i++;
    } else {
      ops.push({ op: "insert", t: typed[j] });
      j++;
    }
  }
  while (i < m) {
    ops.push({ op: "delete", e: expected[i] });
    i++;
  }
  while (j < n) {
    ops.push({ op: "insert", t: typed[j] });
    j++;
  }
  return ops;
}

/**
 * Diffs a dictation attempt against its segment's transcript text.
 *
 * Aligns normalized tokens via LCS (accent/case/punctuation-insensitive,
 * `ñ` kept distinct — see `normalizeToken`), then walks the alignment:
 * matched tokens become `kind: "match"`; a contiguous run of non-matches is
 * split into deletes (expected but not heard) and inserts (heard but not
 * expected), and adjacent delete/insert pairs within that run collapse into
 * substitution misses (`{ expected, heard }`) in original order — leftover
 * deletes become misses with `heard: null`, leftover inserts become
 * `kind: "extra"` tokens that are NOT recorded as misses (the learner typed
 * something extra; that's not a gap to log).
 *
 * Every miss is classified via `classifyMiss` and returned both as a diff
 * token (raw text, for rendering) and in `misses` (for logging).
 */
export function diffDictation(expectedText: string, typed: string): DiffDictationResult {
  const expected = tokenizeExpected(expectedText);
  const typedTokens = tokenizeTyped(typed);
  const ops = computeLcsOps(expected, typedTokens);

  const tokens: DictationDiffToken[] = [];
  const misses: DictationMiss[] = [];

  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.op === "match") {
      tokens.push({ kind: "match", expected: op.e.raw, heard: op.t.raw });
      i++;
      continue;
    }

    const runStart = i;
    while (i < ops.length && ops[i].op !== "match") i++;
    const run = ops.slice(runStart, i);
    const deletes = run.filter((o): o is Extract<LcsOp, { op: "delete" }> => o.op === "delete");
    const inserts = run.filter((o): o is Extract<LcsOp, { op: "insert" }> => o.op === "insert");

    const pairCount = Math.min(deletes.length, inserts.length);
    for (let k = 0; k < pairCount; k++) {
      const e = deletes[k].e;
      const t = inserts[k].t;
      const missClass = classifyMiss({
        expected: e.norm,
        heard: t.norm,
        expectedRaw: e.raw,
        sentenceInitial: e.sentenceInitial,
      });
      tokens.push({ kind: "miss", expected: e.raw, heard: t.raw });
      misses.push({ expected: e.raw, heard: t.raw, class: missClass });
    }
    for (let k = pairCount; k < deletes.length; k++) {
      const e = deletes[k].e;
      const missClass = classifyMiss({
        expected: e.norm,
        heard: null,
        expectedRaw: e.raw,
        sentenceInitial: e.sentenceInitial,
      });
      tokens.push({ kind: "miss", expected: e.raw });
      misses.push({ expected: e.raw, heard: null, class: missClass });
    }
    for (let k = pairCount; k < inserts.length; k++) {
      tokens.push({ kind: "extra", heard: inserts[k].t.raw });
    }
  }

  return { tokens, misses };
}

// -----------------------------------------------------------------------------
// taxonomy mapping
// -----------------------------------------------------------------------------

/**
 * Maps a dictation miss class onto the taxonomy — `lexical`/`reduction` are
 * acquisition-gap tags; `proper_noun`/`near_miss` are tracked in the event
 * payload only (they're not something the learner needs to study).
 */
export function missClassToTaxonomy(missClass: DictationMissClass): TaxonomyTag | null {
  if (missClass === "lexical") return "listening_lexical";
  if (missClass === "reduction") return "listening_reduction";
  return null;
}
