import type { z } from "zod";

/** Token accounting for a single model call, normalized across providers. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** A request for a single structured-JSON model call. */
export interface ModelJsonRequest<T> {
  purpose: "extract" | "judge" | "converse";
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens: number;
}

/** The result of a structured-JSON model call. */
export interface ModelJsonResponse<T> {
  data: T;
  model: string;
  usage: ModelUsage;
}

/**
 * A model provider capable of producing schema-validated JSON output.
 * `LanguageService` is the only consumer of this interface — every model
 * call in the app goes through a `ModelProvider`.
 */
export interface ModelProvider {
  readonly name: string;
  completeJson<T>(req: ModelJsonRequest<T>): Promise<ModelJsonResponse<T>>;
}

/** Raised by a `ModelProvider` when a call fails. `retryable` tells callers whether retrying makes sense. */
export class ProviderError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ProviderError";
    this.retryable = retryable;
  }
}
