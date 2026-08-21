import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb, type Db } from "@/db";
import { goldSet } from "@/db/schema";
import { DEFAULT_USER_ID } from "@/lib/ids";
import type {
  ConverseInput,
  ConverseResult,
  ExtractInput,
  ExtractResult,
  JudgeInput,
  JudgeResult,
  LearnerBlock,
  SeedErrorInput,
  SeedErrorWireResult,
} from "@/lib/contracts";
import { createContent } from "@/server/repo";
import type { LanguageService } from "@/server/language/service";
import { buildSeededErrors, verifySingleChange } from "@/server/goldset/build";

describe("verifySingleChange", () => {
  it("passes for an exact single contiguous change", () => {
    const original = "El café está listo.";
    const mutated = "El café esta listo.";
    expect(verifySingleChange(original, mutated, "está listo", "esta listo")).toBe(true);
  });

  it("fails when the mutated sentence has a second, unclaimed change", () => {
    const original = "La segunda oración únicamente sirve para completar la prueba.";
    // Claim only "segunda" -> "segundo", but the actual mutated string also changes "sirve".
    const mutated = "La segundo oración únicamente sirve rarísimo para completar la prueba.";
    expect(verifySingleChange(original, mutated, "segunda", "segundo")).toBe(false);
  });

  it("fails when originalSpan does not occur in original", () => {
    const original = "El café está listo.";
    const mutated = "El café está listo, gracias.";
    expect(verifySingleChange(original, mutated, "no existe en la oración", "algo")).toBe(false);
  });

  it("fails when mutated is identical to original", () => {
    const original = "El café está listo.";
    expect(verifySingleChange(original, original, "está", "está")).toBe(false);
  });

  it("passes when the span occurs twice and only the first occurrence was replaced", () => {
    const original = "muy bien, pero muy mal también";
    const mutated = "algo bien, pero muy mal también";
    expect(verifySingleChange(original, mutated, "muy", "algo")).toBe(true);
  });

  it("fails when the mutated string was built from the second occurrence instead of the first", () => {
    const original = "muy bien, pero muy mal también";
    // Claims to replace the first "muy", but the actual replacement happened on the second one.
    const mutated = "muy bien, pero algo mal también";
    expect(verifySingleChange(original, mutated, "muy", "algo")).toBe(false);
  });

  it("fails when originalSpan is empty", () => {
    expect(verifySingleChange("hola mundo", "hola mundo!", "", "!")).toBe(false);
  });
});

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

/**
 * A stub LanguageService whose `seedError` returns, in call order: (1) a
 * legitimate single-span mutation that passes `verifySingleChange`, then
 * (2) a "cheating" mutation that claims one span but actually changes a
 * second, unrelated span too — so it fails `verifySingleChange`.
 */
function makeStubSeedErrorService(): LanguageService {
  let call = 0;
  const notImplemented = (): never => {
    throw new Error("not implemented in this stub");
  };
  return {
    extract: (_input: ExtractInput, _learner: LearnerBlock): Promise<{ result: ExtractResult; model: string }> =>
      notImplemented(),
    judge: (_input: JudgeInput, _learner: LearnerBlock): Promise<{ result: JudgeResult; model: string }> =>
      notImplemented(),
    converse: (_input: ConverseInput, _learner: LearnerBlock): Promise<{ result: ConverseResult; model: string }> =>
      notImplemented(),
    async seedError(
      input: SeedErrorInput,
      _learner: LearnerBlock,
    ): Promise<{ result: SeedErrorWireResult; model: string }> {
      call++;
      if (call === 1) {
        const originalSpan = "tiene sentido";
        const mutatedSpan = "hace sentido";
        const result: SeedErrorWireResult = {
          can_inject: true,
          mutated: input.sentence.replace(originalSpan, mutatedSpan),
          tag: "word_choice",
          expected_rung: "incorrect",
          original_span: originalSpan,
          mutated_span: mutatedSpan,
        };
        return { result, model: "stub-seed-error" };
      }

      // Cheating result: claims "segunda" -> "segundo" but the returned
      // `mutated` string also changes "sirve" -> "sirve rarísimo".
      const result: SeedErrorWireResult = {
        can_inject: true,
        mutated: input.sentence.replace("segunda", "segundo").replace("sirve", "sirve rarísimo"),
        tag: "grammar",
        expected_rung: "acceptable",
        original_span: "segunda",
        mutated_span: "segundo",
      };
      return { result, model: "stub-seed-error" };
    },
  };
}

describe("buildSeededErrors — mode: model", () => {
  it("inserts a verified mutation and counts/skips one that fails the rule check", async () => {
    const db: Db = createTestDb();
    const sentenceA = "Todos coincidimos en que este argumento tiene sentido dentro del contexto del taller.";
    const sentenceB = "La segunda oración únicamente sirve para completar la ventana de prueba determinista.";
    createContent(db, { source: "paste", type: "paste", text: `${sentenceA} ${sentenceB}` });

    const result = await buildSeededErrors(db, 10, {
      mode: "model",
      service: makeStubSeedErrorService(),
      learner: makeLearner(),
    });

    expect(result.windowSize).toBe(2);
    expect(result.inserted).toBe(1);
    expect(result.rejectedByRuleCheck).toBe(1);

    const rows = db.select().from(goldSet).where(eq(goldSet.userId, DEFAULT_USER_ID)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].set).toBe("seeded_error");
    expect(rows[0].sentence).toBe(sentenceA.replace("tiene sentido", "hace sentido"));
    expect(rows[0].expectedRung).toBe("incorrect");
    expect(rows[0].expectedTags).toEqual(["word_choice"]);
    expect(rows[0].origin).toMatch(/^seeded-model:content:/);
  });

  it("throws when service/learner are omitted", async () => {
    const db: Db = createTestDb();
    await expect(buildSeededErrors(db, 10, { mode: "model" })).rejects.toThrow(/requires opts.service/);
  });
});
