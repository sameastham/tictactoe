import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConverseResultSchema,
  ExtractResultSchema,
  JudgeWireResultSchema,
  SeedErrorWireResultSchema,
  type ConverseInput,
  type ExtractResult,
  type JudgeInput,
  type SeedErrorInput,
} from "@/lib/contracts";
import { FixtureProvider } from "@/server/language/providers/fixture";
import type { ModelJsonRequest } from "@/server/language/providers/provider";

const ARTICLE_PATH = path.join(process.cwd(), "fixtures", "article-es-mx.txt");
const articleText = fs.readFileSync(ARTICLE_PATH, "utf-8");

function extractRequest(user: string): ModelJsonRequest<ExtractResult> {
  return {
    purpose: "extract",
    system: "system prompt (unused by the fixture provider)",
    user,
    schema: ExtractResultSchema,
    maxTokens: 16000,
  };
}

function judgeRequest(input: JudgeInput) {
  return {
    purpose: "judge" as const,
    system: "system prompt (unused by the fixture provider)",
    user: JSON.stringify(input),
    schema: JudgeWireResultSchema,
    maxTokens: 16000,
  };
}

function converseRequest(input: ConverseInput) {
  return {
    purpose: "converse" as const,
    system: "system prompt (unused by the fixture provider)",
    user: JSON.stringify(input),
    schema: ConverseResultSchema,
    maxTokens: 2000,
  };
}

function seedErrorRequest(input: SeedErrorInput) {
  return {
    purpose: "seed_error" as const,
    system: "system prompt (unused by the fixture provider)",
    user: JSON.stringify(input),
    schema: SeedErrorWireResultSchema,
    maxTokens: 1000,
  };
}

describe("FixtureProvider — extract — canned path", () => {
  it("returns the canned result for the exact article text", async () => {
    const provider = new FixtureProvider();
    const res = await provider.completeJson(extractRequest(articleText));
    expect(res.data.candidates).toHaveLength(10);
    expect(res.data.candidates.map((c) => c.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `c${i + 1}`),
    );
  });

  it("returns the same canned result when the article is prefixed with a title", async () => {
    const provider = new FixtureProvider();
    const plain = await provider.completeJson(extractRequest(articleText));
    const withTitle = await provider.completeJson(extractRequest(`# Un título\n\n${articleText}`));
    expect(withTitle.data).toEqual(plain.data);
  });

  // This test guards the fixture files themselves: if article-es-mx.txt and
  // extract.article-es-mx.json are ever authored out of sync, fix the JSON,
  // not this test.
  it("every canned candidate's origin_sentence is verbatim in the article, and chunk is verbatim in origin_sentence", async () => {
    const provider = new FixtureProvider();
    const res = await provider.completeJson(extractRequest(articleText));
    for (const candidate of res.data.candidates) {
      expect(articleText.includes(candidate.origin_sentence)).toBe(true);
      expect(candidate.origin_sentence.includes(candidate.chunk)).toBe(true);
    }
  });
});

describe("FixtureProvider — extract — synthetic path", () => {
  const TWELVE_SENTENCE_TEXT = Array.from(
    { length: 12 },
    (_, i) => `Esta es la oración número ${i + 1} del texto de prueba para el extractor.`,
  ).join(" ");

  it("is deterministic across two calls", async () => {
    const provider = new FixtureProvider();
    const a = await provider.completeJson(extractRequest(TWELVE_SENTENCE_TEXT));
    const b = await provider.completeJson(extractRequest(TWELVE_SENTENCE_TEXT));
    expect(a.data).toEqual(b.data);
  });

  it("is schema-valid and produces at most 10 candidates, at least 1, for a 12-sentence text", async () => {
    const provider = new FixtureProvider();
    const res = await provider.completeJson(extractRequest(TWELVE_SENTENCE_TEXT));
    expect(() => ExtractResultSchema.parse(res.data)).not.toThrow();
    expect(res.data.candidates.length).toBeGreaterThanOrEqual(1);
    expect(res.data.candidates.length).toBeLessThanOrEqual(10);
  });

  it("produces exactly 1 candidate for a 3-word input", async () => {
    const provider = new FixtureProvider();
    const res = await provider.completeJson(extractRequest("Hola buenas tardes"));
    expect(res.data.candidates).toHaveLength(1);
  });
});

describe("FixtureProvider — judge — deterministic rules", () => {
  it("'hacer sentido' -> incorrect, word_choice issue, swapped better_version", async () => {
    const provider = new FixtureProvider();
    const res = await provider.completeJson(
      judgeRequest({ text: "No puedo hacer sentido de esto.", task: null, target_items: [] }),
    );
    expect(res.data.sentences).toHaveLength(1);
    const sentence = res.data.sentences[0];
    expect(sentence.rung).toBe("incorrect");
    expect(sentence.issues).toEqual([
      {
        tag: "word_choice",
        severity: "major",
        span: "hacer sentido",
        fix: "tener sentido",
        note: "[fixture] calco del inglés 'to make sense'",
      },
    ]);
    expect(sentence.better_version).toBe("No puedo tener sentido de esto.");
  });

  it("'depender que' -> incorrect, preposition issue, swapped better_version", async () => {
    const provider = new FixtureProvider();
    const res = await provider.completeJson(
      judgeRequest({ text: "Todo va a depender que llueva.", task: null, target_items: [] }),
    );
    const sentence = res.data.sentences[0];
    expect(sentence.rung).toBe("incorrect");
    expect(sentence.issues[0]).toMatchObject({ tag: "preposition", severity: "major", span: "depender que" });
    expect(sentence.better_version).toBe("Todo va a depender de que llueva.");
  });

  it("'muy muy' -> acceptable, redundancy issue, swapped better_version", async () => {
    const provider = new FixtureProvider();
    const res = await provider.completeJson(
      judgeRequest({ text: "Está muy muy cansado hoy.", task: null, target_items: [] }),
    );
    const sentence = res.data.sentences[0];
    expect(sentence.rung).toBe("acceptable");
    expect(sentence.issues[0]).toMatchObject({ tag: "redundancy", severity: "minor", span: "muy muy" });
    expect(sentence.better_version).toBe("Está muy cansado hoy.");
  });

  it("a sentence matching no error pattern is natural with no issues and a null better_version", async () => {
    const provider = new FixtureProvider();
    const res = await provider.completeJson(
      judgeRequest({ text: "El café ya está listo.", task: null, target_items: [] }),
    );
    const sentence = res.data.sentences[0];
    expect(sentence.rung).toBe("natural");
    expect(sentence.issues).toEqual([]);
    expect(sentence.better_version).toBeNull();
  });

  it("credits items_used for a target chunk that appears in some sentence, items_avoided otherwise", async () => {
    const provider = new FixtureProvider();
    const res = await provider.completeJson(
      judgeRequest({
        text: "Ayer fui al mercado a comprar fruta. El clima estuvo agradable todo el día.",
        task: null,
        target_items: [
          { id: "it_used", chunk: "ir al mercado" },
          { id: "it_avoided", chunk: "hacer la maleta" },
        ],
      }),
    );
    expect(res.data.items_used).toEqual([]);
    expect(res.data.items_avoided).toEqual(["it_used", "it_avoided"]);

    const res2 = await provider.completeJson(
      judgeRequest({
        text: "Fui al mercado ayer. El clima estuvo agradable todo el día.",
        task: null,
        target_items: [
          { id: "it_used", chunk: "al mercado" },
          { id: "it_avoided", chunk: "hacer la maleta" },
        ],
      }),
    );
    expect(res2.data.items_used).toEqual(["it_used"]);
    expect(res2.data.items_avoided).toEqual(["it_avoided"]);
  });

  it("is schema-valid against JudgeWireResultSchema", async () => {
    const provider = new FixtureProvider();
    const res = await provider.completeJson(
      judgeRequest({
        text: "Esto no puede hacer sentido. El café ya está listo.",
        task: null,
        target_items: [],
      }),
    );
    expect(() => JudgeWireResultSchema.parse(res.data)).not.toThrow();
    expect(res.model).toBe("fixture");
  });
});

describe("FixtureProvider — converse — deterministic by turn count", () => {
  it("opens with reply[0] on an empty history", async () => {
    const provider = new FixtureProvider();
    const res = await provider.completeJson(converseRequest({ topic: "Un tema", messages: [] }));
    expect(res.data.reply).toBe(
      "¡Qué gusto platicar contigo! Cuéntame, ¿qué es lo que más te llamó la atención de todo esto?",
    );
    expect(res.model).toBe("fixture");
  });

  it("picks reply[min(learnerTurnCount, 4)], counting only learner-role turns", async () => {
    const provider = new FixtureProvider();

    const oneLearnerTurn = await provider.completeJson(
      converseRequest({
        topic: "Un tema",
        messages: [
          { role: "tutor", text: "Hola, ¿cómo estás?" },
          { role: "learner", text: "Bien, gracias." },
        ],
      }),
    );
    expect(oneLearnerTurn.data.reply).toBe("Órale, qué interesante lo que dices. ¿Y tú por qué crees que pasa así?");

    const fiveLearnerTurns = await provider.completeJson(
      converseRequest({
        topic: "Un tema",
        messages: Array.from({ length: 5 }, (_, i) => ({ role: "learner" as const, text: `mensaje ${i}` })),
      }),
    );
    expect(fiveLearnerTurns.data.reply).toBe(
      "Bueno, pues ya le dimos bastantes vueltas al tema. Me dio gusto escuchar cómo lo ves tú.",
    );
  });

  it("is deterministic across two identical calls, and ignores topic entirely", async () => {
    const provider = new FixtureProvider();
    const messages = [{ role: "learner" as const, text: "Algo" }];
    const a = await provider.completeJson(converseRequest({ topic: "Tema A", messages }));
    const b = await provider.completeJson(converseRequest({ topic: "Tema totalmente distinto", messages }));
    expect(a.data).toEqual(b.data);
  });

  it("is schema-valid against ConverseResultSchema", async () => {
    const provider = new FixtureProvider();
    const res = await provider.completeJson(converseRequest({ topic: "Un tema", messages: [] }));
    expect(() => ConverseResultSchema.parse(res.data)).not.toThrow();
  });
});

describe("FixtureProvider — seed_error — reuses the goldset catalogue", () => {
  it("matches the first catalogue injector whose tag is allowed and pattern matches", async () => {
    const provider = new FixtureProvider();
    const res = await provider.completeJson(
      seedErrorRequest({ sentence: "Esto tiene sentido para mí.", allowed_tags: ["word_choice"] }),
    );
    expect(res.data).toEqual({
      can_inject: true,
      mutated: "Esto hace sentido para mí.",
      tag: "word_choice",
      expected_rung: "incorrect",
      original_span: "tiene sentido",
      mutated_span: "hace sentido",
    });
    expect(res.model).toBe("fixture");
  });

  it("respects allowed_tags: a matching injector whose tag isn't offered doesn't fire", async () => {
    const provider = new FixtureProvider();
    const res = await provider.completeJson(
      seedErrorRequest({ sentence: "Esto tiene sentido para mí.", allowed_tags: ["grammar"] }),
    );
    expect(res.data).toEqual({
      can_inject: false,
      mutated: null,
      tag: null,
      expected_rung: null,
      original_span: null,
      mutated_span: null,
    });
  });

  it("can_inject: false when no catalogue injector matches the sentence at all", async () => {
    const provider = new FixtureProvider();
    const res = await provider.completeJson(
      seedErrorRequest({ sentence: "El café ya está listo.", allowed_tags: ["idiomaticity", "discourse"] }),
    );
    expect(res.data.can_inject).toBe(false);
    expect(res.data.mutated).toBeNull();
    expect(res.data.tag).toBeNull();
    expect(res.data.expected_rung).toBeNull();
    expect(res.data.original_span).toBeNull();
    expect(res.data.mutated_span).toBeNull();
  });

  it("is schema-valid against SeedErrorWireResultSchema", async () => {
    const provider = new FixtureProvider();
    const res = await provider.completeJson(
      seedErrorRequest({ sentence: "Todo depende de que llueva mañana.", allowed_tags: ["preposition"] }),
    );
    expect(() => SeedErrorWireResultSchema.parse(res.data)).not.toThrow();
    expect(res.data.can_inject).toBe(true);
  });
});
