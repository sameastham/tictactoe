import type { ModelProvider } from "@/server/language/providers/provider";
import { AnthropicProvider } from "@/server/language/providers/anthropic";
import { FixtureProvider } from "@/server/language/providers/fixture";

let cachedProvider: ModelProvider | undefined;

function selectProvider(): ModelProvider {
  const requested = process.env.MODEL_PROVIDER;
  if (requested === "fixture") return new FixtureProvider();
  if (requested === "anthropic") return new AnthropicProvider();
  // Unset: prefer the real provider when a key is configured, else fall
  // back to the deterministic fixture so local dev/tests don't need one.
  return process.env.ANTHROPIC_API_KEY ? new AnthropicProvider() : new FixtureProvider();
}

/** Returns the process-wide {@link ModelProvider}, selected once and cached. */
export function getProvider(): ModelProvider {
  if (!cachedProvider) {
    cachedProvider = selectProvider();
  }
  return cachedProvider;
}
