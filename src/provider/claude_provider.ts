import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  LLMProvider,
  ProviderConfig,
  TokenUsage
} from "./types";

/**
 * Anthropic Claude provider adapter.
 * Uses the Messages API (not the legacy Completion API).
 * Communicates via raw fetch to avoid requiring @anthropic-ai/sdk dependency.
 */
export class ClaudeProvider implements LLMProvider {
  readonly name = "claude" as const;
  readonly defaultModel: string;
  private apiKey: string;
  private baseURL: string;
  private timeoutMs: number;

  constructor(config: ProviderConfig) {
    const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

    this.apiKey = apiKey;
    this.defaultModel = config.defaultModel;
    this.baseURL = config.baseURL ?? "https://api.anthropic.com";
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const model = request.model ?? this.defaultModel;
    const start = Date.now();

    // Claude Messages API: system is a top-level field, not a message
    let systemPrompt: string | undefined;
    const messages: { role: "user" | "assistant"; content: string }[] = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        systemPrompt = msg.content;
      } else {
        messages.push({ role: msg.role as "user" | "assistant", content: msg.content });
      }
    }

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7
    };
    if (systemPrompt) body.system = systemPrompt;
    if (request.stop) body.stop_sequences = request.stop;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseURL}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Claude API ${res.status}: ${errText}`);
      }

      const data = (await res.json()) as ClaudeMessagesResponse;
      const latencyMs = Date.now() - start;

      const content = data.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");

      const usage: TokenUsage = {
        promptTokens: data.usage?.input_tokens ?? 0,
        completionTokens: data.usage?.output_tokens ?? 0,
        totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0)
      };

      return {
        content,
        finishReason: data.stop_reason === "end_turn" ? "stop" : data.stop_reason === "max_tokens" ? "length" : "unknown",
        usage,
        model: data.model,
        latencyMs
      };
    } finally {
      clearTimeout(timer);
    }
  }

  countTokens(text: string): number {
    return estimateTokensCJK(text);
  }

  countMessageTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += 3; // Claude message overhead
      total += estimateTokensCJK(msg.content);
    }
    return total;
  }
}

// Claude Messages API response shape
interface ClaudeMessagesResponse {
  model: string;
  content: { type: string; text: string }[];
  stop_reason: string | null;
  usage?: { input_tokens: number; output_tokens: number };
}

function estimateTokensCJK(text: string): number {
  let cjkCount = 0;
  let otherCount = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x4e00 && code <= 0x9fff || code >= 0x3000 && code <= 0x30ff) {
      cjkCount++;
    } else {
      otherCount++;
    }
  }
  return Math.ceil(cjkCount / 1.5) + Math.ceil(otherCount / 4);
}
