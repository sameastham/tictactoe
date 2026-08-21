import type { Db } from "@/db";
import { getDb } from "@/db";
import { content } from "@/db/schema";
import { logModelCall } from "@/server/repo";
import {
  ConverseResultSchema,
  ExtractResultSchema,
  JudgeWireResultSchema,
  type ConverseInput,
  type ConverseResult,
  type ExtractInput,
  type ExtractResult,
  type JudgeInput,
  type JudgeResult,
  type JudgeWireResult,
  type JudgedSentence,
  type JudgedSentenceWire,
  type LearnerBlock,
} from "@/lib/contracts";
import {
  CONVERSE_PROMPT_VERSION,
  EXTRACT_PROMPT_VERSION,
  JUDGE_PROMPT_VERSION,
  loadPrompt,
  renderPrompt,
} from "@/server/language/prompts";
import { computeCostUsd } from "@/server/language/pricing";
import { getProvider } from "@/server/language/providers";
import { ProviderError, type ModelJsonResponse, type ModelProvider } from "@/server/language/providers/provider";

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
  judge(input: JudgeInput, learner: LearnerBlock): Promise<{ result: JudgeResult; model: string }>;
  converse(input: ConverseInput, learner: LearnerBlock): Promise<{ result: ConverseResult; model: string }>;
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

/**
 * True if `phrase`, whitespace-normalized, appears verbatim as a substring
 * of any stored content's text. Single full-table scan — fine at this
 * single-user scale. Used to mark a judge-proposed `better_version` as
 * attested (drawn from real, previously-seen usage) vs. merely model-invented.
 */
function isAttested(db: Db, phrase: string): boolean {
  const normalizedPhrase = normalizeWhitespace(phrase);
  if (!normalizedPhrase) return false;
  const rows = db.select({ text: content.text }).from(content).all();
  return rows.some((row) => normalizeWhitespace(row.text).includes(normalizedPhrase));
}

/**
 * Drops sentences that violate the judge prompt's hard constraint (`sentence`
 * not verbatim in the submitted text), and clamps `items_used`/`items_avoided`
 * to the ids that were actually offered as `target_items`.
 */
function cleanJudgeResult(result: JudgeWireResult, inputText: string, targetIds: Set<string>): JudgeWireResult {
  const normalizedText = normalizeWhitespace(inputText);

  const sentences = result.sentences.filter((sentence) => {
    const normalizedSentence = normalizeWhitespace(sentence.sentence);
    if (!normalizedText.includes(normalizedSentence)) {
      console.warn(`judge: dropping sentence — not verbatim in the submitted text: "${sentence.sentence}"`);
      return false;
    }
    return true;
  });

  return {
    sentences,
    items_used: result.items_used.filter((id) => targetIds.has(id)),
    items_avoided: result.items_avoided.filter((id) => targetIds.has(id)),
  };
}

/** better_version_attested = false when better_version is null; otherwise checked against the content store. */
function computeAttestation(db: Db, sentence: JudgedSentenceWire): boolean {
  if (sentence.better_version === null) return false;
  if (isAttested(db, sentence.better_version)) return true;
  return sentence.issues.some((issue) => isAttested(db, issue.fix));
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

  /** Logs one model_calls row for the judge purpose, success or failure. */
  function recordJudgeCall(params: {
    ok: boolean;
    error?: string | null;
    response?: ModelJsonResponse<JudgeWireResult>;
    durationMs: number;
  }): void {
    const { ok, error = null, response, durationMs } = params;
    const usage = response?.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const model = response?.model ?? process.env.MODEL_ID ?? "unknown";

    logModelCall(db, {
      purpose: "judge",
      provider: provider.name,
      model,
      promptVersion: JUDGE_PROMPT_VERSION,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd: response ? computeCostUsd(model, usage) : 0,
      durationMs,
      ok,
      error,
      contentId: null,
    });
  }

  async function judge(
    input: JudgeInput,
    learner: LearnerBlock,
  ): Promise<{ result: JudgeResult; model: string }> {
    const prompt = renderPrompt(loadPrompt("judge", JUDGE_PROMPT_VERSION).text, learner);
    const userMessage = JSON.stringify({
      text: input.text,
      task: input.task,
      target_items: input.target_items,
    });

    const startedAt = Date.now();
    let response: ModelJsonResponse<JudgeWireResult>;
    try {
      response = await provider.completeJson({
        purpose: "judge",
        system: prompt,
        user: userMessage,
        schema: JudgeWireResultSchema,
        maxTokens: 16000,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      recordJudgeCall({ ok: false, error: message, durationMs });
      throw error;
    }
    const durationMs = Date.now() - startedAt;

    const targetIds = new Set(input.target_items.map((item) => item.id));
    const cleaned = cleanJudgeResult(response.data, input.text, targetIds);

    if (cleaned.sentences.length === 0) {
      const error = new ProviderError("judge: no sentences survived post-validation", true);
      recordJudgeCall({ ok: false, error: error.message, response, durationMs });
      throw error;
    }

    const sentences: JudgedSentence[] = cleaned.sentences.map((sentence) => ({
      ...sentence,
      better_version_attested: computeAttestation(db, sentence),
    }));

    const result: JudgeResult = {
      sentences,
      items_used: cleaned.items_used,
      items_avoided: cleaned.items_avoided,
    };

    recordJudgeCall({ ok: true, response, durationMs });
    return { result, model: response.model };
  }

  /** Logs one model_calls row for the converse purpose, success or failure. */
  function recordConverseCall(params: {
    ok: boolean;
    error?: string | null;
    response?: ModelJsonResponse<ConverseResult>;
    durationMs: number;
  }): void {
    const { ok, error = null, response, durationMs } = params;
    const usage = response?.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const model = response?.model ?? process.env.MODEL_ID ?? "unknown";

    logModelCall(db, {
      purpose: "converse",
      provider: provider.name,
      model,
      promptVersion: CONVERSE_PROMPT_VERSION,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd: response ? computeCostUsd(model, usage) : 0,
      durationMs,
      ok,
      error,
      contentId: null,
    });
  }

  async function converse(
    input: ConverseInput,
    learner: LearnerBlock,
  ): Promise<{ result: ConverseResult; model: string }> {
    const prompt = renderPrompt(loadPrompt("converse", CONVERSE_PROMPT_VERSION).text, learner);
    const userMessage = JSON.stringify({ topic: input.topic, messages: input.messages });

    const startedAt = Date.now();
    let response: ModelJsonResponse<ConverseResult>;
    try {
      response = await provider.completeJson({
        purpose: "converse",
        system: prompt,
        user: userMessage,
        schema: ConverseResultSchema,
        maxTokens: 2000,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      recordConverseCall({ ok: false, error: message, durationMs });
      throw error;
    }
    const durationMs = Date.now() - startedAt;

    recordConverseCall({ ok: true, response, durationMs });
    return { result: response.data, model: response.model };
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
