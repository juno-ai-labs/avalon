import { describe, expect, it } from "vitest";

import { SidelineSendRequestSchema } from "@rally/contracts";
import { sidelineHttpSend, sidelineHttpSendResponse } from "./send-request";

const currentUserId = "00000000-0000-7000-8000-00000000d001";
const input = SidelineSendRequestSchema.parse({
  representedUserId: currentUserId,
  workstreamId: "00000000-0000-7000-8000-00000000d002",
  substreamId: "0",
  message: "Current-user message",
  idempotencyKey: "00000000-0000-7000-8000-00000000d003",
  app: { name: "Sideline", version: "0.2.0", authMechanism: "rally_session" },
});

describe("Sideline HTTP message routing", () => {
  it("uses the ordinary conversation API for the signed-in user", () => {
    expect(sidelineHttpSend(currentUserId, input)).toEqual({
      kind: "self",
      path: `/conversations/${input.workstreamId}/substreams/0/messages`,
      operationId: input.idempotencyKey,
      body: {
        text: input.message,
        clientMessageId: input.idempotencyKey,
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      },
    });
  });

  it("keeps represented sends on the audited impersonation API", () => {
    const represented = SidelineSendRequestSchema.parse({
      ...input,
      representedUserId: "00000000-0000-7000-8000-00000000d004",
    });
    expect(sidelineHttpSend(currentUserId, represented)).toEqual({
      kind: "represented",
      path: "/sideline/messages",
      body: represented,
    });
  });

  it("adapts the ordinary admission receipt to Sideline's card result", () => {
    expect(sidelineHttpSendResponse("self", {
      turn: {
        turnId: "00000000-0000-7000-8000-00000000d005",
        clientMessageId: input.idempotencyKey,
        createdAt: "2026-09-22T12:00:00.000Z",
      },
      deliveryState: "pending",
    })).toEqual({
      messageId: "00000000-0000-7000-8000-00000000d005",
      createdAt: "2026-09-22T12:00:00.000Z",
    });
  });
});
