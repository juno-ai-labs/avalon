import { describe, expect, it } from "vitest";

import type { WorkspaceConnectorEvent } from "../src/durable-objects/workspace-connector-event-protocol";
import {
  workspaceConnectorEventContentFingerprint,
  workspaceConnectorEventPayloadHash,
} from "../src/services/workspace-connector-event-ingress";

const stored: WorkspaceConnectorEvent = {
  connectorType: "google",
  activity: {
    id: "00000000-0000-7000-8000-0000000000a1",
    workspaceId: "00000000-0000-7000-8000-0000000000a2",
    region: "global",
    connectionId: "00000000-0000-7000-8000-0000000000a3",
    connectionScope: "personal",
    connectionOwnerUserId: "00000000-0000-7000-8000-0000000000a4",
    provider: "google",
    providerEventId: "gmail:105:added:message-1",
    eventType: "email.received",
    resourceType: "gmail_thread",
    providerResourceId: "thread-1",
    actor: { from: "buyer@example.com" },
    subject: { messageId: "message-1", threadId: "thread-1", subject: "Pilot pricing" },
    occurredAt: "2026-11-19T12:00:00.000Z",
    receivedAt: "2026-11-19T12:00:01.000Z",
    title: "New email: Pilot pricing",
    summary: "From buyer@example.com",
    textSnippet: "Can we talk numbers?",
    payloadRef: null,
    visibility: { scope: "personal" },
    targetUserIds: [],
    entityKeys: ["google:gmail:thread:thread-1", "google:gmail:message:message-1"],
    dedupeKey: "gmail:105:added:message-1",
    rawContentHash: null,
    metadata: { changeType: "added" },
  },
};

describe("a connector event's identity across the release that names its item", () => {
  it("hashes an event stored before its adapter named the item as the same event delivered again with it", async () => {
    const redelivered = { ...stored, activity: { ...stored.activity, item: { type: "gmail_message", id: "message-1" } } };

    expect(await workspaceConnectorEventPayloadHash(redelivered)).toBe(await workspaceConnectorEventPayloadHash(stored));
    expect(await workspaceConnectorEventContentFingerprint(redelivered)).toBe(await workspaceConnectorEventContentFingerprint(stored));
  });

  it("still tells two events apart by what they say", async () => {
    const other = { ...stored, activity: { ...stored.activity, textSnippet: "Different words" } };

    expect(await workspaceConnectorEventPayloadHash(other)).not.toBe(await workspaceConnectorEventPayloadHash(stored));
  });
});
