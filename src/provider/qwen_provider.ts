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
 * Qwen (通义千问) provider adapter via DashScope OpenAI-compatible API.
 * Supports qwen-plus, qwen-turbo, qwen-max, etc.
 */
export class QwenProvider implements LLMProvider {
  readonly name = "qwen" as const;
  readonly defaultModel: string;
  private client: OpenAI;
  private timeoutMs: number;

  constructor(config: ProviderConfig) {
    const apiKey = config.apiKey || process.env.QWEN_API_KEY;
    if (!apiKey) throw new Error("QWEN_API_KEY is not set");

    this.defaultModel = config.defaultModel;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.client = new OpenAI({
      apiKey,
      baseURL: config.baseURL ?? "https://coding.dashscope.aliyuncs.com/v1",
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
    return estimateTokensCJK(text);
  }

  countMessageTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += 4;
      total += estimateTokensCJK(msg.content);
    }
    total += 2;
    return total;
  }
}

function mapFinishReason(reason: string | null | undefined): ChatCompletionResponse["finishReason"] {
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  return "unknown";
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
