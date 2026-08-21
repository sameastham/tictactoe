import type { FluencyMetrics, WordTimestamp } from "@/lib/contracts";
import { normalizeToken } from "@/lib/dictation";

/**
 * Fluency markers read off one spoken turn's word timestamps — plan §4.3
 * week 7 ("fluency markers — hesitations, restarts, fillers — read off
 * transcript timestamps"). Pure and client-safe: no model call, no I/O, same
 * posture as `src/lib/segments.ts` / `src/lib/dictation.ts`.
 *
 * -----------------------------------------------------------------------
 * Filler heuristic (deliberately phrase-aware, not a naive token list)
 * -----------------------------------------------------------------------
 * A plain "is this token in a filler list" check overcounts badly in
 * Spanish: "o", "pues", "como", "que" are all common, meaningful words on
 * their own. So each candidate is only counted under a rule specific enough
 * to (mostly) tell hesitation-use apart from ordinary use:
 *
 *  - "eh", "em", "mmm" — always counted. These have no other use in
 *    Spanish; every occurrence is a filled pause.
 *  - "o sea" / "como que" — counted only as an adjacent bigram (this word
 *    immediately followed by that one in the transcript). Either word alone
 *    is real vocabulary ("o" = "or", "sea" = subjunctive of "ser", "como" =
 *    "like/as/I eat", "que" = "that/which") and is never counted by itself.
 *  - "este" — Spanish's closest equivalent of English "uh"/"um", but it is
 *    also the ordinary demonstrative ("this"). It only counts as a filler
 *    when it shows the behavior of a hesitation marker: immediately
 *    followed by a pause over 400ms (the speaker stalled right after
 *    saying it), or immediately followed by another filler token/bigram
 *    (it's part of a hesitation cluster, e.g. "este... eh..."). "este
 *    trabajo" spoken at normal cadence is never counted.
 *
 * All matching is done on `normalizeToken`-normalized text (lowercased,
 * accents stripped, punctuation stripped) so "Eh," / "ESTE" / "cómo que"
 * still match.
 */

const ALWAYS_FILLERS = new Set(["eh", "em", "mmm"]);
const ESTE = "este";
const HESITATION_PAUSE_MS = 400;
const LONG_PAUSE_MS = 800;

/** True if `norm[i]` starts the bigram "o sea" or "como que". */
function startsBigramFiller(norm: string[], i: number): boolean {
  const a = norm[i];
  const b = i + 1 < norm.length ? norm[i + 1] : null;
  return (a === "o" && b === "sea") || (a === "como" && b === "que");
}

/** Zero-valued {@link FluencyMetrics} — the empty-transcript case. */
const ZERO_FLUENCY: FluencyMetrics = {
  durationMs: 0,
  wordCount: 0,
  wordsPerMin: 0,
  pausesOver800Ms: 0,
  longestPauseMs: 0,
  fillerCount: 0,
};

/**
 * Computes fluency markers from one turn's word-timestamped transcript.
 * `durationMs` is the last word's `endMs` minus the first word's `startMs`
 * (0 for an empty transcript, along with every other field). `wordsPerMin`
 * is rounded to one decimal place.
 */
export function computeFluency(words: WordTimestamp[]): FluencyMetrics {
  if (words.length === 0) {
    return { ...ZERO_FLUENCY };
  }

  const durationMs = words[words.length - 1].endMs - words[0].startMs;
  const wordCount = words.length;
  const wordsPerMin = durationMs > 0 ? Math.round(((wordCount / durationMs) * 60_000 * 10)) / 10 : 0;

  let pausesOver800Ms = 0;
  let longestPauseMs = 0;
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1].startMs - words[i].endMs;
    if (gap > LONG_PAUSE_MS) pausesOver800Ms++;
    if (gap > longestPauseMs) longestPauseMs = gap;
  }

  const norm = words.map((w) => normalizeToken(w.w));

  let fillerCount = 0;
  let i = 0;
  while (i < norm.length) {
    if (startsBigramFiller(norm, i)) {
      fillerCount++;
      i += 2;
      continue;
    }

    const tok = norm[i];

    if (ALWAYS_FILLERS.has(tok)) {
      fillerCount++;
      i++;
      continue;
    }

    if (tok === ESTE) {
      const hasNext = i + 1 < words.length;
      const gapAfter = hasNext ? words[i + 1].startMs - words[i].endMs : -1;
      const followedByPause = gapAfter > HESITATION_PAUSE_MS;
      const nextTok = i + 1 < norm.length ? norm[i + 1] : null;
      const followedByFiller =
        nextTok !== null && (ALWAYS_FILLERS.has(nextTok) || nextTok === ESTE || startsBigramFiller(norm, i + 1));
      if (followedByPause || followedByFiller) {
        fillerCount++;
      }
      i++;
      continue;
    }

    i++;
  }

  return { durationMs, wordCount, wordsPerMin, pausesOver800Ms, longestPauseMs, fillerCount };
}
