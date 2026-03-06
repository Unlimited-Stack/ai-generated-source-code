import { describe, expect, it } from "vitest";
import { findIdempotencyRecord, saveIdempotencyRecord } from "../src/task_agent/util/storage";
import type { HandshakeInboundEnvelope, HandshakeOutboundEnvelope } from "../src/task_agent/util/schema";

describe("idempotency", () => {
  it("stores and replays first response for same key", async () => {
    const envelope: HandshakeInboundEnvelope = {
      protocol_version: "1.0",
      message_id: "msg-idempo-1",
      sender_agent_id: "agent-a",
      receiver_agent_id: "agent-b",
      task_id: "T-1",
      action: "PROPOSE",
      round: 1,
      payload: {
        interaction_type: "online",
        target_activity: "hiking",
        target_vibe: "relaxed"
      },
      timestamp: "2026-03-03T10:00:00.000Z",
      signature: "sig"
    };

    const response: HandshakeOutboundEnvelope = {
      protocol_version: "1.0",
      message_id: "resp-idempo-1",
      in_reply_to: envelope.message_id,
      task_id: envelope.task_id,
      action: "ACCEPT",
      error: null,
      timestamp: "2026-03-03T10:00:01.000Z"
    };

    await saveIdempotencyRecord(envelope, response);
    const replay = await findIdempotencyRecord(envelope);

    expect(replay).not.toBeNull();
    expect(replay?.response.message_id).toBe("resp-idempo-1");
  });
});
