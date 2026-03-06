import { OpenAIProvider } from "./openai_provider";
import { ClaudeProvider } from "./claude_provider";
import { QwenProvider } from "./qwen_provider";
import type { LLMProvider, ProviderConfig, ProviderName } from "./types";

export type { LLMProvider, ProviderConfig, ProviderName, ChatMessage, ChatCompletionRequest, ChatCompletionResponse, TokenUsage, Role } from "./types";

// ---------------------------------------------------------------------------
// Provider registry (singleton cache)
// ---------------------------------------------------------------------------

const registry = new Map<string, LLMProvider>();

/**
 * Create or retrieve a cached provider instance.
 * Key is `${provider}:${model}` so you can have multiple configs per provider.
 */
export function getProvider(config: ProviderConfig): LLMProvider {
  const key = `${config.provider}:${config.defaultModel}`;
  const cached = registry.get(key);
  if (cached) return cached;

  const provider = createProvider(config);
  registry.set(key, provider);
  return provider;
}

function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.provider) {
    case "openai":
      return new OpenAIProvider(config);
    case "claude":
      return new ClaudeProvider(config);
    case "qwen":
      return new QwenProvider(config);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

/**
 * Clear the provider registry (useful for tests).
 */
export function clearProviderRegistry(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// Default provider config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ProviderConfig = {
  provider: "qwen",
  defaultModel: "qwen3-max-2026-01-23"
};

/**
 * Get the default provider instance.
 * Change DEFAULT_CONFIG above to switch the whole project's LLM backend.
 */
export function getDefaultProvider(): LLMProvider {
  return getProvider(DEFAULT_CONFIG);
}
