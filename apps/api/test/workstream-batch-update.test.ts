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

function environment(targets: string[], failBatchOnce?: number) {
  const batchUpdateTargets = vi.fn(async () => ({ items: targets, noteIds: [] }));
  const dispatched = new Set<string>();
  const beginWorkstreamBatchDispatch = vi.fn(async () => ({
    items: targets.filter((target) => !dispatched.has(target)),
    targetCount: targets.length,
  }));
  const advanceWorkstreamBatchDispatch = vi.fn(async (input: { workstreamIds: string[] }) => {
    input.workstreamIds.forEach((target) => dispatched.add(target));
    return { remainingCount: targets.length - dispatched.size };
  });
  const sent: Array<Array<{ body: unknown }>> = [];
  let batchAttempt = 0;
  const workspaceNamespace = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => ({
      advanceWorkstreamBatchDispatch,
      batchUpdateTargets,
      beginWorkstreamBatchDispatch,
    }),
  });
  const env = createTestEnv({
    APP_ENV: "test",
    AVALON_REGION: "global",
    WORKSPACE_DOS: workspaceNamespace,
    ACTIVITY_QUEUE: createCloudflareTestBinding<Queue>({
      sendBatch: async (messages: Array<{ body: unknown }>) => {
        const attempt = batchAttempt;
        batchAttempt += 1;
        if (attempt === failBatchOnce) throw new Error("queue_chunk_failed");
        sent.push(messages);
      },
    }),
  });
  return {
    advanceWorkstreamBatchDispatch,
    batchUpdateTargets,
    beginWorkstreamBatchDispatch,
    env,
    sent,
  };
}

describe("generic work-stream batch updates", () => {
  it("resolves the filter once and sends one Queue event per work stream", async () => {
    const targets = Array.from({ length: 205 }, (_, index) => workstreamId(index + 1));
    const { beginWorkstreamBatchDispatch, env, sent } = environment(targets);
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
    })).resolves.toEqual({
      operationId: OPERATION_ID,
      enqueuedCount: 205,
      archivedNoteCount: 0,
    });

    expect(beginWorkstreamBatchDispatch).toHaveBeenCalledOnce();
    expect(beginWorkstreamBatchDispatch).toHaveBeenCalledWith(expect.objectContaining({
      operationId: OPERATION_ID,
      filter,
      update: { kind: "mark_read" },
    }));
    expect(sent.map((batch) => batch.length)).toEqual([50, 50, 50, 50, 5]);
    const events = sent.flatMap((batch) => batch.map((message) =>
      WorkstreamBatchUpdateQueueMessageSchema.parse(message.body)));
    expect(events).toHaveLength(targets.length);
    expect(events.map((event) => event.workstreamId)).toEqual(targets);
    expect(new Set(events.map((event) => event.operationId))).toEqual(new Set([OPERATION_ID]));
    expect(events.every((event) => event.update.kind === "mark_read")).toBe(true);
  });

  it("resumes only undispatched Queue chunks after a partial publication failure", async () => {
    const targets = Array.from({ length: 205 }, (_, index) => workstreamId(index + 1));
    const { beginWorkstreamBatchDispatch, env, sent } = environment(targets, 1);
    const request = {
      operationId: OPERATION_ID,
      filter: { pinned: false, includeSystem: false },
      update: { kind: "mark_read" as const },
    };
    const service = new WorkstreamBatchUpdateService(env, auth);

    await expect(service.enqueue(request)).rejects.toThrow("queue_chunk_failed");
    await expect(service.enqueue(request)).resolves.toEqual({
      operationId: OPERATION_ID,
      enqueuedCount: 205,
      archivedNoteCount: 0,
    });

    expect(beginWorkstreamBatchDispatch).toHaveBeenCalledTimes(2);
    const accepted = sent.flatMap((batch) => batch.map((message) =>
      WorkstreamBatchUpdateQueueMessageSchema.parse(message.body).workstreamId));
    expect(accepted).toHaveLength(targets.length);
    expect(new Set(accepted)).toEqual(new Set(targets));
  });

  it("previews through the same generic filter without enqueueing", async () => {
    const { batchUpdateTargets, env, sent } = environment(
      [workstreamId(1), workstreamId(2)],
    );
    const filter = { pinned: false, includeSystem: false };

    await expect(new WorkstreamBatchUpdateService(env, auth).preview(filter))
      .resolves.toEqual({ matchedCount: 2, matchedNoteCount: 0 });

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
