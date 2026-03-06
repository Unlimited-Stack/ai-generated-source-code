// ---------------------------------------------------------------------------
// Unified LLM provider interface
// ---------------------------------------------------------------------------

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatCompletionResponse {
  content: string;
  finishReason: "stop" | "length" | "error" | "unknown";
  usage: TokenUsage;
  model: string;
  latencyMs: number;
}

export interface ProviderConfig {
  /** Provider identifier */
  provider: ProviderName;
  /** API key (reads from env if not provided) */
  apiKey?: string;
  /** Base URL override */
  baseURL?: string;
  /** Default model for this provider */
  defaultModel: string;
  /** Request timeout in ms */
  timeoutMs?: number;
}

export type ProviderName = "openai" | "claude" | "qwen";

/**
 * Unified LLM provider interface.
 * All providers must implement this contract.
 */
export interface LLMProvider {
  readonly name: ProviderName;
  readonly defaultModel: string;

  /** Send a chat completion request */
  chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;

  /**
   * Estimate token count for a string.
   * Uses provider-specific estimation (or approximation for non-tiktoken providers).
   */
  countTokens(text: string): number;

  /**
   * Estimate token count for a message array.
   * Accounts for message formatting overhead per provider.
   */
  countMessageTokens(messages: ChatMessage[]): number;
}
