import type { Db } from "@/db";
import { getDb } from "@/db";
import { logModelCall } from "@/server/repo";
import {
  ExtractResultSchema,
  type ConverseInput,
  type ConverseResult,
  type ExtractInput,
  type ExtractResult,
  type JudgeInput,
  type JudgeResult,
  type LearnerBlock,
} from "@/lib/contracts";
import { EXTRACT_PROMPT_VERSION, loadPrompt, renderPrompt } from "@/server/language/prompts";
import { computeCostUsd } from "@/server/language/pricing";
import { getProvider } from "@/server/language/providers";
import { ProviderError, type ModelJsonResponse, type ModelProvider } from "@/server/language/providers/provider";

/** Thrown by prompts that are speced but not yet implemented (judge, converse). */
export class NotImplementedError extends Error {}

/**
 * The single entry point for every model call in the app. Nothing outside
 * this module talks to a `ModelProvider` directly.
 */
export interface LanguageService {
  extract(
    input: ExtractInput,
    learner: LearnerBlock,
    opts?: { contentId?: string },
  ): Promise<{ result: ExtractResult; model: string }>;
  judge(input: JudgeInput, learner: LearnerBlock): Promise<JudgeResult>;
  converse(input: ConverseInput, learner: LearnerBlock): Promise<ConverseResult>;
}

/** trim + collapse all whitespace runs to a single space. */
function normalizeWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/**
 * Drops candidates that violate the extraction prompt's hard constraints
 * (origin_sentence not verbatim in the article, chunk not verbatim in
 * origin_sentence), clamps to 12, and reassigns ids c1..cN in order.
 */
function cleanExtractResult(result: ExtractResult, articleText: string): ExtractResult {
  const normalizedArticle = normalizeWhitespace(articleText);

  const kept = result.candidates.filter((candidate) => {
    const normalizedSentence = normalizeWhitespace(candidate.origin_sentence);
    if (!normalizedArticle.includes(normalizedSentence)) {
      console.warn(
        `extract: dropping candidate ${candidate.id} — origin_sentence is not verbatim in the article text`,
      );
      return false;
    }
    if (!candidate.origin_sentence.includes(candidate.chunk)) {
      console.warn(`extract: dropping candidate ${candidate.id} — chunk is not verbatim in origin_sentence`);
      return false;
    }
    return true;
  });

  const clamped = kept.slice(0, 12);
  const candidates = clamped.map((candidate, i) => ({ ...candidate, id: `c${i + 1}` }));

  return { difficulty: result.difficulty, candidates };
}

export function createLanguageService(deps: { db: Db; provider: ModelProvider }): LanguageService {
  const { db, provider } = deps;

  /** Logs one model_calls row for the extract purpose, success or failure. */
  function recordExtractCall(params: {
    ok: boolean;
    error?: string | null;
    response?: ModelJsonResponse<ExtractResult>;
    durationMs: number;
    contentId?: string;
  }): void {
    const { ok, error = null, response, durationMs, contentId } = params;
    const usage = response?.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const model = response?.model ?? process.env.MODEL_ID ?? "unknown";

    logModelCall(db, {
      purpose: "extract",
      provider: provider.name,
      model,
      promptVersion: EXTRACT_PROMPT_VERSION,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd: response ? computeCostUsd(model, usage) : 0,
      durationMs,
      ok,
      error,
      contentId: contentId ?? null,
    });
  }

  async function extract(
    input: ExtractInput,
    learner: LearnerBlock,
    opts?: { contentId?: string },
  ): Promise<{ result: ExtractResult; model: string }> {
    const prompt = renderPrompt(loadPrompt("extract", EXTRACT_PROMPT_VERSION).text, learner);
    const userMessage = input.title ? `# ${input.title}\n\n${input.text}` : input.text;

    const startedAt = Date.now();
    let response: ModelJsonResponse<ExtractResult>;
    try {
      response = await provider.completeJson({
        purpose: "extract",
        system: prompt,
        user: userMessage,
        schema: ExtractResultSchema,
        maxTokens: 16000,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      recordExtractCall({ ok: false, error: message, durationMs, contentId: opts?.contentId });
      throw error;
    }
    const durationMs = Date.now() - startedAt;

    const cleaned = cleanExtractResult(response.data, input.text);

    if (cleaned.candidates.length === 0) {
      const error = new ProviderError("extract: no candidates survived post-validation", true);
      recordExtractCall({
        ok: false,
        error: error.message,
        response,
        durationMs,
        contentId: opts?.contentId,
      });
      throw error;
    }

    recordExtractCall({ ok: true, response, durationMs, contentId: opts?.contentId });
    return { result: cleaned, model: response.model };
  }

  async function judge(_input: JudgeInput, _learner: LearnerBlock): Promise<JudgeResult> {
    throw new NotImplementedError("judge is not implemented yet — see prompts/ and §4.2 of the plan");
  }

  async function converse(_input: ConverseInput, _learner: LearnerBlock): Promise<ConverseResult> {
    throw new NotImplementedError("converse is not implemented yet — see prompts/ and §4.2 of the plan");
  }

  return { extract, judge, converse };
}

let cachedService: LanguageService | undefined;

/** Convenience accessor: `getDb()` + `getProvider()`, wired once and cached. */
export function getLanguageService(): LanguageService {
  if (!cachedService) {
    cachedService = createLanguageService({ db: getDb(), provider: getProvider() });
  }
  return cachedService;
}
