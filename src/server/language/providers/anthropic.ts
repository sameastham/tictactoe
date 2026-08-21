import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  ProviderError,
  type ModelJsonRequest,
  type ModelJsonResponse,
  type ModelProvider,
  type ModelUsage,
} from "@/server/language/providers/provider";

const DEFAULT_MODEL = "claude-opus-5";

/**
 * Model provider backed by the real Anthropic API (SDK 0.120.x).
 * Requires `ANTHROPIC_API_KEY` (or another credential source the SDK
 * resolves on its own) — the client is created lazily on first use so
 * constructing this provider never requires a key to be present.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";

  private client: Anthropic | undefined;

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic();
    }
    return this.client;
  }

  async completeJson<T>(req: ModelJsonRequest<T>): Promise<ModelJsonResponse<T>> {
    const client = this.getClient();
    const model = process.env.MODEL_ID || DEFAULT_MODEL;

    const response = await this.callParse(client, model, req);

    // A safety classifier declined the request. Not retryable — retrying
    // the identical request will refuse again.
    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category ?? "unknown";
      throw new ProviderError(`Anthropic refused the request (stop_reason: refusal, category: ${category})`, false);
    }

    // Guard before trusting parsed_output — a null value means structured
    // parsing didn't happen (e.g. no text block came back) even though the
    // call itself succeeded. Worth a retry.
    if (response.parsed_output == null) {
      throw new ProviderError("Anthropic response had no parsed_output", true);
    }

    const usage: ModelUsage = {
      inputTokens: response.usage.input_tokens ?? 0,
      outputTokens: response.usage.output_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };

    return {
      data: response.parsed_output,
      model: response.model,
      usage,
    };
  }

  private async callParse<T>(client: Anthropic, model: string, req: ModelJsonRequest<T>) {
    try {
      return await client.messages.parse({
        model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        output_config: { format: zodOutputFormat(req.schema) },
      });
    } catch (error) {
      throw mapSdkError(error);
    }
  }
}

/**
 * Maps SDK exceptions to {@link ProviderError}. The SDK already retries
 * transient failures (network errors, 408/409/429/5xx) twice internally, so
 * we only classify retryability here — we never add our own retry loop.
 */
function mapSdkError(error: unknown): ProviderError {
  if (error instanceof Anthropic.RateLimitError) {
    return new ProviderError(`Anthropic rate limited: ${error.message}`, true, error);
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    const retryable = status >= 500;
    return new ProviderError(`Anthropic API error (status ${status}): ${error.message}`, retryable, error);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(`Anthropic call failed: ${message}`, false, error);
}
