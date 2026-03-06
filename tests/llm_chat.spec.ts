import { describe, expect, it } from "vitest";
import "dotenv/config";
import { chatOnce, Conversation } from "../src/llm/chat";

describe("LLM chat (qwen default provider)", () => {

  it("single-turn: chatOnce returns a response with token usage", async () => {
    const res = await chatOnce("请用一句话介绍你自己", {
      system: "你是一个社交匹配助手",
      temperature: 0.5,
      maxTokens: 100
    });

    console.log("\n=== 单轮对话 ===");
    console.log("回复:", res.content);
    console.log("模型:", res.model);
    console.log("耗时:", res.latencyMs, "ms");
    console.log("Token:", res.usage);
    console.log("结束原因:", res.finishReason);

    expect(res.content.length).toBeGreaterThan(0);
    expect(res.usage.totalTokens).toBeGreaterThan(0);
    expect(res.model).toContain("qwen");
  }, 30_000);

  it("multi-turn: Conversation tracks history and accumulates tokens", async () => {
    const conv = new Conversation({
      system: "你是一个户外活动推荐助手，回答简洁，每次不超过50字",
      temperature: 0.5,
      maxTokens: 100
    });

    console.log("\n=== 多轮对话 ===");

    // Turn 1
    const r1 = await conv.say("我周末想出去玩，有什么推荐？");
    console.log(`\n[Turn 1] 用户: 我周末想出去玩，有什么推荐？`);
    console.log(`[Turn 1] 助手: ${r1.content}`);
    console.log(`[Turn 1] Token: ${JSON.stringify(r1.usage)}`);

    expect(r1.content.length).toBeGreaterThan(0);
    expect(conv.getTurnCount()).toBe(1);

    // Turn 2 (should have context from turn 1)
    const r2 = await conv.say("我比较喜欢爬山，有具体的地方推荐吗？");
    console.log(`\n[Turn 2] 用户: 我比较喜欢爬山，有具体的地方推荐吗？`);
    console.log(`[Turn 2] 助手: ${r2.content}`);
    console.log(`[Turn 2] Token: ${JSON.stringify(r2.usage)}`);

    expect(r2.content.length).toBeGreaterThan(0);
    expect(conv.getTurnCount()).toBe(2);

    // Turn 3
    const r3 = await conv.say("帮我总结一下我们刚才聊了什么");
    console.log(`\n[Turn 3] 用户: 帮我总结一下我们刚才聊了什么`);
    console.log(`[Turn 3] 助手: ${r3.content}`);
    console.log(`[Turn 3] Token: ${JSON.stringify(r3.usage)}`);

    expect(r3.content.length).toBeGreaterThan(0);
    expect(conv.getTurnCount()).toBe(3);

    // Verify cumulative stats
    console.log(`\n--- 统计 ---`);
    console.log(`总轮数: ${conv.getTurnCount()}`);
    console.log(`历史Token估算: ${conv.getHistoryTokenCount()}`);
    console.log(`累计Token: ${JSON.stringify(conv.totalUsage)}`);

    expect(conv.totalUsage.totalTokens).toBeGreaterThan(0);
    expect(conv.getHistory()).toHaveLength(6); // 3 user + 3 assistant
  }, 60_000);
});
