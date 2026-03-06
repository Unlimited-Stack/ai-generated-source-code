import type {
  ChatMessage,
  ChatCompletionResponse,
  LLMProvider,
  TokenUsage
} from "../provider/types";
import { getDefaultProvider } from "../provider/index";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SingleChatOptions {
  /** Pass a provider instance to override the default */
  provider?: LLMProvider;
  /** System prompt */
  system?: string;
  /** Temperature */
  temperature?: number;
  /** Max tokens for response */
  maxTokens?: number;
}

export interface ConversationOptions extends SingleChatOptions {
  /** Max history tokens before auto-trimming older messages */
  maxHistoryTokens?: number;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  usage?: TokenUsage;
  latencyMs?: number;
}

// ---------------------------------------------------------------------------
// Single-turn chat
// ---------------------------------------------------------------------------

/**
 * One-shot LLM call: system + user -> assistant response.
 * Use for task.md generation, summarization, etc.
 */
export async function chatOnce(
  userMessage: string,
  options: SingleChatOptions = {}
): Promise<ChatCompletionResponse> {
  const provider = resolveProvider(options);
  const messages: ChatMessage[] = [];

  if (options.system) {
    messages.push({ role: "system", content: options.system });
  }
  messages.push({ role: "user", content: userMessage });

  return provider.chat({
    messages,
    temperature: options.temperature,
    maxTokens: options.maxTokens
  });
}

// ---------------------------------------------------------------------------
// Multi-turn conversation
// ---------------------------------------------------------------------------

/**
 * Stateful multi-turn conversation manager.
 * Tracks message history, token usage, and auto-trims when exceeding limits.
 */
export class Conversation {
  private provider: LLMProvider;
  private systemPrompt: string | null;
  private history: ConversationTurn[] = [];
  private maxHistoryTokens: number;
  private temperature: number;
  private maxTokens: number | undefined;

  /** Cumulative token usage across all turns */
  totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  constructor(options: ConversationOptions = {}) {
    this.provider = resolveProvider(options);
    this.systemPrompt = options.system ?? null;
    this.maxHistoryTokens = options.maxHistoryTokens ?? 8000;
    this.temperature = options.temperature ?? 0.7;
    this.maxTokens = options.maxTokens;
  }

  /** Send a user message and get assistant response */
  async say(userMessage: string): Promise<ChatCompletionResponse> {
    this.history.push({ role: "user", content: userMessage });
    this.trimHistory();

    const messages = this.buildMessages();
    const response = await this.provider.chat({
      messages,
      temperature: this.temperature,
      maxTokens: this.maxTokens
    });

    this.history.push({
      role: "assistant",
      content: response.content,
      usage: response.usage,
      latencyMs: response.latencyMs
    });

    this.totalUsage.promptTokens += response.usage.promptTokens;
    this.totalUsage.completionTokens += response.usage.completionTokens;
    this.totalUsage.totalTokens += response.usage.totalTokens;

    return response;
  }

  /** Get current message history */
  getHistory(): ConversationTurn[] {
    return [...this.history];
  }

  /** Get current history token estimate */
  getHistoryTokenCount(): number {
    const messages = this.history.map((t) => ({ role: t.role as "user" | "assistant", content: t.content }));
    return this.provider.countMessageTokens(messages);
  }

  /** Get number of turns (user+assistant pairs) */
  getTurnCount(): number {
    return Math.floor(this.history.length / 2);
  }

  /** Reset conversation (keep system prompt, clear history) */
  reset(): void {
    this.history = [];
    this.totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }

  /** Replace system prompt mid-conversation */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /** Export full conversation as ChatMessage array (for saving/logging) */
  exportMessages(): ChatMessage[] {
    return this.buildMessages();
  }

  // -------------------------------------------------------------------------

  private buildMessages(): ChatMessage[] {
    const messages: ChatMessage[] = [];
    if (this.systemPrompt) {
      messages.push({ role: "system", content: this.systemPrompt });
    }
    for (const turn of this.history) {
      messages.push({ role: turn.role, content: turn.content });
    }
    return messages;
  }

  /**
   * Trim oldest turns (keeping pairs) when history exceeds maxHistoryTokens.
   * Always keeps the most recent user message.
   */
  private trimHistory(): void {
    while (this.history.length > 1) {
      const tokenCount = this.getHistoryTokenCount();
      if (tokenCount <= this.maxHistoryTokens) break;

      // Remove oldest pair (user + assistant)
      if (this.history.length >= 2 && this.history[0].role === "user" && this.history[1].role === "assistant") {
        this.history.splice(0, 2);
      } else {
        this.history.shift();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveProvider(options: SingleChatOptions): LLMProvider {
  if (options.provider) return options.provider;
  return getDefaultProvider();
}
