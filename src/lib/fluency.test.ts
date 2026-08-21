import { describe, expect, it } from "vitest";
import { computeFluency } from "@/lib/fluency";
import type { WordTimestamp } from "@/lib/contracts";

/**
 * Builds a word-timestamped run from `[word, durationMs, gapAfterMs]`
 * triples — the gap of the last entry is unused. Mirrors the `makeRun`
 * helper in `src/lib/segments.test.ts`, but per-word timing/gaps are
 * explicit here since the filler rules under test are timing-sensitive.
 */
function seq(spec: Array<[string, number, number?]>): WordTimestamp[] {
  const words: WordTimestamp[] = [];
  let t = 0;
  for (const [w, durationMs, gapAfterMs] of spec) {
    const startMs = t;
    const endMs = t + durationMs;
    words.push({ w, startMs, endMs });
    t = endMs + (gapAfterMs ?? 0);
  }
  return words;
}

describe("computeFluency", () => {
  it("returns all zeros for an empty transcript", () => {
    expect(computeFluency([])).toEqual({
      durationMs: 0,
      wordCount: 0,
      wordsPerMin: 0,
      pausesOver800Ms: 0,
      longestPauseMs: 0,
      fillerCount: 0,
    });
  });

  it("computes durationMs as last endMs minus first startMs, and wordCount", () => {
    const words = seq([
      ["Hola", 300, 100],
      ["mundo", 300, 0],
    ]);
    const { durationMs, wordCount } = computeFluency(words);
    expect(durationMs).toBe(700); // 300 + 100 + 300
    expect(wordCount).toBe(2);
  });

  it("computes wordsPerMin from wordCount / durationMs, rounded to 1 decimal", () => {
    // 2 words spanning exactly 1000ms -> (2 / 1000) * 60000 = 120 words/min.
    const words = seq([
      ["uno", 500, 0],
      ["dos", 500, 0],
    ]);
    expect(computeFluency(words).wordsPerMin).toBe(120);
  });

  it("counts inter-word gaps strictly greater than 800ms as long pauses, and tracks the longest", () => {
    const words = seq([
      ["a", 200, 900], // long pause after
      ["b", 200, 800], // exactly 800ms — not counted (strictly greater than)
      ["c", 200, 1200], // longest
      ["d", 200, 0],
    ]);
    const { pausesOver800Ms, longestPauseMs } = computeFluency(words);
    expect(pausesOver800Ms).toBe(2);
    expect(longestPauseMs).toBe(1200);
  });

  it("has longestPauseMs 0 for a single word (no gaps)", () => {
    const words = seq([["solo", 300, 0]]);
    expect(computeFluency(words).longestPauseMs).toBe(0);
    expect(computeFluency(words).pausesOver800Ms).toBe(0);
  });

  describe("filler rule: eh/em/mmm always count", () => {
    it("counts a standalone 'eh'", () => {
      const words = seq([
        ["Pues", 200, 100],
        ["eh", 200, 100],
        ["no", 200, 0],
      ]);
      expect(computeFluency(words).fillerCount).toBe(1);
    });

    it("counts a standalone 'em' and 'mmm', including repeats", () => {
      const words = seq([
        ["em", 200, 100],
        ["mmm", 200, 100],
        ["em", 200, 0],
      ]);
      expect(computeFluency(words).fillerCount).toBe(3);
    });

    it("matches case/accent/punctuation-insensitively (normalizeToken)", () => {
      const words = seq([
        ["Eh,", 200, 100],
        ["MMM", 200, 0],
      ]);
      expect(computeFluency(words).fillerCount).toBe(2);
    });
  });

  describe("filler rule: 'o sea' / 'como que' bigrams only", () => {
    it("counts adjacent 'o sea' once, not 'o' and 'sea' separately", () => {
      const words = seq([
        ["o", 200, 50],
        ["sea", 200, 0],
      ]);
      expect(computeFluency(words).fillerCount).toBe(1);
    });

    it("does not count 'o' used on its own (not followed by 'sea')", () => {
      const words = seq([
        ["café", 200, 100],
        ["o", 200, 100],
        ["té", 200, 0],
      ]);
      expect(computeFluency(words).fillerCount).toBe(0);
    });

    it("does not count 'sea' used on its own (not preceded by 'o')", () => {
      const words = seq([
        ["cuando", 200, 100],
        ["sea", 200, 100],
        ["posible", 200, 0],
      ]);
      expect(computeFluency(words).fillerCount).toBe(0);
    });

    it("counts adjacent 'como que' once, not 'como' and 'que' separately", () => {
      const words = seq([
        ["como", 200, 50],
        ["que", 200, 0],
      ]);
      expect(computeFluency(words).fillerCount).toBe(1);
    });

    it("does not count 'como' or 'que' used on their own, in ordinary sentences", () => {
      const words = seq([
        ["Como", 200, 100],
        ["tacos", 200, 100],
        ["porque", 200, 100],
        ["que", 200, 100],
        ["rico", 200, 0],
      ]);
      expect(computeFluency(words).fillerCount).toBe(0);
    });

    it("counts two separate 'o sea' occurrences", () => {
      const words = seq([
        ["o", 200, 50],
        ["sea", 200, 100],
        ["digo", 200, 100],
        ["o", 200, 50],
        ["sea", 200, 0],
      ]);
      expect(computeFluency(words).fillerCount).toBe(2);
    });
  });

  describe("filler rule: 'este' only as a hesitation marker", () => {
    it("does NOT count 'este' used as an ordinary demonstrative (short gap, non-filler next word)", () => {
      const words = seq([
        ["Compré", 200, 100],
        ["este", 200, 150], // gap 150ms <= 400ms threshold
        ["libro", 200, 0],
      ]);
      expect(computeFluency(words).fillerCount).toBe(0);
    });

    it("counts 'este' when followed by a pause over 400ms", () => {
      const words = seq([
        ["Yo", 200, 100],
        ["este", 200, 450], // gap 450ms > 400ms threshold
        ["pues", 200, 0],
      ]);
      expect(computeFluency(words).fillerCount).toBe(1);
    });

    it("does NOT count 'este' when the pause after it is exactly 400ms (strictly greater required)", () => {
      const words = seq([
        ["Yo", 200, 100],
        ["este", 200, 400],
        ["pues", 200, 0],
      ]);
      expect(computeFluency(words).fillerCount).toBe(0);
    });

    it("counts 'este' immediately followed by another filler token ('eh'), and counts the 'eh' too", () => {
      const words = seq([
        ["este", 200, 50], // short gap, but next token is a filler -> counts
        ["eh", 200, 100],
        ["bueno", 200, 0],
      ]);
      expect(computeFluency(words).fillerCount).toBe(2);
    });

    it("counts 'este' immediately followed by a repeated 'este'", () => {
      const words = seq([
        ["este", 200, 50],
        ["este", 200, 100], // trailed only by a normal word at a short gap -> this second 'este' does not count
        ["trabajo", 200, 0],
      ]);
      expect(computeFluency(words).fillerCount).toBe(1);
    });

    it("counts 'este' immediately followed by the start of an 'o sea' bigram", () => {
      const words = seq([
        ["este", 200, 50],
        ["o", 200, 50],
        ["sea", 200, 100],
        ["ya", 200, 0],
      ]);
      // 'este' counts (followed by filler bigram start) + 'o sea' counts once = 2.
      expect(computeFluency(words).fillerCount).toBe(2);
    });

    it("does NOT count a trailing 'este' with no following word (no pause data, no next token)", () => {
      const words = seq([
        ["Ya", 200, 100],
        ["compré", 200, 100],
        ["este", 200, 0],
      ]);
      expect(computeFluency(words).fillerCount).toBe(0);
    });
  });

  it("mixes multiple filler kinds in one transcript", () => {
    const words = seq([
      ["Pues", 200, 100],
      ["eh", 200, 450], // counts (always)
      ["este", 200, 500], // counts (pause > 400ms after it)
      ["o", 200, 50],
      ["sea", 200, 100], // counts (bigram)
      ["ya", 200, 0],
    ]);
    expect(computeFluency(words).fillerCount).toBe(3);
  });
});
