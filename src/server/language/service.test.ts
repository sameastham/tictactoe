import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDb, type Db } from "@/db";
import { modelCalls } from "@/db/schema";
import type { ExtractInput, LearnerBlock } from "@/lib/contracts";
import { EXTRACT_PROMPT_VERSION } from "@/server/language/prompts";
import { FixtureProvider } from "@/server/language/providers/fixture";
import { ProviderError, type ModelProvider } from "@/server/language/providers/provider";
import { createLanguageService, NotImplementedError } from "@/server/language/service";

const ARTICLE_PATH = path.join(process.cwd(), "fixtures", "article-es-mx.txt");
const articleText = fs.readFileSync(ARTICLE_PATH, "utf-8");

function makeLearner(): LearnerBlock {
  return {
    level: "high B2 / low C1",
    variant: "Mexican Spanish",
    goal: "test goal",
    weak_categories: ["collocation"],
    recent_errors: [],
    due_items: [],
  };
}

describe("LanguageService.extract — with FixtureProvider", () => {
  it("returns the cleaned result and logs a successful model_calls row", async () => {
    const db: Db = createTestDb();
    const service = createLanguageService({ db, provider: new FixtureProvider() });
    const input: ExtractInput = { title: null, text: articleText };

    const { result, model } = await service.extract(input, makeLearner());

    expect(model).toBe("fixture");
    expect(result.candidates).toHaveLength(10);
    expect(result.candidates.map((c) => c.id)).toEqual(Array.from({ length: 10 }, (_, i) => `c${i + 1}`));

    const rows = db.select().from(modelCalls).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(true);
    expect(rows[0].provider).toBe("fixture");
    expect(rows[0].purpose).toBe("extract");
    expect(rows[0].costUsd).toBe(0);
    expect(rows[0].promptVersion).toBe(EXTRACT_PROMPT_VERSION);
    expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(rows[0].error).toBeNull();
  });
});

describe("LanguageService.extract — post-validation", () => {
  const GOOD_SENTENCE = "Esta es una buena frase de prueba con longitud suficiente para la validación.";
  const BAD_SENTENCE = "Esta otra oración jamás aparece dentro del texto original de prueba.";
  const inputText = `Texto introductorio de relleno para superar el mínimo exigido. ${GOOD_SENTENCE} Más texto de cierre para el artículo de prueba.`;

  function makeGoodBadProvider(): ModelProvider {
    return {
      name: "stub-good-bad",
      async completeJson(req) {
        const data = req.schema.parse({
          difficulty: "B2",
          candidates: [
            {
              id: "c1",
              chunk: "jamás aparece",
              origin_sentence: BAD_SENTENCE,
              register: "neutral",
              why: "bad candidate — not verbatim in the article",
              contrast_set: null,
              taxonomy: null,
            },
            {
              id: "c2",
              chunk: "buena frase",
              origin_sentence: GOOD_SENTENCE,
              register: "neutral",
              why: "good candidate — verbatim in the article",
              contrast_set: null,
              taxonomy: null,
            },
          ],
        });
        return {
          data,
          model: "stub-model",
          usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
  }

  it("drops a candidate whose origin_sentence isn't verbatim in the article, and reassigns ids", async () => {
    const db: Db = createTestDb();
    const service = createLanguageService({ db, provider: makeGoodBadProvider() });
    const input: ExtractInput = { title: null, text: inputText };

    const { result, model } = await service.extract(input, makeLearner());

    expect(model).toBe("stub-model");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].id).toBe("c1");
    expect(result.candidates[0].chunk).toBe("buena frase");

    const rows = db.select().from(modelCalls).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(true);
  });
});

describe("LanguageService.extract — provider failure", () => {
  function makeThrowingProvider(): ModelProvider {
    return {
      name: "stub-throw",
      async completeJson() {
        throw new ProviderError("boom: simulated provider failure", true);
      },
    };
  }

  it("logs a failed model_calls row and lets the error propagate", async () => {
    const db: Db = createTestDb();
    const service = createLanguageService({ db, provider: makeThrowingProvider() });
    const input: ExtractInput = {
      title: null,
      text: "Un texto de prueba con longitud suficiente para pasar la validación mínima exigida.",
    };

    await expect(service.extract(input, makeLearner())).rejects.toThrow(/boom/);

    const rows = db.select().from(modelCalls).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].error).toMatch(/boom/);
    expect(rows[0].provider).toBe("stub-throw");
  });
});

describe("LanguageService.judge / converse", () => {
  it("judge throws NotImplementedError without calling the provider", async () => {
    const db: Db = createTestDb();
    const service = createLanguageService({ db, provider: new FixtureProvider() });

    await expect(
      service.judge({ sentence: "test", task: null, targetItemIds: [] }, makeLearner()),
    ).rejects.toThrow(NotImplementedError);
  });

  it("converse throws NotImplementedError without calling the provider", async () => {
    const db: Db = createTestDb();
    const service = createLanguageService({ db, provider: new FixtureProvider() });

    await expect(service.converse({ messages: [] }, makeLearner())).rejects.toThrow(NotImplementedError);
  });
});
