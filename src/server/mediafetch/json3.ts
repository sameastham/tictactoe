import type { WordTimestamp } from "@/lib/contracts";

/** One text run within a json3 caption event. */
interface Json3Seg {
  utf8?: string;
  /** Offset in ms from the event's `tStartMs`. Absent on some segs — see {@link parseJson3}. */
  tOffsetMs?: number;
}

/** One caption event (roughly: one displayed caption line/cue) in YouTube's json3 format. */
interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Seg[];
}

interface Json3Doc {
  events?: Json3Event[];
}

/**
 * Parses a YouTube-style json3 caption document into a flat transcript with
 * approximate word-level timestamps. Pure and side-effect-free — no file I/O,
 * no yt-dlp invocation (see `fetchFromUrl` in `./index.ts` for the caller
 * that reads the file this parses).
 *
 * json3 events carry a `tStartMs`/`dDurationMs` window and a list of `segs`
 * (text runs); each seg *may* carry its own `tOffsetMs` (relative to the
 * event's `tStartMs`) — when present we trust it exactly, when absent we
 * approximate by distributing the segs evenly across the event's duration.
 * Within one seg, words are further distributed evenly across that seg's
 * resolved time span. This is an approximation (real per-word timing isn't
 * in the format at all) — good enough for dictation segment cuts, which only
 * need rough word boundaries, not frame-accurate ones.
 *
 * Malformed/empty input (no `events`, events with no `segs`, whitespace-only
 * segs) is tolerated silently and simply contributes nothing.
 */
export function parseJson3(json: unknown): { text: string; words: WordTimestamp[] } {
  const doc = (json ?? {}) as Json3Doc;
  const events = Array.isArray(doc.events) ? doc.events : [];

  const words: WordTimestamp[] = [];
  const textParts: string[] = [];

  for (const event of events) {
    const segs = event?.segs;
    if (!Array.isArray(segs) || segs.length === 0) continue;

    const tStart = typeof event?.tStartMs === "number" ? event.tStartMs : 0;
    const dDuration = typeof event?.dDurationMs === "number" ? Math.max(event.dDurationMs, 0) : 0;

    // Resolve each seg's start offset within the event: trust an explicit
    // tOffsetMs, else distribute evenly across [0, dDuration].
    const offsets = segs.map((seg, i) =>
      typeof seg.tOffsetMs === "number" ? seg.tOffsetMs : Math.round((dDuration * i) / segs.length),
    );

    for (let i = 0; i < segs.length; i++) {
      const raw = segs[i].utf8 ?? "";
      const tokens = raw.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue; // whitespace-only / newline-only segs carry no words

      const segStartMs = tStart + offsets[i];
      const nextOffset = i + 1 < segs.length ? offsets[i + 1] : dDuration;
      const segEndMs = Math.max(tStart + nextOffset, segStartMs + tokens.length);

      textParts.push(tokens.join(" "));

      const span = Math.max(segEndMs - segStartMs, tokens.length);
      tokens.forEach((token, idx) => {
        const wStart = segStartMs + Math.round((span * idx) / tokens.length);
        const wEnd = Math.max(segStartMs + Math.round((span * (idx + 1)) / tokens.length), wStart + 1);
        words.push({ w: token, startMs: wStart, endMs: wEnd });
      });
    }
  }

  return { text: textParts.join(" ").replace(/\s+/g, " ").trim(), words };
}
