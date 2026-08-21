/**
 * Pure text-anchoring utility: locates model-extracted "candidate" chunks
 * back inside the raw article text so the UI can highlight them.
 *
 * Dependency-free and client-safe: no `fs`, no server-only imports.
 */

/** A minimal structural shape for a candidate — deliberately not coupled to `@/lib/contracts`. */
export interface AnchorCandidateInput {
  id: string;
  chunk: string;
  origin_sentence: string;
}

/** A resolved anchor: `[start, end)` char offsets of a candidate's chunk into the raw text. */
export interface AnchorRange {
  candidateId: string;
  start: number;
  end: number;
}

/** Result of anchoring a batch of candidates against an article's raw text. */
export interface AnchorResult {
  ranges: AnchorRange[];
  unanchored: string[];
}

/** Matches a single whitespace character: space, tab, newline, NBSP, and other Unicode space. */
const IS_WHITESPACE = /\s/;

/**
 * Collapses every whitespace run (including newlines and NBSP) to a single space and trims
 * the ends, while recording — for each character kept in the normalized string — the index
 * of that character in the original raw string. This lets a match found in normalized space
 * be mapped back to raw offsets.
 */
function normalizeWithOffsets(raw: string): { normalized: string; rawIndex: number[] } {
  let normalized = "";
  const rawIndex: number[] = [];
  let inWhitespace = false;
  const isWs = (ch: string) => IS_WHITESPACE.test(ch);

  let i = 0;
  const n = raw.length;
  // Skip leading whitespace entirely (trim start).
  while (i < n && isWs(raw[i])) i++;

  for (; i < n; i++) {
    const ch = raw[i];
    if (isWs(ch)) {
      inWhitespace = true;
      continue;
    }
    if (inWhitespace) {
      normalized += " ";
      // The space itself doesn't map to any single raw char cleanly; anchor it to this
      // char's index so any offset math around it still lands inside the whitespace run's
      // successor. It's never used as a start/end of a chunk match in practice since
      // matches begin/end on non-space normalized chars in our test data, but we keep the
      // array dense and monotonic regardless.
      rawIndex.push(i);
      inWhitespace = false;
    }
    normalized += ch;
    rawIndex.push(i);
  }
  // Trailing whitespace is simply never appended (trim end).
  return { normalized, rawIndex };
}

/** Finds `needle` inside `haystack` case-sensitively, first occurrence, or -1. */
function firstIndex(haystack: string, needle: string): number {
  if (needle.length === 0) return -1;
  return haystack.indexOf(needle);
}

/** Attempts to anchor a single candidate; returns the range or null. */
function anchorOne(text: string, candidate: AnchorCandidateInput): AnchorRange | null {
  const { id, chunk, origin_sentence } = candidate;
  if (chunk.length === 0) return null;

  // 1. Exact: sentence found verbatim, chunk found verbatim inside that sentence.
  const sentenceStart = firstIndex(text, origin_sentence);
  if (sentenceStart !== -1) {
    const chunkOffsetInSentence = firstIndex(origin_sentence, chunk);
    if (chunkOffsetInSentence !== -1) {
      const start = sentenceStart + chunkOffsetInSentence;
      return { candidateId: id, start, end: start + chunk.length };
    }
  }

  // 2. Whitespace-normalized fallback.
  const normText = normalizeWithOffsets(text);
  const normSentence = normalizeWithOffsets(origin_sentence);
  if (normSentence.normalized.length > 0) {
    const normSentenceStart = firstIndex(normText.normalized, normSentence.normalized);
    if (normSentenceStart !== -1) {
      const normChunk = normalizeWithOffsets(chunk);
      if (normChunk.normalized.length > 0) {
        const chunkOffsetInNormSentence = firstIndex(normSentence.normalized, normChunk.normalized);
        if (chunkOffsetInNormSentence !== -1) {
          const normStart = normSentenceStart + chunkOffsetInNormSentence;
          const normEnd = normStart + normChunk.normalized.length - 1;
          const rawStart = normText.rawIndex[normStart];
          const rawEndInclusive = normText.rawIndex[normEnd];
          if (rawStart !== undefined && rawEndInclusive !== undefined) {
            return { candidateId: id, start: rawStart, end: rawEndInclusive + 1 };
          }
        }
      }
    }
  }

  // 3. Chunk-anywhere fallback: raw, then normalized.
  const rawChunkStart = firstIndex(text, chunk);
  if (rawChunkStart !== -1) {
    return { candidateId: id, start: rawChunkStart, end: rawChunkStart + chunk.length };
  }
  const normChunkAnywhere = normalizeWithOffsets(chunk);
  if (normChunkAnywhere.normalized.length > 0) {
    const normStart = firstIndex(normText.normalized, normChunkAnywhere.normalized);
    if (normStart !== -1) {
      const normEnd = normStart + normChunkAnywhere.normalized.length - 1;
      const rawStart = normText.rawIndex[normStart];
      const rawEndInclusive = normText.rawIndex[normEnd];
      if (rawStart !== undefined && rawEndInclusive !== undefined) {
        return { candidateId: id, start: rawStart, end: rawEndInclusive + 1 };
      }
    }
  }

  // 4. Unanchorable.
  return null;
}

/**
 * Locates each candidate's `chunk` inside `text`, producing non-overlapping,
 * start-sorted ranges. Candidates that can't be found, or that would overlap
 * an already-kept range, land in `unanchored` (by candidateId) instead.
 */
export function anchorCandidates(
  text: string,
  candidates: ReadonlyArray<AnchorCandidateInput>,
): AnchorResult {
  const unanchored: string[] = [];
  const found: AnchorRange[] = [];

  for (const candidate of candidates) {
    const range = anchorOne(text, candidate);
    if (range) {
      found.push(range);
    } else {
      unanchored.push(candidate.id);
    }
  }

  // Sort by start ascending; ties broken by longer range first (so the longer one is
  // considered "kept" when comparing against later, shorter, equally-started ranges).
  found.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - b.start - (a.end - a.start);
  });

  const kept: AnchorRange[] = [];
  let lastEnd = -1;
  for (const range of found) {
    if (range.start < lastEnd) {
      unanchored.push(range.candidateId);
      continue;
    }
    kept.push(range);
    lastEnd = range.end;
  }

  return { ranges: kept, unanchored };
}

/** One piece of a paragraph's rendering: either plain text or a highlighted candidate span. */
export type Segment =
  | { kind: "text"; text: string }
  | { kind: "mark"; text: string; candidateId: string };

/** A `[start, end)` span with the paragraph bounds it must be clipped to. */
function clip(range: AnchorRange, paraStart: number, paraEnd: number): AnchorRange | null {
  const start = Math.max(range.start, paraStart);
  const end = Math.min(range.end, paraEnd);
  if (start >= end) return null;
  return { candidateId: range.candidateId, start, end };
}

/**
 * Splits raw text into paragraphs (on runs of 2+ newlines) and, for each, emits an
 * alternating sequence of plain-text and highlighted-mark segments that together
 * reconstruct the paragraph exactly. Ranges crossing a paragraph boundary are clipped
 * into each paragraph they touch. Whitespace-only (including empty) paragraphs are dropped.
 */
export function buildParagraphSegments(
  text: string,
  ranges: ReadonlyArray<AnchorRange>,
): Segment[][] {
  if (text.length === 0) return [];

  const paragraphs: Array<{ start: number; end: number }> = [];
  const separator = /\n{2,}/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(text)) !== null) {
    paragraphs.push({ start: cursor, end: match.index });
    cursor = match.index + match[0].length;
  }
  paragraphs.push({ start: cursor, end: text.length });

  const sortedRanges = [...ranges].sort((a, b) => a.start - b.start);

  const result: Segment[][] = [];
  for (const para of paragraphs) {
    const paraText = text.slice(para.start, para.end);
    if (paraText.trim().length === 0) continue;

    const clipped = sortedRanges
      .map((r) => clip(r, para.start, para.end))
      .filter((r): r is AnchorRange => r !== null)
      .sort((a, b) => a.start - b.start);

    const segments: Segment[] = [];
    let pos = para.start;
    for (const r of clipped) {
      if (r.start > pos) {
        segments.push({ kind: "text", text: text.slice(pos, r.start) });
      }
      segments.push({ kind: "mark", text: text.slice(r.start, r.end), candidateId: r.candidateId });
      pos = r.end;
    }
    if (pos < para.end) {
      segments.push({ kind: "text", text: text.slice(pos, para.end) });
    }
    if (segments.length === 0) {
      segments.push({ kind: "text", text: paraText });
    }

    result.push(segments);
  }

  return result;
}
