import { describe, expect, it } from "vitest";
import { classifyMiss, diffDictation, missClassToTaxonomy, normalizeToken } from "@/lib/dictation";

describe("normalizeToken", () => {
  it("is accent-insensitive (típico / tipico match)", () => {
    expect(normalizeToken("típico")).toBe(normalizeToken("tipico"));
    expect(normalizeToken("típico")).toBe("tipico");
  });

  it("keeps ñ distinct from n (año vs ano)", () => {
    expect(normalizeToken("año")).not.toBe(normalizeToken("ano"));
    expect(normalizeToken("año")).toBe("año");
    expect(normalizeToken("ano")).toBe("ano");
  });

  it("lowercases and strips punctuation", () => {
    expect(normalizeToken("¿Qué?")).toBe("que");
    expect(normalizeToken("¡Órale!")).toBe("orale");
    expect(normalizeToken("«bien»,")).toBe("bien");
  });
});

describe("diffDictation", () => {
  it("perfect dictation yields zero misses and all matches", () => {
    const text = "El café ya está listo para servir.";
    const { tokens, misses } = diffDictation(text, text);
    expect(misses).toHaveLength(0);
    expect(tokens.every((t) => t.kind === "match")).toBe(true);
    expect(tokens).toHaveLength(text.split(" ").length);
  });

  it("perfect dictation is accent/case-insensitive too", () => {
    const { misses, tokens } = diffDictation(
      "Hoy fui al tianguis de Coyoacán.",
      "hoy fui al tianguis de coyoacan",
    );
    expect(misses).toHaveLength(0);
    expect(tokens.every((t) => t.kind === "match")).toBe(true);
  });

  it("empty typed input: every expected word is a miss", () => {
    const text = "El café ya está listo.";
    const { tokens, misses } = diffDictation(text, "");
    const expectedWordCount = text.split(" ").length;
    expect(misses).toHaveLength(expectedWordCount);
    expect(tokens.every((t) => t.kind === "miss")).toBe(true);
    expect(misses.every((m) => m.heard === null)).toBe(true);
  });

  it("collapses an adjacent delete+insert pair into one substitution miss", () => {
    const { tokens, misses } = diffDictation("El gato negro corre rápido.", "El perro negro corre rápido.");
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ expected: "gato", heard: "perro" });
    const missToken = tokens.find((t) => t.kind === "miss");
    expect(missToken).toMatchObject({ expected: "gato", heard: "perro" });
    // everything else still matches
    expect(tokens.filter((t) => t.kind === "match")).toHaveLength(4);
  });

  it("dropping a function word classifies as reduction (listening_reduction)", () => {
    const { misses } = diffDictation("Voy a la tienda de la esquina.", "Voy a tienda de la esquina.");
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ expected: "la", heard: null, class: "reduction" });
    expect(missClassToTaxonomy(misses[0].class)).toBe("listening_reduction");
  });

  it("a capitalized word mid-sentence classifies as proper_noun", () => {
    const { misses } = diffDictation("Fui a comer a Coyoacán ayer.", "Fui a comer a ayer.");
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ expected: "Coyoacán", heard: null, class: "proper_noun" });
    expect(missClassToTaxonomy(misses[0].class)).toBeNull();
  });

  it("a sentence-initial capitalized word is NOT treated as a proper noun", () => {
    // "Ella" is capitalized only because it's sentence-initial.
    const { misses } = diffDictation("Ella llegó tarde otra vez.", "llegó tarde otra vez.");
    expect(misses).toHaveLength(1);
    expect(misses[0].class).not.toBe("proper_noun");
  });

  it("an unknown content word (not function word, not a near-miss) classifies as lexical", () => {
    const { misses } = diffDictation("El clima estuvo espantoso hoy.", "El clima estuvo hoy.");
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ expected: "espantoso", heard: null, class: "lexical" });
    expect(missClassToTaxonomy(misses[0].class)).toBe("listening_lexical");
  });

  it("a near-mishearing (small edit distance, not a function word) classifies as near_miss", () => {
    // "año" (year) misheard as "ano" — Levenshtein distance 1, not a function word.
    const { misses } = diffDictation("Fue un año difícil para todos.", "Fue un ano difícil para todos.");
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ expected: "año", heard: "ano", class: "near_miss" });
    expect(missClassToTaxonomy(misses[0].class)).toBeNull();
  });

  it("extra typed words become kind:'extra' tokens and are not recorded as misses", () => {
    const { tokens, misses } = diffDictation("El café está listo.", "El café ya está listo por fin.");
    expect(misses).toHaveLength(0);
    const extras = tokens.filter((t) => t.kind === "extra");
    expect(extras.map((t) => t.heard)).toEqual(expect.arrayContaining(["ya", "por", "fin."]));
    expect(tokens.filter((t) => t.kind === "match")).toHaveLength(4);
  });
});

describe("classifyMiss", () => {
  it("proper_noun takes priority even if the word would otherwise be a near-miss", () => {
    // Capitalized, mid-sentence, and heard is a close edit-distance match —
    // proper_noun must still win over near_miss.
    const result = classifyMiss({
      expected: "coyoacan",
      heard: "coyacan",
      expectedRaw: "Coyoacán",
      sentenceInitial: false,
    });
    expect(result).toBe("proper_noun");
  });

  it("reduction takes priority over near_miss for function words", () => {
    const result = classifyMiss({ expected: "de", heard: "e", expectedRaw: "de", sentenceInitial: false });
    expect(result).toBe("reduction");
  });

  it("falls back to lexical when heard is null and nothing else matches", () => {
    const result = classifyMiss({
      expected: "aguacates",
      heard: null,
      expectedRaw: "aguacates",
      sentenceInitial: false,
    });
    expect(result).toBe("lexical");
  });
});
