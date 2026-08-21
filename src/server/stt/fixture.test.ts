import { describe, expect, it } from "vitest";
import { FixtureSttProvider } from "@/server/stt/fixture";
import { buildSegments } from "@/lib/segments";

describe("FixtureSttProvider", () => {
  it("returns the same canned transcript regardless of input path", async () => {
    const provider = new FixtureSttProvider();
    const a = await provider.transcribe("/some/path/a.wav");
    const b = await provider.transcribe("/completely/different/b.mp3");
    expect(a).toEqual(b);
  });

  it("returns a well-formed { text, words } shape", async () => {
    const provider = new FixtureSttProvider();
    const result = await provider.transcribe("/any/file.wav");

    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
    expect(Array.isArray(result.words)).toBe(true);
    expect(result.words.length).toBeGreaterThan(0);

    for (const word of result.words) {
      expect(typeof word.w).toBe("string");
      expect(word.w.length).toBeGreaterThan(0);
      expect(typeof word.startMs).toBe("number");
      expect(typeof word.endMs).toBe("number");
      expect(word.endMs).toBeGreaterThan(word.startMs);
    }

    // words are in non-decreasing time order
    for (let i = 1; i < result.words.length; i++) {
      expect(result.words[i].startMs).toBeGreaterThanOrEqual(result.words[i - 1].startMs);
    }
  });

  it("has provider name 'fixture'", () => {
    expect(new FixtureSttProvider().name).toBe("fixture");
  });

  it("its words segment into exactly 2 segments via buildSegments (matches plan Sec.4.1's 10-20s target)", async () => {
    const provider = new FixtureSttProvider();
    const { words } = await provider.transcribe("/any/file.wav");
    const segments = buildSegments(words);

    expect(segments).toHaveLength(2);
    expect(segments[0].index).toBe(0);
    expect(segments[1].index).toBe(1);
    for (const seg of segments) {
      expect(seg.text.length).toBeGreaterThan(0);
      expect(seg.endMs).toBeGreaterThan(seg.startMs);
    }
  });
});
