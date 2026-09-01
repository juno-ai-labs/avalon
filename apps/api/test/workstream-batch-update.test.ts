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

function environment(targets: string[], failBatchOnce?: number, noteIds: string[] = []) {
  const batchUpdateTargets = vi.fn(async () => ({ items: targets, noteIds }));
  const dispatched = new Set<string>();
  const beginWorkstreamBatchDispatch = vi.fn(async () => ({
    items: targets.filter((target) => !dispatched.has(target)),
    targetCount: targets.length,
  }));
  // The object's own receipt, stood in for here: the first call archives, and
  // every later call for the same operation answers with the count it wrote.
  let archivedNotes: number | null = null;
  const archiveNotesForBatch = vi.fn(async () => {
    const replayed = archivedNotes !== null;
    archivedNotes ??= noteIds.length;
    return { archivedNoteCount: archivedNotes, replayed };
  });
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
      archiveNotesForBatch,
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
    archiveNotesForBatch,
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
      undefined,
      [workstreamId(80), workstreamId(81), workstreamId(82)],
    );
    const filter = { pinned: false, includeSystem: false };

    // Counted apart, because the confirmation names them apart and only one of
    // the two update kinds reaches the notes at all.
    await expect(new WorkstreamBatchUpdateService(env, auth).preview(filter))
      .resolves.toEqual({ matchedCount: 2, matchedNoteCount: 3 });

    expect(batchUpdateTargets).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      filter,
    });
    expect(sent).toEqual([]);
  });

  it("archives the grouping's notes here rather than giving them Queue events", async () => {
    // The product defect this closes: **Archive all** on a recency heading
    // emptied the work streams under it and left the notes sitting there, so
    // the group the reader had just cleared came back half full.
    const targets = [workstreamId(1), workstreamId(2)];
    const { archiveNotesForBatch, env, sent } = environment(targets, undefined, [
      workstreamId(90),
      workstreamId(91),
    ]);
    const filter = { pinned: false, includeSystem: false } as const;

    await expect(new WorkstreamBatchUpdateService(env, auth).enqueue({
      operationId: OPERATION_ID,
      filter,
      update: { kind: "archive" },
    })).resolves.toEqual({
      operationId: OPERATION_ID,
      enqueuedCount: 2,
      archivedNoteCount: 2,
    });

    expect(archiveNotesForBatch).toHaveBeenCalledOnce();
    expect(archiveNotesForBatch).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      operationId: OPERATION_ID,
      filter,
      // The work-stream half's own fence, so a second filter cannot reuse this
      // operation id to archive a different set of notes under its receipt.
      requestHash: expect.stringMatching(/^fnv1a64:[0-9a-f]{16}$/u),
    }));
    // Nothing but work streams travels: a note has no object for an event to
    // reach, so one would be delivered to a SubstreamAgent that is not there.
    const events = sent.flatMap((batch) => batch.map((message) =>
      WorkstreamBatchUpdateQueueMessageSchema.parse(message.body)));
    expect(events.map((event) => event.workstreamId)).toEqual(targets);
  });

  it("leaves notes alone when the grouping is only being marked as read", async () => {
    // A note has no read state to clear, so `mark_read` must not reach one —
    // and the object must not be asked to write a receipt for work that has no
    // meaning here.
    const { archiveNotesForBatch, env } = environment([workstreamId(1)], undefined, [
      workstreamId(90),
    ]);

    await expect(new WorkstreamBatchUpdateService(env, auth).enqueue({
      operationId: OPERATION_ID,
      filter: { pinned: false, includeSystem: false },
      update: { kind: "mark_read" },
    })).resolves.toEqual({
      operationId: OPERATION_ID,
      enqueuedCount: 1,
      archivedNoteCount: 0,
    });

    expect(archiveNotesForBatch).not.toHaveBeenCalled();
  });

  it("reports the first count again when a failed Queue dispatch is retried", async () => {
    // The retry exists for the Queue chunks, and it must not pull a second
    // group of notes in behind them: an open-ended range like "Last hour" would
    // otherwise sweep up whatever arrived while the operator was retrying.
    const targets = Array.from({ length: 60 }, (_, index) => workstreamId(index + 1));
    const { archiveNotesForBatch, env } = environment(targets, 1, [workstreamId(90)]);
    const request = {
      operationId: OPERATION_ID,
      filter: { pinned: false, includeSystem: false },
      update: { kind: "archive" as const },
    };
    const service = new WorkstreamBatchUpdateService(env, auth);

    await expect(service.enqueue(request)).rejects.toThrow("queue_chunk_failed");
    await expect(service.enqueue(request)).resolves.toEqual({
      operationId: OPERATION_ID,
      enqueuedCount: 60,
      archivedNoteCount: 1,
    });

    expect(archiveNotesForBatch).toHaveBeenCalledTimes(2);
    // The second call is the receipt answering, not a second archive.
    await expect(Promise.all(archiveNotesForBatch.mock.results.map((result) => result.value)))
      .resolves.toEqual([
        { archivedNoteCount: 1, replayed: false },
        { archivedNoteCount: 1, replayed: true },
      ]);
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
