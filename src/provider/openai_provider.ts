import OpenAI from "openai";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  LLMProvider,
  ProviderConfig,
  TokenUsage
} from "./types";

/**
 * OpenAI provider adapter.
 * Supports GPT-4o, GPT-4o-mini, etc.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = "openai" as const;
  readonly defaultModel: string;
  private client: OpenAI;
  private timeoutMs: number;

  constructor(config: ProviderConfig) {
    const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

    this.defaultModel = config.defaultModel;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.client = new OpenAI({
      apiKey,
      baseURL: config.baseURL,
      timeout: this.timeoutMs
    });
  }

  async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const model = request.model ?? this.defaultModel;
    const start = Date.now();

    const response = await this.client.chat.completions.create({
      model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens,
      stop: request.stop
    });

    const latencyMs = Date.now() - start;
    const choice = response.choices[0];
    const usage: TokenUsage = {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0
    };

    return {
      content: choice?.message?.content ?? "",
      finishReason: mapFinishReason(choice?.finish_reason),
      usage,
      model: response.model,
      latencyMs
    };
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  countMessageTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += 4; // OpenAI message overhead: <role>, content, separators
      total += estimateTokens(msg.content);
    }
    total += 2; // priming tokens
    return total;
  }
}

function mapFinishReason(reason: string | null | undefined): ChatCompletionResponse["finishReason"] {
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  return "unknown";
}

/**
 * Approximate token count: ~4 chars per token for English, ~2 chars per token for CJK.
 * This is a fast heuristic; use tiktoken for exact counts if needed.
 */
function estimateTokens(text: string): number {
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
