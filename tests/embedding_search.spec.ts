import { describe, expect, it, beforeAll } from "vitest";
import "dotenv/config";
import { embedTaskFields, cosineSimilarity } from "../src/rag/embedding";
import { searchByVector } from "../src/rag/retrieval";
import {
  upsertTaskSnapshot,
  upsertTaskVector,
  readAllTaskVectors,
  readTaskVector,
  sqliteHealth
} from "../src/task_agent/util/sqlite";
import type { TaskDocument } from "../src/task_agent/util/schema";

// Two tasks with different themes for similarity testing
const taskA: TaskDocument = {
  frontmatter: {
    task_id: "T-EMB-HIKING-1",
    status: "Searching",
    interaction_type: "offline",
    current_partner_id: null,
    entered_status_at: "2026-03-06T10:00:00.000Z",
    created_at: "2026-03-06T10:00:00.000Z",
    updated_at: "2026-03-06T10:00:00.000Z",
    version: 1,
    pending_sync: false,
    hidden: false
  },
  body: {
    rawDescription: "周末想去爬山，找个喜欢户外运动的朋友一起，最好有登山经验",
    targetActivity: "周末登山徒步",
    targetVibe: "热爱自然、积极向上",
    detailedPlan: ""
  }
};

const taskB: TaskDocument = {
  frontmatter: {
    task_id: "T-EMB-CAFE-2",
    status: "Searching",
    interaction_type: "offline",
    current_partner_id: null,
    entered_status_at: "2026-03-06T10:00:00.000Z",
    created_at: "2026-03-06T10:00:00.000Z",
    updated_at: "2026-03-06T10:00:00.000Z",
    version: 1,
    pending_sync: false,
    hidden: false
  },
  body: {
    rawDescription: "想找人一起去咖啡馆聊天，喜欢安静的环境讨论书籍和电影",
    targetActivity: "咖啡馆读书交流",
    targetVibe: "安静文艺、深度交流",
    detailedPlan: ""
  }
};

describe("embedding + sqlite vector search (end-to-end)", () => {
  let embA: Awaited<ReturnType<typeof embedTaskFields>>;
  let embB: Awaited<ReturnType<typeof embedTaskFields>>;

  beforeAll(async () => {
    // Step 1: Store both tasks into SQLite (frontmatter + body + index)
    upsertTaskSnapshot(taskA, ".data/task_agents/task_t_emb_hiking_1/task.md");
    upsertTaskSnapshot(taskB, ".data/task_agents/task_t_emb_cafe_2/task.md");

    // Step 2: Call DashScope API to embed all fields
    embA = await embedTaskFields(
      taskA.frontmatter.task_id,
      taskA.body.targetActivity,
      taskA.body.targetVibe,
      taskA.body.rawDescription
    );
    embB = await embedTaskFields(
      taskB.frontmatter.task_id,
      taskB.body.targetActivity,
      taskB.body.targetVibe,
      taskB.body.rawDescription
    );

    // Step 3: Store vectors into per-task vector tables
    for (const emb of embA.embeddings) {
      upsertTaskVector(taskA.frontmatter.task_id, emb.field, emb.text, emb.vector);
    }
    for (const emb of embB.embeddings) {
      upsertTaskVector(taskB.frontmatter.task_id, emb.field, emb.text, emb.vector);
    }
  }, 30_000); // 30s timeout for API calls

  it("SQLite health shows 2 tasks", () => {
    const health = sqliteHealth();
    expect(health.taskCount).toBeGreaterThanOrEqual(2);
  });

  it("vectors are stored and readable for task A", () => {
    const vectors = readAllTaskVectors(taskA.frontmatter.task_id);
    expect(vectors).toHaveLength(3);

    const fields = vectors.map((v) => v.field).sort();
    expect(fields).toEqual(["rawDescription", "targetActivity", "targetVibe"]);

    for (const v of vectors) {
      expect(v.dimensions).toBeGreaterThan(0);
      expect(v.vector.length).toBe(v.dimensions);
      expect(v.source_text.length).toBeGreaterThan(0);
      expect(v.model).toBe("text-embedding-v4");
    }
  });

  it("single field vector is readable with traceability", () => {
    const rec = readTaskVector(taskB.frontmatter.task_id, "targetActivity");
    expect(rec).not.toBeNull();
    expect(rec!.source_text).toBe("咖啡馆读书交流");
    expect(rec!.field).toBe("targetActivity");
    expect(rec!.vector.length).toBeGreaterThan(0);
  });

  it("same-task self-similarity is ~1.0", () => {
    const vecA = readTaskVector(taskA.frontmatter.task_id, "targetActivity");
    expect(vecA).not.toBeNull();
    const selfSim = cosineSimilarity(vecA!.vector, vecA!.vector);
    expect(selfSim).toBeCloseTo(1.0, 4);
  });

  it("cross-task similarity is positive but < 1.0", () => {
    const vecA = readTaskVector(taskA.frontmatter.task_id, "targetActivity");
    const vecB = readTaskVector(taskB.frontmatter.task_id, "targetActivity");
    expect(vecA).not.toBeNull();
    expect(vecB).not.toBeNull();

    const crossSim = cosineSimilarity(vecA!.vector, vecB!.vector);
    console.log(`[targetActivity] hiking vs cafe similarity: ${crossSim.toFixed(4)}`);
    expect(crossSim).toBeGreaterThan(0);
    expect(crossSim).toBeLessThan(1.0);
  });

  it("same-field vectors are more similar within theme", () => {
    // Vibe: "热爱自然、积极向上" vs "安静文艺、深度交流" — should be fairly different
    const vibeA = readTaskVector(taskA.frontmatter.task_id, "targetVibe");
    const vibeB = readTaskVector(taskB.frontmatter.task_id, "targetVibe");

    const vibeSim = cosineSimilarity(vibeA!.vector, vibeB!.vector);
    console.log(`[targetVibe] hiking vs cafe similarity: ${vibeSim.toFixed(4)}`);
    expect(vibeSim).toBeLessThan(0.95); // different vibes should not be near-identical
  });

  it("searchByVector returns task B when querying with hiking-like vectors", () => {
    // Use task A's vectors as query, should find task B (the only other Searching task)
    const actVec = readTaskVector(taskA.frontmatter.task_id, "targetActivity");
    const vibeVec = readTaskVector(taskA.frontmatter.task_id, "targetVibe");
    const descVec = readTaskVector(taskA.frontmatter.task_id, "rawDescription");

    const results = searchByVector({
      sourceTaskId: taskA.frontmatter.task_id,
      queryVectors: {
        targetActivity: actVec!.vector,
        targetVibe: vibeVec!.vector,
        rawDescription: descVec!.vector
      },
      topK: 5
    });

    expect(results).toHaveLength(1); // only task B is a candidate
    expect(results[0].taskId).toBe(taskB.frontmatter.task_id);
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].fieldScores.targetActivity).not.toBeNull();
    expect(results[0].fieldScores.targetVibe).not.toBeNull();
    expect(results[0].fieldScores.rawDescription).not.toBeNull();

    console.log(`[searchByVector] query=hiking -> result:`, {
      taskId: results[0].taskId,
      score: results[0].score.toFixed(4),
      targetActivity: results[0].fieldScores.targetActivity?.toFixed(4),
      targetVibe: results[0].fieldScores.targetVibe?.toFixed(4),
      rawDescription: results[0].fieldScores.rawDescription?.toFixed(4)
    });
  });
});
