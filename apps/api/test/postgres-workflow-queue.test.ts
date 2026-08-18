import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as postgresRuntime from "../src/postgres/runtime";
import { createTestEnv } from "./helpers/cloudflare-test";

const mocks = vi.hoisted(() => ({
  client: {
    readQueue: vi.fn(),
    claimQueueInbox: vi.fn(),
    renewQueueMessage: vi.fn(),
    completeQueueInbox: vi.fn(),
    deleteQueueMessage: vi.fn(),
    deadLetterQueueMessage: vi.fn(),
    materializeAttentionMentions: vi.fn(),
    close: vi.fn(),
  },
}));

vi.mock("../src/postgres/runtime", async (importOriginal) => ({
  ...await importOriginal<typeof postgresRuntime>(),
  productDataAuthority: () => "postgres",
  createPostgresClient: () => mocks.client,
}));

const { drainPostgresWorkflowControl } = await import("../src/postgres/workflow-control");

const startMessage = {
  version: 1,
  run_id: "018f4000-0000-7000-8000-000000000001",
  workflow_instance_id: "workstream/one/run/one",
  expected_run_revision: 1,
};

describe("Postgres queue ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.readQueue.mockImplementation(async (queueName: string) => queueName === "workflow_starts"
      ? [{
          messageId: 41,
          readCount: 1,
          enqueuedAt: new Date(0),
          visibleAt: new Date(0),
          message: startMessage,
        }]
      : []);
    mocks.client.completeQueueInbox.mockResolvedValue(true);
    mocks.client.deleteQueueMessage.mockResolvedValue(true);
    mocks.client.deadLetterQueueMessage.mockResolvedValue(true);
    mocks.client.close.mockResolvedValue(undefined);
  });

  it("passes the opaque claim token through completion", async () => {
    mocks.client.claimQueueInbox.mockResolvedValue({
      state: "acquired",
      claimToken: "018f4000-0000-7000-8000-000000000099",
    });
    const create = vi.fn(async () => ({ id: "instance" }));
    const result = await drainPostgresWorkflowControl(createTestEnv({
      AVALON_REGION: "global",
      POSTGRES_AGENT_LOOP_WORKFLOW: { create },
    }));

    expect(result).toEqual({ starts: 1, signals: 0, sidebarAttention: 0 });
    expect(create).toHaveBeenCalledOnce();
    expect(mocks.client.completeQueueInbox).toHaveBeenCalledWith({
      queueName: "workflow_starts",
      semanticKey: startMessage.run_id,
      messageId: 41,
      requestHash: expect.any(Uint8Array),
      claimToken: "018f4000-0000-7000-8000-000000000099",
      resultRef: startMessage.run_id,
    });
    expect(mocks.client.deleteQueueMessage).toHaveBeenCalledWith("workflow_starts", 41);
  });

  it("does not execute or delete a delivery owned by another consumer", async () => {
    mocks.client.claimQueueInbox.mockResolvedValue({ state: "busy" });
    const create = vi.fn(async () => ({ id: "instance" }));
    const result = await drainPostgresWorkflowControl(createTestEnv({
      AVALON_REGION: "global",
      POSTGRES_AGENT_LOOP_WORKFLOW: { create },
    }));

    expect(result).toEqual({ starts: 0, signals: 0, sidebarAttention: 0 });
    expect(create).not.toHaveBeenCalled();
    expect(mocks.client.completeQueueInbox).not.toHaveBeenCalled();
    expect(mocks.client.deleteQueueMessage).not.toHaveBeenCalled();
  });

  it("claims an invalid delivery and fences dead-lettering with its token", async () => {
    const invalidMessage = { version: 1, run_id: "not-a-uuid" };
    mocks.client.readQueue.mockImplementation(async (queueName: string) => queueName === "workflow_starts"
      ? [{
          messageId: 41,
          readCount: 10,
          enqueuedAt: new Date(0),
          visibleAt: new Date(0),
          message: invalidMessage,
        }]
      : []);
    mocks.client.claimQueueInbox.mockResolvedValue({
      state: "acquired",
      claimToken: "018f4000-0000-7000-8000-000000000099",
    });
    const create = vi.fn(async () => ({ id: "instance" }));

    const result = await drainPostgresWorkflowControl(createTestEnv({
      AVALON_REGION: "global",
      POSTGRES_AGENT_LOOP_WORKFLOW: { create },
    }));

    expect(result).toEqual({ starts: 0, signals: 0, sidebarAttention: 0 });
    expect(create).not.toHaveBeenCalled();
    expect(mocks.client.claimQueueInbox).toHaveBeenCalledWith({
      queueName: "workflow_starts",
      semanticKey: "message-41",
      messageId: 41,
      requestHash: expect.any(Uint8Array),
    });
    expect(mocks.client.deadLetterQueueMessage).toHaveBeenCalledWith({
      queueName: "workflow_starts",
      semanticKey: "message-41",
      messageId: 41,
      requestHash: expect.any(Uint8Array),
      claimToken: "018f4000-0000-7000-8000-000000000099",
      message: invalidMessage,
      errorClass: "invalid_queue_message",
      attempts: 10,
    });
  });
});
