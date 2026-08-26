import { asUserId, asWorkspaceId } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import {
  WorkstreamBatchUpdateQueueMessageSchema,
  WorkstreamBatchUpdateService,
  consumeWorkstreamBatchUpdate,
} from "../src/services/workstream-batch-update";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000101");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000102");
const OPERATION_ID = "00000000-0000-7000-8000-000000000103";

const auth: AuthContext = {
  sessionId: "session-1",
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  region: "global",
  role: "member",
};

function workstreamId(index: number): string {
  return `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`;
}

function environment(targets: string[]) {
  const batchUpdateTargets = vi.fn(async () => ({ items: targets }));
  const sent: Array<Array<{ body: unknown }>> = [];
  const workspaceNamespace = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => ({ batchUpdateTargets }),
  });
  const env = createTestEnv({
    APP_ENV: "test",
    AVALON_REGION: "global",
    WORKSPACE_DOS: workspaceNamespace,
    ACTIVITY_QUEUE: createCloudflareTestBinding<Queue>({
      sendBatch: async (messages: Array<{ body: unknown }>) => { sent.push(messages); },
    }),
  });
  return { batchUpdateTargets, env, sent };
}

describe("generic work-stream batch updates", () => {
  it("resolves the filter once and sends one Queue event per work stream", async () => {
    const targets = Array.from({ length: 205 }, (_, index) => workstreamId(index + 1));
    const { batchUpdateTargets, env, sent } = environment(targets);
    const filter = {
      lastActivityAt: {
        atOrAfter: "2026-08-01T00:00:00.000Z",
        before: "2026-08-08T00:00:00.000Z",
      },
      pinned: false,
      includeSystem: false,
    } as const;

    await expect(new WorkstreamBatchUpdateService(env, auth).enqueue({
      operationId: OPERATION_ID,
      filter,
      update: { kind: "mark_read" },
    })).resolves.toEqual({ operationId: OPERATION_ID, enqueuedCount: 205 });

    expect(batchUpdateTargets).toHaveBeenCalledOnce();
    expect(batchUpdateTargets).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      filter,
    });
    expect(sent.map((batch) => batch.length)).toEqual([100, 100, 5]);
    const events = sent.flatMap((batch) => batch.map((message) =>
      WorkstreamBatchUpdateQueueMessageSchema.parse(message.body)));
    expect(events).toHaveLength(targets.length);
    expect(events.map((event) => event.workstreamId)).toEqual(targets);
    expect(new Set(events.map((event) => event.operationId))).toEqual(new Set([OPERATION_ID]));
    expect(events.every((event) => event.update.kind === "mark_read")).toBe(true);
  });

  it("previews through the same generic filter without enqueueing", async () => {
    const { batchUpdateTargets, env, sent } = environment([workstreamId(1), workstreamId(2)]);
    const filter = { pinned: false, includeSystem: false };

    await expect(new WorkstreamBatchUpdateService(env, auth).preview(filter))
      .resolves.toEqual({ matchedCount: 2 });

    expect(batchUpdateTargets).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      filter,
    });
    expect(sent).toEqual([]);
  });

  it("delivers one queued event to the named authority and acknowledges it", async () => {
    const applyQueuedBatchUpdate = vi.fn(async () => ({ outcome: "applied", reason: null }));
    const substreams = createCloudflareTestBinding<Env["SUBSTREAM_AGENTS"]>({
      idFromName: (name: string) => createTestDurableObjectId(name),
      get: () => ({ applyQueuedBatchUpdate }),
    });
    const env = createTestEnv({
      APP_ENV: "test",
      AVALON_REGION: "global",
      SUBSTREAM_AGENTS: substreams,
    });
    const body = WorkstreamBatchUpdateQueueMessageSchema.parse({
      kind: "workstream_batch_update",
      region: "global",
      operationId: OPERATION_ID,
      requestHash: "fnv1a64:1111111111111111",
      workspaceId: WORKSPACE_ID,
      workstreamId: workstreamId(1),
      userId: USER_ID,
      update: { kind: "archive" },
    });
    const ack = vi.fn();
    const message = {
      id: "queue-message-1",
      timestamp: new Date("2026-08-26T12:00:00.000Z"),
      body,
      attempts: 1,
      ack,
      retry: vi.fn(),
    } satisfies Message<unknown>;

    await expect(consumeWorkstreamBatchUpdate(message, env)).resolves.toBe(true);

    expect(applyQueuedBatchUpdate).toHaveBeenCalledWith(body);
    expect(ack).toHaveBeenCalledOnce();
  });
});
