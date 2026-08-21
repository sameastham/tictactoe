import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExtractResultSchema, type ExtractResult } from "@/lib/contracts";
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

describe("FixtureProvider — judge/converse", () => {
  it("throws a non-retryable ProviderError for judge", async () => {
    const provider = new FixtureProvider();
    await expect(
      provider.completeJson({
        purpose: "judge",
        system: "s",
        user: "u",
        schema: ExtractResultSchema,
        maxTokens: 100,
      }),
    ).rejects.toThrow(/does not implement judge/);
  });

  it("throws a non-retryable ProviderError for converse", async () => {
    const provider = new FixtureProvider();
    await expect(
      provider.completeJson({
        purpose: "converse",
        system: "s",
        user: "u",
        schema: ExtractResultSchema,
        maxTokens: 100,
      }),
    ).rejects.toThrow(/does not implement converse/);
  });
});
