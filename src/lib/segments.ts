import type { TranscriptSegment, WordTimestamp } from "@/lib/contracts";

/**
 * Segmentation tuning knobs for {@link buildSegments}. All defaults target
 * plan §4.1's 10-20s dictation segments: don't even consider a cut before
 * `minMs` has elapsed, prefer the largest pause (`minGapMs` or longer) once
 * past that, and never let a segment run past `maxMs`.
 */
export type BuildSegmentsOptions = {
  /** Soft floor, in ms — a segment won't be cut before this much audio has accumulated. Default 10_000. */
  minMs?: number;
  /** Hard ceiling, in ms — a segment is force-cut at or before this point. Default 20_000. */
  maxMs?: number;
  /** Minimum inter-word gap, in ms, eligible to be chosen as a natural cut point. Default 400. */
  minGapMs?: number;
};

const DEFAULT_MIN_MS = 10_000;
const DEFAULT_MAX_MS = 20_000;
const DEFAULT_MIN_GAP_MS = 400;

/**
 * Cuts a word-timestamped transcript into dictation segments targeting
 * 10-20 seconds each (plan §4.1 "Segment selection v1: cut at natural
 * pauses targeting 10-20s"). Pure and client-safe — no I/O.
 *
 * Walks the words once per segment. Once a segment's elapsed duration has
 * passed `minMs`, it starts tracking the largest inter-word gap it sees
 * (only gaps >= `minGapMs` are eligible). As soon as elapsed duration
 * reaches `maxMs`, the segment is cut at that best gap if one was found;
 * otherwise it's force-cut right there ("hard at 20s") — this is what
 * produces the "single long word-run with no gaps -> hard cuts" edge case.
 * If the transcript ends before any segment ever reaches `maxMs`, the
 * remaining words simply become the final (possibly short) segment — a
 * pause found late in a comfortably-sized segment is not used to fragment
 * it further.
 *
 * Empty/whitespace-only words are dropped before segmenting (they'd
 * otherwise contribute nothing to segment text) and empty words[] input
 * yields [].
 */
export function buildSegments(words: WordTimestamp[], opts: BuildSegmentsOptions = {}): TranscriptSegment[] {
  const minMs = opts.minMs ?? DEFAULT_MIN_MS;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  const minGapMs = opts.minGapMs ?? DEFAULT_MIN_GAP_MS;

  const cleaned = words.filter((word) => word.w.trim().length > 0);
  if (cleaned.length === 0) return [];

  const segments: TranscriptSegment[] = [];
  let segStart = 0;

  while (segStart < cleaned.length) {
    const segStartMs = cleaned[segStart].startMs;

    // Default: no cut needed — the segment runs through the rest of the words.
    let endIdx = cleaned.length - 1;
    let bestGapIdx = -1;
    let bestGapValue = -1;

    for (let j = segStart; j < cleaned.length; j++) {
      const elapsed = cleaned[j].endMs - segStartMs;
      const isLast = j === cleaned.length - 1;
      const gapAfter = isLast ? 0 : cleaned[j + 1].startMs - cleaned[j].endMs;

      if (elapsed >= minMs && !isLast && gapAfter >= minGapMs && gapAfter > bestGapValue) {
        bestGapValue = gapAfter;
        bestGapIdx = j;
      }

      if (elapsed >= maxMs) {
        // Force a cut: prefer the best natural pause seen in the [minMs, maxMs)
        // window; failing that, hard-cut right at this word.
        endIdx = bestGapIdx !== -1 ? bestGapIdx : j;
        break;
      }
    }

    const segWords = cleaned.slice(segStart, endIdx + 1);
    const text = segWords
      .map((w) => w.w)
      .join(" ")
      .trim();
    if (text.length > 0) {
      segments.push({
        index: segments.length,
        startMs: segWords[0].startMs,
        endMs: segWords[segWords.length - 1].endMs,
        text,
      });
    }
    segStart = endIdx + 1;
  }

  return segments;
}
