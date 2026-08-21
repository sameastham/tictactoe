import type { ModelUsage } from "@/server/language/providers/provider";

const PRICES: Record<string, { inPerMTok: number; outPerMTok: number }> = {
  "claude-opus-5": { inPerMTok: 5, outPerMTok: 25 },
  "claude-sonnet-5": { inPerMTok: 3, outPerMTok: 15 },
  "claude-haiku-4-5": { inPerMTok: 1, outPerMTok: 5 },
};

const warnedModels = new Set<string>();

/**
 * Computes the USD cost of a model call from its token usage. Cache reads are
 * priced at 0.1x the input rate, cache writes at 1.25x the input rate — both
 * standard Anthropic prompt-caching multipliers. Returns 0 for an unknown
 * model, warning once per model id.
 */
export function computeCostUsd(model: string, usage: ModelUsage): number {
  const price = PRICES[model];
  if (!price) {
    if (!warnedModels.has(model)) {
      warnedModels.add(model);
      console.warn(`computeCostUsd: unknown model "${model}", pricing unavailable — cost recorded as 0`);
    }
    return 0;
  }

  const inputCost = (usage.inputTokens / 1_000_000) * price.inPerMTok;
  const outputCost = (usage.outputTokens / 1_000_000) * price.outPerMTok;
  const cacheReadCost = (usage.cacheReadTokens / 1_000_000) * (price.inPerMTok * 0.1);
  const cacheWriteCost = (usage.cacheWriteTokens / 1_000_000) * (price.inPerMTok * 1.25);

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
