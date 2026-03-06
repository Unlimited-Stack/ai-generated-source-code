import { describe, expect, it } from "vitest";
import { saveTaskMD, transitionTaskStatus } from "../src/task_agent/util/storage";

describe("state machine", () => {
  it("allows Drafting -> Searching", async () => {
    const taskId = "T-PHASE5-STATE-1";
    await saveTaskMD({
      frontmatter: {
        task_id: taskId,
        status: "Drafting",
        hidden: false,
        interaction_type: "online",
        current_partner_id: null,
        entered_status_at: "2026-03-03T10:00:00.000Z",
        created_at: "2026-03-03T10:00:00.000Z",
        updated_at: "2026-03-03T10:00:00.000Z",
        version: 1,
        pending_sync: false
      },
      body: {
        rawDescription: "raw",
        targetActivity: "hiking",
        targetVibe: "relaxed"
      }
    });

    const result = await transitionTaskStatus(taskId, "Searching");
    expect(result.previousStatus).toBe("Drafting");
    expect(result.nextStatus).toBe("Searching");
  });

  it("rejects Searching -> Drafting", async () => {
    const taskId = "T-PHASE5-STATE-2";
    await saveTaskMD({
      frontmatter: {
        task_id: taskId,
        status: "Searching",
        hidden: false,
        interaction_type: "online",
        current_partner_id: null,
        entered_status_at: "2026-03-03T10:00:00.000Z",
        created_at: "2026-03-03T10:00:00.000Z",
        updated_at: "2026-03-03T10:00:00.000Z",
        version: 1,
        pending_sync: false
      },
      body: {
        rawDescription: "raw",
        targetActivity: "hiking",
        targetVibe: "relaxed"
      }
    });

    await expect(transitionTaskStatus(taskId, "Drafting")).rejects.toThrow("E_INVALID_TRANSITION");
  });
});
