import { describe, expect, it } from "vitest";
import { parseJson3 } from "@/server/mediafetch/json3";

describe("parseJson3", () => {
  it("uses explicit tOffsetMs when every seg has one", () => {
    // Two events, each with two segs that each carry their own tOffsetMs.
    const doc = {
      events: [
        {
          tStartMs: 1000,
          dDurationMs: 2000,
          segs: [
            { utf8: "Hola", tOffsetMs: 0 },
            { utf8: " mundo", tOffsetMs: 900 },
          ],
        },
        {
          tStartMs: 4000,
          dDurationMs: 1500,
          segs: [{ utf8: "cómo estás", tOffsetMs: 0 }],
        },
      ],
    };

    const { text, words } = parseJson3(doc);

    expect(text).toBe("Hola mundo cómo estás");
    // "Hola" starts exactly at 1000 + 0.
    expect(words[0]).toMatchObject({ w: "Hola", startMs: 1000 });
    // "mundo" starts exactly at 1000 + 900.
    const mundo = words.find((w) => w.w === "mundo");
    expect(mundo).toMatchObject({ w: "mundo", startMs: 1900 });
    // Words are non-decreasing in start time and each has positive duration.
    for (let i = 1; i < words.length; i++) {
      expect(words[i].startMs).toBeGreaterThanOrEqual(words[i - 1].startMs);
    }
    for (const w of words) {
      expect(w.endMs).toBeGreaterThan(w.startMs);
    }
  });

  it("distributes segs evenly across the event's duration when tOffsetMs is missing", () => {
    // One event, three segs, none carrying tOffsetMs — must fall back to
    // even distribution across the 3000ms window starting at 5000.
    const doc = {
      events: [
        {
          tStartMs: 5000,
          dDurationMs: 3000,
          segs: [{ utf8: "uno" }, { utf8: "dos" }, { utf8: "tres" }],
        },
      ],
    };

    const { text, words } = parseJson3(doc);

    expect(text).toBe("uno dos tres");
    expect(words.map((w) => w.w)).toEqual(["uno", "dos", "tres"]);
    // Evenly distributed: uno at +0, dos at +1000, tres at +2000.
    expect(words[0].startMs).toBe(5000);
    expect(words[1].startMs).toBe(6000);
    expect(words[2].startMs).toBe(7000);
    for (const w of words) {
      expect(w.endMs).toBeGreaterThan(w.startMs);
    }
  });

  it("skips whitespace/newline-only segs and events with no segs", () => {
    const doc = {
      events: [
        { tStartMs: 0, dDurationMs: 500, segs: [{ utf8: "\n" }] },
        { tStartMs: 500 }, // no segs at all — style-only event
        { tStartMs: 1000, dDurationMs: 800, segs: [{ utf8: "Buenas" }] },
      ],
    };

    const { text, words } = parseJson3(doc);
    expect(text).toBe("Buenas");
    expect(words).toHaveLength(1);
    expect(words[0].w).toBe("Buenas");
  });

  it("splits a multi-word seg into individual words spanning its resolved window", () => {
    const doc = {
      events: [
        {
          tStartMs: 0,
          dDurationMs: 2000,
          segs: [{ utf8: "el gato negro", tOffsetMs: 0 }],
        },
      ],
    };

    const { words } = parseJson3(doc);
    expect(words.map((w) => w.w)).toEqual(["el", "gato", "negro"]);
    expect(words[0].startMs).toBe(0);
    // Words are in non-decreasing order and each ends before/at the event's end.
    for (const w of words) {
      expect(w.endMs).toBeLessThanOrEqual(2000);
    }
  });

  it("tolerates malformed/empty input", () => {
    expect(parseJson3(null)).toEqual({ text: "", words: [] });
    expect(parseJson3({})).toEqual({ text: "", words: [] });
    expect(parseJson3({ events: [] })).toEqual({ text: "", words: [] });
    expect(parseJson3("not an object")).toEqual({ text: "", words: [] });
  });
});
