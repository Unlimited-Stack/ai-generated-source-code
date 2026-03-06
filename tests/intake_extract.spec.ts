import { describe, expect, it } from "vitest";
import "dotenv/config";
import { chatOnce } from "../src/llm/chat";

const EXTRACT_SYSTEM_PROMPT = `你是一个社交匹配需求分析助手。用户想要找人一起做某件事，你需要从对话中提取结构化信息。

请根据对话历史，提取以下字段并以**纯JSON**格式输出（不要输出任何其他内容）：

{
  "interaction_type": "online" | "offline" | "any",
  "rawDescription": "用户核心需求的精炼描述，≤50字",
  "targetActivity": "具体活动内容，≤50字",
  "targetVibe": "期望的氛围/对方特质，≤50字",
  "detailedPlan": "完整的需求详情，markdown格式",
  "complete": true/false,
  "followUpQuestion": "如果complete=false，给出一个自然的追问；如果complete=true则为null"
}

判断complete的标准：
- interaction_type 能判断出来 → 必须
- 具体想做什么活动能明确 → 必须
- 以上两项明确即为complete=true

只输出JSON，不要任何解释文字`;

describe("intake extraction via LLM", () => {

  it("extracts complete info from a detailed query", async () => {
    const userInput = "用户: 周末想找人一起去奥森公园跑步，线下的，希望对方也是跑步爱好者，节奏差不多就行";

    const res = await chatOnce(userInput, {
      system: EXTRACT_SYSTEM_PROMPT,
      temperature: 0.3,
      maxTokens: 800
    });

    let text = res.content.trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    const parsed = JSON.parse(text);

    console.log("\n=== 详细查询提取 ===");
    console.log(JSON.stringify(parsed, null, 2));

    expect(parsed.complete).toBe(true);
    expect(parsed.interaction_type).toBe("offline");
    expect(parsed.rawDescription.length).toBeLessThanOrEqual(50);
    expect(parsed.targetActivity.length).toBeLessThanOrEqual(50);
    expect(parsed.targetVibe.length).toBeLessThanOrEqual(50);
    expect(parsed.detailedPlan.length).toBeGreaterThan(0);
    expect(parsed.followUpQuestion).toBeNull();
  }, 30_000);

  it("asks follow-up for a vague query", async () => {
    const userInput = "用户: 好无聊啊想找人玩";

    const res = await chatOnce(userInput, {
      system: EXTRACT_SYSTEM_PROMPT,
      temperature: 0.3,
      maxTokens: 800
    });

    let text = res.content.trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    const parsed = JSON.parse(text);

    console.log("\n=== 模糊查询提取 ===");
    console.log(JSON.stringify(parsed, null, 2));

    expect(parsed.complete).toBe(false);
    expect(parsed.followUpQuestion).toBeTruthy();
    console.log("追问:", parsed.followUpQuestion);
  }, 30_000);

  it("re-extracts after user provides more info", async () => {
    const conversation = `用户: 好无聊啊想找人玩
助手: 想玩点什么呢？线上打游戏还是线下出去逛逛？
用户: 线上吧，一起打几把英雄联盟，轻松一点的`;

    const res = await chatOnce(conversation, {
      system: EXTRACT_SYSTEM_PROMPT,
      temperature: 0.3,
      maxTokens: 800
    });

    let text = res.content.trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    const parsed = JSON.parse(text);

    console.log("\n=== 补充后再提取 ===");
    console.log(JSON.stringify(parsed, null, 2));

    expect(parsed.complete).toBe(true);
    expect(parsed.interaction_type).toBe("online");
    expect(parsed.targetActivity).toContain("英雄联盟");
    expect(parsed.followUpQuestion).toBeNull();
  }, 30_000);
});
