import { describe, expect, it } from "vitest";
import { buildSegments } from "@/lib/segments";
import type { WordTimestamp } from "@/lib/contracts";

/** Builds a run of words with fixed per-word duration and a fixed gap between each word. */
function makeRun(count: number, opts: { startMs?: number; wordMs?: number; gapMs?: number; prefix?: string } = {}): WordTimestamp[] {
  const { startMs = 0, wordMs = 300, gapMs = 50, prefix = "w" } = opts;
  const words: WordTimestamp[] = [];
  let t = startMs;
  for (let i = 0; i < count; i++) {
    words.push({ w: `${prefix}${i}`, startMs: t, endMs: t + wordMs });
    t += wordMs + gapMs;
  }
  return words;
}

describe("buildSegments", () => {
  it("returns [] for empty input", () => {
    expect(buildSegments([])).toEqual([]);
  });

  it("drops empty/whitespace-only words and returns [] if nothing remains", () => {
    const words: WordTimestamp[] = [
      { w: "", startMs: 0, endMs: 100 },
      { w: "   ", startMs: 100, endMs: 200 },
    ];
    expect(buildSegments(words)).toEqual([]);
  });

  it("keeps a short transcript (under minMs) as a single segment", () => {
    // 10 words * (300+50)ms - 50ms trailing gap = 3450ms, well under the 10s floor.
    const words = makeRun(10);
    const segments = buildSegments(words);
    expect(segments).toHaveLength(1);
    expect(segments[0].index).toBe(0);
    expect(segments[0].text).toBe(words.map((w) => w.w).join(" "));
    expect(segments[0].startMs).toBe(words[0].startMs);
    expect(segments[0].endMs).toBe(words[words.length - 1].endMs);
  });

  it("does not cut at a gap that occurs before the 10s floor", () => {
    // A big gap (900ms) early (after word 3, ~1.2s in) must NOT be used as a
    // cut point — the whole run is only ~9.8s, under minMs, so it should
    // stay one segment despite the large early gap.
    const before = makeRun(4, { wordMs: 300, gapMs: 50 }); // ~1.2s
    const bigGapStart = before[before.length - 1].endMs + 900;
    const after = makeRun(24, { startMs: bigGapStart, wordMs: 300, gapMs: 50, prefix: "x" });
    const words = [...before, ...after];

    const segments = buildSegments(words);
    expect(segments).toHaveLength(1);
    expect(segments[0].endMs).toBe(words[words.length - 1].endMs);
  });

  it("prefers the largest eligible gap (>= 400ms) once a segment has exceeded 10s", () => {
    // Segment 1: words accumulate past 10s, then a small (200ms, ineligible)
    // gap, then a large (800ms, eligible) gap further on, then more words
    // that push the whole thing past the 20s ceiling — forcing a decision
    // that should land on the 800ms gap, not the 200ms one.
    const part1 = makeRun(30, { wordMs: 300, gapMs: 50, prefix: "a" }); // ~10.35s
    const afterSmallGapStart = part1[part1.length - 1].endMs + 200;
    const part2 = makeRun(5, { startMs: afterSmallGapStart, wordMs: 300, gapMs: 50, prefix: "b" });
    const afterBigGapStart = part2[part2.length - 1].endMs + 800;
    const part3 = makeRun(20, { startMs: afterBigGapStart, wordMs: 300, gapMs: 50, prefix: "c" });

    const words = [...part1, ...part2, ...part3];
    const segments = buildSegments(words);

    expect(segments.length).toBeGreaterThanOrEqual(2);
    // First segment must end exactly at the last word before the 800ms gap.
    const lastOfPart2 = part2[part2.length - 1];
    expect(segments[0].endMs).toBe(lastOfPart2.endMs);
    expect(segments[0].text.endsWith(lastOfPart2.w)).toBe(true);
    // Second segment starts right after the gap, at part3's first word.
    expect(segments[1].startMs).toBe(part3[0].startMs);
  });

  it("hard-cuts at the 20s ceiling when a long word-run has no eligible gaps", () => {
    // Continuous speech, tiny 10ms gaps throughout (never >= 400ms), for
    // well over 20s straight through.
    const words = makeRun(400, { wordMs: 100, gapMs: 10 });
    const totalMs = words[words.length - 1].endMs - words[0].startMs;
    expect(totalMs).toBeGreaterThan(20_000);

    const segments = buildSegments(words);
    expect(segments.length).toBeGreaterThan(1);
    for (const seg of segments.slice(0, -1)) {
      // Every non-final segment must be hard-cut at/near the 20s ceiling —
      // the cut lands on the first word whose cumulative duration reaches
      // 20s, so it can overshoot by up to one word's duration (110ms slots
      // here), never by more.
      expect(seg.endMs - seg.startMs).toBeLessThanOrEqual(20_000 + 110);
      expect(seg.endMs - seg.startMs).toBeGreaterThan(19_000);
    }
    // segments tile the input with no gaps or overlaps in coverage
    const allWords = segments.flatMap((s) => s.text.split(" "));
    expect(allWords).toEqual(words.map((w) => w.w));
  });

  it("segments the canned fixture-shaped transcript into exactly 2 segments", () => {
    // Mirrors fixtures/dictation-es-mx.json's shape: two sentences (~13.5s)
    // separated by short inter-word gaps and a real inter-sentence pause,
    // then a gap into a third sentence that only gets force-cut into its
    // own segment once the whole thing crosses 20s (total ~21s here).
    const s1 = makeRun(16, { wordMs: 380, gapMs: 45, prefix: "s1_" });
    const gap1End = s1[s1.length - 1].endMs + 800;
    const s2 = makeRun(14, { startMs: gap1End, wordMs: 380, gapMs: 45, prefix: "s2_" });
    const gap2End = s2[s2.length - 1].endMs + 850;
    const s3 = makeRun(16, { startMs: gap2End, wordMs: 380, gapMs: 45, prefix: "s3_" });
    const words = [...s1, ...s2, ...s3];

    const segments = buildSegments(words);
    expect(segments).toHaveLength(2);
    expect(segments[0].endMs).toBe(s2[s2.length - 1].endMs);
    expect(segments[1].startMs).toBe(s3[0].startMs);
    expect(segments[1].endMs).toBe(s3[s3.length - 1].endMs);
  });

  it("respects custom minMs/maxMs/minGapMs options", () => {
    // Under the defaults (10s/20s/400ms) this whole ~2.6s clip would never
    // be cut. With a shrunk floor/ceiling/gap it should split.
    const words: WordTimestamp[] = [
      { w: "w0", startMs: 0, endMs: 200 },
      { w: "w1", startMs: 800, endMs: 1000 }, // 600ms gap before this word
      { w: "w2", startMs: 1600, endMs: 1800 }, // 600ms gap before this word
      { w: "w3", startMs: 2400, endMs: 2600 }, // 600ms gap before this word
    ];
    expect(buildSegments(words)).toHaveLength(1); // defaults never trigger a cut here

    const segments = buildSegments(words, { minMs: 500, maxMs: 1500, minGapMs: 500 });
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0].endMs).toBe(1000); // cut after w1, at the first eligible (>=500ms) gap past the 500ms floor
    expect(segments[1].startMs).toBe(1600);
  });
});
