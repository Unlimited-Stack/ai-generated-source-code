import { describe, expect, it } from "vitest";
import { HandshakeInboundEnvelopeSchema, HandshakeOutboundEnvelopeSchema } from "../src/task_agent/util/schema";

describe("schema", () => {
  it("valid inbound handshake passes schema", () => {
    const result = HandshakeInboundEnvelopeSchema.safeParse({
      protocol_version: "1.0",
      message_id: "msg_1",
      sender_agent_id: "agentA",
      receiver_agent_id: "agentB",
      task_id: "T-1",
      action: "PROPOSE",
      round: 1,
      payload: {
        interaction_type: "online",
        target_activity: "hiking",
        target_vibe: "relaxed"
      },
      timestamp: "2026-03-03T10:00:00.000Z",
      signature: "base64-signature"
    });

    expect(result.success).toBe(true);
  });

  it("invalid outbound handshake fails schema", () => {
    const result = HandshakeOutboundEnvelopeSchema.safeParse({
      protocol_version: "1.0",
      message_id: "resp_1",
      in_reply_to: "msg_1",
      task_id: "T-1",
      action: "ACCEPT",
      error: {
        code: "",
        message: ""
      },
      timestamp: "2026-03-03T10:00:00.000Z"
    });

    expect(result.success).toBe(false);
  });
});
