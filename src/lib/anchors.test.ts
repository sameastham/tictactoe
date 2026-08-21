import { describe, expect, it } from "vitest";
import { anchorCandidates, buildParagraphSegments, type AnchorRange, type Segment } from "@/lib/anchors";

// A small Spanish article with accents, ñ, ¿, and 3 paragraphs. Paragraph 2 contains a
// sentence that is line-wrapped in the raw text (a real newline where the model's
// origin_sentence has a plain space), to exercise the whitespace-normalized fallback.
const PARA1 =
  "El aprendizaje de un idioma nuevo puede ser un desafío enorme. " +
  "Muchas personas empiezan con entusiasmo, pero pierden la motivación al cabo de unos años. " +
  "¿Cómo se puede mantener la constancia?";

const PARA2 =
  "La práctica diaria es la clave del éxito. " +
  "Repetir cada palabra\nsiguiente ayuda a fijar el vocabulario en la memoria a largo plazo. " +
  "Sin embargo, también es importante descansar lo suficiente.";

const PARA3 =
  "Al final, lo más importante es disfrutar el proceso de aprender. " +
  "El español tiene una rica variedad de expresiones idiomáticas, y practicar con nativos siempre ayuda mucho. " +
  "La práctica constante siempre ayuda mucho a mejorar la fluidez.";

const ARTICLE = `${PARA1}\n\n${PARA2}\n\n${PARA3}`;

/** Independent re-derivation of paragraph boundaries (same algorithm the spec describes), used only to build expectations. */
function paragraphBoundaries(text: string): Array<{ start: number; end: number }> {
  const bounds: Array<{ start: number; end: number }> = [];
  const sep = /\n{2,}/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = sep.exec(text)) !== null) {
    bounds.push({ start: cursor, end: m.index });
    cursor = m.index + m[0].length;
  }
  bounds.push({ start: cursor, end: text.length });
  return bounds;
}

function isMark(s: Segment): s is Extract<Segment, { kind: "mark" }> {
  return s.kind === "mark";
}

describe("anchorCandidates", () => {
  it("exact match: anchors the chunk at the correct offsets", () => {
    const candidate = {
      id: "c1",
      chunk: "desafío enorme",
      origin_sentence: "El aprendizaje de un idioma nuevo puede ser un desafío enorme.",
    };
    const { ranges, unanchored } = anchorCandidates(ARTICLE, [candidate]);
    expect(unanchored).toEqual([]);
    expect(ranges).toHaveLength(1);
    const [range] = ranges;
    expect(range.candidateId).toBe("c1");
    expect(ARTICLE.slice(range.start, range.end)).toBe("desafío enorme");
  });

  it("whitespace-normalized fallback: anchors a line-wrapped sentence via a chunk that excludes the newline", () => {
    const candidate = {
      id: "c2a",
      chunk: "siguiente ayuda",
      origin_sentence:
        "Repetir cada palabra siguiente ayuda a fijar el vocabulario en la memoria a largo plazo.",
    };
    // The origin_sentence (single-spaced) does not literally appear in the raw text, which
    // has a real newline instead of a space — this forces the normalized fallback.
    expect(ARTICLE.includes(candidate.origin_sentence)).toBe(false);

    const { ranges, unanchored } = anchorCandidates(ARTICLE, [candidate]);
    expect(unanchored).toEqual([]);
    expect(ranges).toHaveLength(1);
    const [range] = ranges;
    expect(ARTICLE.slice(range.start, range.end)).toBe("siguiente ayuda");
  });

  it("whitespace-normalized fallback: anchors a chunk that itself spans the newline", () => {
    const candidate = {
      id: "c2b",
      chunk: "palabra siguiente",
      origin_sentence:
        "Repetir cada palabra siguiente ayuda a fijar el vocabulario en la memoria a largo plazo.",
    };
    const expectedRaw = "palabra\nsiguiente";
    expect(ARTICLE.includes(expectedRaw)).toBe(true);

    const { ranges, unanchored } = anchorCandidates(ARTICLE, [candidate]);
    expect(unanchored).toEqual([]);
    expect(ranges).toHaveLength(1);
    const [range] = ranges;
    // The raw slice keeps the real newline; its whitespace-normalized form is the chunk.
    expect(ARTICLE.slice(range.start, range.end)).toBe(expectedRaw);
    expect(ARTICLE.slice(range.start, range.end).replace(/\s+/g, " ")).toBe(candidate.chunk);
  });

  it("chunk-anywhere fallback: anchors via the chunk when origin_sentence is a paraphrase not present in the text", () => {
    const candidate = {
      id: "c3",
      chunk: "disfrutar el proceso de aprender",
      origin_sentence: "Disfrutar el aprendizaje es lo más importante al final.",
    };
    expect(ARTICLE.includes(candidate.origin_sentence)).toBe(false);
    expect(ARTICLE.includes(candidate.chunk)).toBe(true);

    const { ranges, unanchored } = anchorCandidates(ARTICLE, [candidate]);
    expect(unanchored).toEqual([]);
    expect(ranges).toHaveLength(1);
    const [range] = ranges;
    expect(range.start).toBe(ARTICLE.indexOf(candidate.chunk));
    expect(ARTICLE.slice(range.start, range.end)).toBe(candidate.chunk);
  });

  it("marks a candidate unanchorable when neither the sentence nor the chunk are found", () => {
    const candidate = {
      id: "c4",
      chunk: "palabra inventada rara",
      origin_sentence: "Esta oración no existe en el artículo en absoluto.",
    };
    expect(ARTICLE.includes(candidate.origin_sentence)).toBe(false);
    expect(ARTICLE.includes(candidate.chunk)).toBe(false);

    const { ranges, unanchored } = anchorCandidates(ARTICLE, [candidate]);
    expect(ranges).toEqual([]);
    expect(unanchored).toEqual(["c4"]);
  });

  it("drops the later of two overlapping candidates into unanchored", () => {
    const sentence =
      "El español tiene una rica variedad de expresiones idiomáticas, y practicar con nativos siempre ayuda mucho.";
    const candidateA = { id: "c5a", chunk: "rica variedad de expresiones", origin_sentence: sentence };
    const candidateB = { id: "c5b", chunk: "variedad de expresiones idiomáticas", origin_sentence: sentence };

    const { ranges, unanchored } = anchorCandidates(ARTICLE, [candidateA, candidateB]);

    expect(ranges).toHaveLength(1);
    expect(ranges[0].candidateId).toBe("c5a");
    expect(ARTICLE.slice(ranges[0].start, ranges[0].end)).toBe(candidateA.chunk);
    expect(unanchored).toEqual(["c5b"]);
  });

  it("always anchors a repeated chunk to its first occurrence", () => {
    const candidate = {
      id: "c6",
      chunk: "siempre ayuda mucho",
      origin_sentence: "Oración que no aparece en el texto en absoluto y sirve solo de relleno.",
    };
    const firstOccurrence = ARTICLE.indexOf(candidate.chunk);
    const secondOccurrence = ARTICLE.indexOf(candidate.chunk, firstOccurrence + 1);
    expect(firstOccurrence).toBeGreaterThan(-1);
    expect(secondOccurrence).toBeGreaterThan(firstOccurrence);

    const { ranges, unanchored } = anchorCandidates(ARTICLE, [candidate]);
    expect(unanchored).toEqual([]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].start).toBe(firstOccurrence);
    expect(ARTICLE.slice(ranges[0].start, ranges[0].end)).toBe(candidate.chunk);
  });

  it("does not throw and returns empty results for an empty candidate list", () => {
    expect(() => anchorCandidates(ARTICLE, [])).not.toThrow();
    const result = anchorCandidates(ARTICLE, []);
    expect(result).toEqual({ ranges: [], unanchored: [] });
  });
});

describe("buildParagraphSegments", () => {
  it("splits the article into the correct number of paragraphs", () => {
    const segments = buildParagraphSegments(ARTICLE, []);
    expect(segments).toHaveLength(3);
  });

  it("reassembles a marked paragraph's segments back into the exact paragraph text, with the right candidateId", () => {
    const { ranges } = anchorCandidates(ARTICLE, [
      { id: "c1", chunk: "desafío enorme", origin_sentence: "El aprendizaje de un idioma nuevo puede ser un desafío enorme." },
    ]);
    const paragraphs = buildParagraphSegments(ARTICLE, ranges);
    expect(paragraphs).toHaveLength(3);

    const para1Segments = paragraphs[0];
    expect(para1Segments.map((s) => s.text).join("")).toBe(PARA1);

    const marks = para1Segments.filter(isMark);
    expect(marks).toHaveLength(1);
    expect(marks[0].candidateId).toBe("c1");
    expect(marks[0].text).toBe("desafío enorme");
  });

  it("clips a range crossing a paragraph boundary into both paragraphs", () => {
    const bounds = paragraphBoundaries(ARTICLE);
    const [para1, para2] = bounds;
    const crossRange: AnchorRange = {
      candidateId: "cross1",
      start: para1.end - 5,
      end: para2.start + 5,
    };

    const paragraphs = buildParagraphSegments(ARTICLE, [crossRange]);
    const para1Marks = paragraphs[0].filter(isMark);
    const para2Marks = paragraphs[1].filter(isMark);

    expect(para1Marks).toHaveLength(1);
    expect(para1Marks[0].candidateId).toBe("cross1");
    expect(para1Marks[0].text).toBe(ARTICLE.slice(crossRange.start, para1.end));

    expect(para2Marks).toHaveLength(1);
    expect(para2Marks[0].candidateId).toBe("cross1");
    expect(para2Marks[0].text).toBe(ARTICLE.slice(para2.start, crossRange.end));

    // Every paragraph still reassembles exactly, even the two that were clipped.
    expect(paragraphs[0].map((s) => s.text).join("")).toBe(PARA1);
    expect(paragraphs[1].map((s) => s.text).join("")).toBe(PARA2);
  });

  it("returns a single all-text segment per paragraph when there are no ranges", () => {
    const paragraphs = buildParagraphSegments(ARTICLE, []);
    expect(paragraphs).toHaveLength(3);
    for (const segments of paragraphs) {
      expect(segments).toHaveLength(1);
      expect(segments[0].kind).toBe("text");
    }
    expect(paragraphs[0][0].text).toBe(PARA1);
    expect(paragraphs[1][0].text).toBe(PARA2);
    expect(paragraphs[2][0].text).toBe(PARA3);
  });

  it("returns [] for empty text", () => {
    expect(buildParagraphSegments("", [])).toEqual([]);
  });
});
