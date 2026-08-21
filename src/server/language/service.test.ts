import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDb, type Db } from "@/db";
import { modelCalls } from "@/db/schema";
import { createContent } from "@/server/repo";
import type { ConverseInput, ExtractInput, JudgeInput, JudgeWireResult, LearnerBlock, SeedErrorInput } from "@/lib/contracts";
import {
  CONVERSE_PROMPT_VERSION,
  EXTRACT_PROMPT_VERSION,
  JUDGE_PROMPT_VERSION,
  SEED_ERROR_PROMPT_VERSION,
} from "@/server/language/prompts";
import { FixtureProvider } from "@/server/language/providers/fixture";
import { ProviderError, type ModelProvider } from "@/server/language/providers/provider";
import { createLanguageService } from "@/server/language/service";

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

describe("LanguageService.judge — with FixtureProvider", () => {
  it("returns the judged result and logs a successful model_calls row", async () => {
    const db: Db = createTestDb();
    const service = createLanguageService({ db, provider: new FixtureProvider() });
    const input: JudgeInput = {
      text: "Esto no puede hacer sentido. El café ya está listo.",
      task: null,
      target_items: [],
    };

    const { result, model } = await service.judge(input, makeLearner());

    expect(model).toBe("fixture");
    expect(result.sentences).toHaveLength(2);
    expect(result.sentences[0].rung).toBe("incorrect");
    expect(result.sentences[1].rung).toBe("natural");

    const rows = db.select().from(modelCalls).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(true);
    expect(rows[0].provider).toBe("fixture");
    expect(rows[0].purpose).toBe("judge");
    expect(rows[0].costUsd).toBe(0);
    expect(rows[0].promptVersion).toBe(JUDGE_PROMPT_VERSION);
    expect(rows[0].error).toBeNull();
  });

  it("marks better_version_attested true when the fix is present in a seeded content row, false otherwise", async () => {
    const db: Db = createTestDb();
    createContent(db, {
      source: "paste",
      type: "paste",
      text: "En este texto explicamos por qué es importante tener sentido al hablar en público.",
    });
    const service = createLanguageService({ db, provider: new FixtureProvider() });

    const input: JudgeInput = {
      text: "Esto no puede hacer sentido para mí. No deberíamos depender que el clima mejore mañana.",
      task: null,
      target_items: [],
    };

    const { result } = await service.judge(input, makeLearner());

    // "tener sentido" (the fix for "hacer sentido") is attested in the seeded content.
    expect(result.sentences[0].better_version_attested).toBe(true);
    // "depender de que" is not attested anywhere in the content store.
    expect(result.sentences[1].better_version_attested).toBe(false);
  });
});

describe("LanguageService.judge — post-validation", () => {
  const GOOD_SENTENCE = "Esta es una buena frase de prueba dentro del texto original.";
  const BAD_SENTENCE = "Esta otra oración jamás aparece dentro del texto original de prueba.";
  const inputText = `${GOOD_SENTENCE} Cierre del texto para pasar la validación mínima exigida.`;

  function makeGoodBadJudgeProvider(): ModelProvider {
    return {
      name: "stub-judge-good-bad",
      async completeJson(req) {
        const raw: JudgeWireResult = {
          sentences: [
            { sentence: BAD_SENTENCE, rung: "natural", issues: [], better_version: null },
            { sentence: GOOD_SENTENCE, rung: "natural", issues: [], better_version: null },
          ],
          items_used: [],
          items_avoided: [],
        };
        const data = req.schema.parse(raw);
        return {
          data,
          model: "stub-model",
          usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
  }

  it("drops a sentence that isn't verbatim in the submitted text", async () => {
    const db: Db = createTestDb();
    const service = createLanguageService({ db, provider: makeGoodBadJudgeProvider() });
    const input: JudgeInput = { text: inputText, task: null, target_items: [] };

    const { result, model } = await service.judge(input, makeLearner());

    expect(model).toBe("stub-model");
    expect(result.sentences).toHaveLength(1);
    expect(result.sentences[0].sentence).toBe(GOOD_SENTENCE);

    const rows = db.select().from(modelCalls).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(true);
  });

  function makeAllBadJudgeProvider(): ModelProvider {
    return {
      name: "stub-judge-all-bad",
      async completeJson(req) {
        const raw: JudgeWireResult = {
          sentences: [{ sentence: BAD_SENTENCE, rung: "natural", issues: [], better_version: null }],
          items_used: [],
          items_avoided: [],
        };
        const data = req.schema.parse(raw);
        return {
          data,
          model: "stub-model",
          usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
  }

  it("throws a retryable ProviderError and logs a failed model_calls row when 0 sentences survive", async () => {
    const db: Db = createTestDb();
    const service = createLanguageService({ db, provider: makeAllBadJudgeProvider() });
    const input: JudgeInput = { text: inputText, task: null, target_items: [] };

    await expect(service.judge(input, makeLearner())).rejects.toThrow(ProviderError);

    const rows = db.select().from(modelCalls).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].purpose).toBe("judge");
  });
});

describe("LanguageService.converse — with FixtureProvider", () => {
  it("returns the fixture's reply and logs a successful model_calls row", async () => {
    const db: Db = createTestDb();
    const service = createLanguageService({ db, provider: new FixtureProvider() });
    const input: ConverseInput = { topic: "Platiquemos de tu semana.", messages: [] };

    const { result, model } = await service.converse(input, makeLearner());

    expect(model).toBe("fixture");
    expect(typeof result.reply).toBe("string");
    expect(result.reply.length).toBeGreaterThan(0);

    const rows = db.select().from(modelCalls).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(true);
    expect(rows[0].provider).toBe("fixture");
    expect(rows[0].purpose).toBe("converse");
    expect(rows[0].costUsd).toBe(0);
    expect(rows[0].promptVersion).toBe(CONVERSE_PROMPT_VERSION);
    expect(rows[0].error).toBeNull();
  });

  it("logs a failed model_calls row and lets the error propagate on provider failure", async () => {
    const db: Db = createTestDb();
    const throwingProvider: ModelProvider = {
      name: "stub-throw",
      async completeJson() {
        throw new ProviderError("boom: simulated converse failure", true);
      },
    };
    const service = createLanguageService({ db, provider: throwingProvider });
    const input: ConverseInput = { topic: "Un tema cualquiera.", messages: [] };

    await expect(service.converse(input, makeLearner())).rejects.toThrow(/boom/);

    const rows = db.select().from(modelCalls).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].purpose).toBe("converse");
    expect(rows[0].error).toMatch(/boom/);
  });
});

describe("LanguageService.seedError — with FixtureProvider", () => {
  it("returns the fixture's catalogue-based result and logs a successful model_calls row with purpose seed_error", async () => {
    const db: Db = createTestDb();
    const service = createLanguageService({ db, provider: new FixtureProvider() });
    const input: SeedErrorInput = { sentence: "Esto tiene sentido para mí.", allowed_tags: ["word_choice"] };

    const { result, model } = await service.seedError(input, makeLearner());

    expect(model).toBe("fixture");
    expect(result.can_inject).toBe(true);
    expect(result.mutated).toBe("Esto hace sentido para mí.");
    expect(result.tag).toBe("word_choice");

    const rows = db.select().from(modelCalls).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(true);
    expect(rows[0].provider).toBe("fixture");
    expect(rows[0].purpose).toBe("seed_error");
    expect(rows[0].costUsd).toBe(0);
    expect(rows[0].promptVersion).toBe(SEED_ERROR_PROMPT_VERSION);
    expect(rows[0].error).toBeNull();
  });

  it("logs a failed model_calls row and lets the error propagate on provider failure", async () => {
    const db: Db = createTestDb();
    const throwingProvider: ModelProvider = {
      name: "stub-throw",
      async completeJson() {
        throw new ProviderError("boom: simulated seed_error failure", true);
      },
    };
    const service = createLanguageService({ db, provider: throwingProvider });
    const input: SeedErrorInput = { sentence: "Una oración cualquiera de prueba.", allowed_tags: ["grammar"] };

    await expect(service.seedError(input, makeLearner())).rejects.toThrow(/boom/);

    const rows = db.select().from(modelCalls).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].purpose).toBe("seed_error");
    expect(rows[0].error).toMatch(/boom/);
  });
});
