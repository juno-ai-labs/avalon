/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The Organization object's `parent_outbox` drain, on real workerd.
 *
 * `conversation-effect-queue.test.ts` proves one activity row leaves on
 * `ACTIVITY_QUEUE`. This file proves the limits the drain keeps around that
 * send (docs/hosted-conversation-parents.md, "The local outbox"): a row too
 * large for one Queue message is dropped rather than retried, due rows are
 * split into `sendBatch` calls under the per-call size, a refused batch defers
 * only its own rows, two drains never send the same row, and a viewer row that
 * arrived before its Channel's row is applied as soon as that row lands.
 *
 * The Queue is replaced on the object's `env` by a recorder, so what the real
 * drain handed the binding, call by call, is what is asserted on.
 */
import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ConversationEffectEnvelopeSchema,
  EFFECT_QUEUE_MESSAGE_MAX_BYTES,
  ParentEffectEnvelopeSchema,
  asUserId,
  asWorkspaceId,
  conversationEffectHash,
  type ConversationEffect,
  type ParentEffect,
  type ParentEffectEnvelope,
} from "@rally/contracts";

import type { Env } from "../src/env";
import { notePendingParentImport, parentImportState } from "../src/durable-objects/hosted-parent-import";
import { hostedParentStub } from "./helpers/hosted-parent";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000e00");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000e01");
const SESSION_ID = "00000000-0000-7000-8000-000000000e02";
const CHANNEL_ID = "00000000-0000-7000-8000-000000000e03";
const IMPORTED_CHANNEL_ID = "00000000-0000-7000-8000-000000000e04";
const LATE_CHANNEL_ID = "00000000-0000-7000-8000-000000000e05";

/** Cloudflare's per-call `sendBatch` size, less the headroom the drain keeps. */
const QUEUE_BATCH_MAX_BYTES = 250_000;

const encoder = new TextEncoder();

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: USER_ID, sessionId: SESSION_ID });
  await workspaceStub().initializeWorkspace(WORKSPACE_ID, "wnam");
}, 30_000);

function workspaceStub() {
  return hostedParentStub(env, WORKSPACE_ID);
}

interface SendCall {
  messageIds: string[];
  bytes: number;
  outcome: "sent" | "refused";
}

interface QueueRecorder {
  /** Every `sendBatch` that carried parent effects, in the order the drain made them. */
  calls: SendCall[];
  /** A batch this returns true for is refused, the way a Queue outage refuses it. */
  refuse: (messageIds: string[]) => boolean;
  /** While set, a parent-effect `sendBatch` waits on it before answering. */
  hold: Promise<void> | null;
  /** How many `sendBatch` calls have reached `hold`. */
  held: number;
}

/**
 * Replace `ACTIVITY_QUEUE` on the Organization object with a recorder. Bodies
 * that are not parent effects (the alarm's other phases) are accepted and not
 * recorded, so the calls are exactly the outbox drain's.
 */
async function recordQueue(stub: DurableObjectStub): Promise<QueueRecorder> {
  const recorder: QueueRecorder = { calls: [], refuse: () => false, hold: null, held: 0 };
  const queue = {
    send: async () => {},
    sendBatch: async (messages: Iterable<{ body: unknown }>) => {
      const effects = [...messages].flatMap(({ body }) => {
        const parsed = ParentEffectEnvelopeSchema.safeParse(body);
        return parsed.success ? [parsed.data] : [];
      });
      if (effects.length === 0) return;
      if (recorder.hold) {
        recorder.held += 1;
        await recorder.hold;
      }
      const messageIds = effects.map((effect) => effect.messageId);
      const bytes = effects.reduce((total, effect) => total + encoder.encode(JSON.stringify(effect)).byteLength, 0);
      if (recorder.refuse(messageIds)) {
        recorder.calls.push({ messageIds, bytes, outcome: "refused" });
        throw new Error("activity_queue_refused_by_test");
      }
      recorder.calls.push({ messageIds, bytes, outcome: "sent" });
    },
  };
  await runInDurableObject(stub, (instance) => {
    const target = instance as unknown as { env: Env };
    target.env = new Proxy(target.env, {
      get: (current, property, receiver) => property === "ACTIVITY_QUEUE"
        ? queue
        : Reflect.get(current, property, receiver),
    });
  });
  return recorder;
}

/** An activity effect whose `metadata` carries `padBytes` of filler, to set the envelope's size. */
function activityEnvelope(parentId: string, sequence: number, padBytes: number): ParentEffectEnvelope {
  const effect: ParentEffect = {
    kind: "activity_event",
    eventId: `00000000-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
    eventType: "workstream_message_created",
    subjectSequenceNumber: sequence,
    actorType: "agent",
    actorUserId: null,
    actorLabel: "Rally",
    title: `Activity ${sequence}`,
    body: "",
    canonicalUrl: null,
    digestible: false,
    occurredAt: "2026-09-01T12:00:00.000Z",
    sourceKind: "message",
    sourceId: null,
    dedupeKey: `outbox-activity-${sequence}`,
    metadata: { pad: "x".repeat(padBytes) },
    targets: [],
  };
  return ParentEffectEnvelopeSchema.parse({
    kind: "parent_effect",
    contractVersion: 1,
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: "workstream",
    parentId,
    generation: 1,
    messageId: `substream:0:outbox-${String(sequence).padStart(4, "0")}`,
    partitionKey: "activity",
    sourceVersion: sequence,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(effect),
    effect,
  });
}

/** Write rows the way `HostedParent.insertOutbox` does, due now, in `envelopes` order. */
async function seedOutbox(stub: DurableObjectStub, envelopes: ParentEffectEnvelope[]): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const now = Date.now();
    envelopes.forEach((envelope, index) => {
      state.storage.sql.exec(
        `INSERT INTO parent_outbox
           (message_id, parent_id, partition_key, source_version, source_epoch, effect_kind,
            payload_json, payload_hash, state, attempts, not_before, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        envelope.messageId, envelope.parentId, envelope.partitionKey, envelope.sourceVersion, envelope.generation,
        envelope.effect.kind, JSON.stringify(envelope), envelope.payloadHash, now, now - envelopes.length + index,
      );
    });
  });
}

interface OutboxRow extends Record<string, SqlStorageValue> {
  message_id: string;
  effect_kind: string;
  attempts: number;
  not_before: number;
}

async function outboxRows(stub: DurableObjectStub, parentId: string): Promise<OutboxRow[]> {
  return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<OutboxRow>(
    `SELECT message_id, effect_kind, attempts, not_before FROM parent_outbox
      WHERE parent_id = ? ORDER BY message_id`,
    parentId,
  ).toArray());
}

/** The drain every entry point uses: the alarm, an import, and (local only) a parent write. */
async function drain(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    await (instance as unknown as { drainParentOutbox(): Promise<void> }).drainParentOutbox();
  });
}

function sentIds(recorder: QueueRecorder): string[] {
  return recorder.calls.filter((call) => call.outcome === "sent").flatMap((call) => call.messageIds);
}

describe("the Organization's parent outbox drain", () => {
  it("deletes a row too large for one Queue message and sends the other due rows", async () => {
    const workspace = workspaceStub();
    const recorder = await recordQueue(workspace);
    const small = [activityEnvelope(CHANNEL_ID, 1, 100), activityEnvelope(CHANNEL_ID, 3, 100)];
    const oversized = activityEnvelope(CHANNEL_ID, 2, EFFECT_QUEUE_MESSAGE_MAX_BYTES + 1_000);
    expect(encoder.encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(EFFECT_QUEUE_MESSAGE_MAX_BYTES);
    await seedOutbox(workspace, [small[0]!, oversized, small[1]!]);

    await drain(workspace);

    expect(sentIds(recorder)).toEqual(small.map((envelope) => envelope.messageId));
    expect(recorder.calls.flatMap((call) => call.messageIds)).not.toContain(oversized.messageId);
    expect(await outboxRows(workspace, CHANNEL_ID)).toEqual([]);
  });

  it("splits due rows over the per-call byte budget into several sendBatch calls, each under it", async () => {
    const workspace = workspaceStub();
    const recorder = await recordQueue(workspace);
    // Seven rows of about 60 KB: four fit one call, so at least two are needed.
    const envelopes = Array.from({ length: 7 }, (_, index) => activityEnvelope(CHANNEL_ID, index + 1, 60_000));
    await seedOutbox(workspace, envelopes);

    await drain(workspace);

    expect(recorder.calls.length).toBeGreaterThan(1);
    for (const call of recorder.calls) expect(call.bytes).toBeLessThanOrEqual(QUEUE_BATCH_MAX_BYTES);
    expect(sentIds(recorder)).toEqual(envelopes.map((envelope) => envelope.messageId));
    expect(await outboxRows(workspace, CHANNEL_ID)).toEqual([]);
  });

  it("keeps a refused batch's rows pending with a retry delay while the other batches leave", async () => {
    const workspace = workspaceStub();
    const recorder = await recordQueue(workspace);
    const envelopes = Array.from({ length: 7 }, (_, index) => activityEnvelope(CHANNEL_ID, index + 1, 60_000));
    const refusedId = envelopes[0]!.messageId;
    recorder.refuse = (messageIds) => messageIds.includes(refusedId);
    await seedOutbox(workspace, envelopes);
    const before = Date.now();

    await drain(workspace);

    const refused = recorder.calls.filter((call) => call.outcome === "refused");
    expect(refused).toHaveLength(1);
    const refusedIds = refused[0]!.messageIds;
    expect(refusedIds.length).toBeLessThan(envelopes.length);
    expect(sentIds(recorder)).toEqual(envelopes.map((envelope) => envelope.messageId)
      .filter((messageId) => !refusedIds.includes(messageId)));
    const pending = await outboxRows(workspace, CHANNEL_ID);
    expect(pending.map((row) => row.message_id)).toEqual([...refusedIds].sort());
    for (const row of pending) {
      expect(row.attempts).toBe(1);
      expect(row.not_before).toBeGreaterThan(before);
    }
  });

  it("sends each row once when an import's drain starts while the alarm's is still sending", async () => {
    const workspace = workspaceStub();
    const recorder = await recordQueue(workspace);
    let release!: () => void;
    recorder.hold = new Promise<void>((resolve) => { release = resolve; });
    const envelopes = Array.from({ length: 3 }, (_, index) => activityEnvelope(CHANNEL_ID, index + 1, 100));
    await seedOutbox(workspace, envelopes);
    await runInDurableObject(workspace, async (_instance, state) => {
      // A Channel the ledger still owes an import; its legacy object holds
      // nothing, so opening it imports empty and then drains the outbox.
      notePendingParentImport(state.storage.sql, IMPORTED_CHANNEL_ID, "workstream");
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    // The alarm's drain reads the rows and waits in `sendBatch`.
    const alarm = runDurableObjectAlarm(workspace);
    await expect.poll(() => recorder.held, { timeout: 10_000, interval: 20 }).toBe(1);
    // A request imports the Channel and starts its own drain while the
    // alarm's has not deleted anything yet.
    const opened = workspace.listChildren({ workspaceId: WORKSPACE_ID, parentId: IMPORTED_CHANNEL_ID })
      .then(() => null, (error: unknown) => error);
    await expect.poll(async () => runInDurableObject(workspace, (_instance, state) => (
      parentImportState(state.storage.sql, IMPORTED_CHANNEL_ID)
    )), { timeout: 10_000, interval: 20 }).toBe("imported");
    release();
    await alarm;
    // An empty import leaves no parent to list; the drain is what is asserted.
    expect(String(await opened)).toContain("conversation_parent_missing");

    const sent = sentIds(recorder);
    expect([...sent].sort()).toEqual(envelopes.map((envelope) => envelope.messageId));
    expect(await outboxRows(workspace, CHANNEL_ID)).toEqual([]);
  });

  it("applies a viewer row refused before its Channel row existed in the drain that applies that Channel row", async () => {
    const workspace = workspaceStub();
    await recordQueue(workspace);
    // Common and viewer effects travel on different partitions, so the
    // viewer's can reach the parent first. Its row is applied before the
    // Channel has a directory row, refused on the missing row, and put off.
    await workspace.receiveChildEffects({
      substreamId: "0",
      envelopes: [childEnvelope(LATE_CHANNEL_ID, 1, "user", {
        kind: "directory_user",
        userId: USER_ID,
        isParticipant: true,
        participantAddedAt: "2026-09-01T12:00:00.000Z",
        unreadCount: 3,
        youAreMentioned: false,
        unseen: false,
        listable: true,
      })],
    });
    const deferred = await outboxRows(workspace, LATE_CHANNEL_ID);
    expect(deferred).toMatchObject([{ effect_kind: "directory_user", attempts: 1 }]);
    const retryAt = deferred[0]!.not_before;
    expect(retryAt).toBeGreaterThan(Date.now());
    expect(await viewerUnread(workspace)).toEqual([]);

    await workspace.receiveChildEffects({
      substreamId: "0",
      envelopes: [childEnvelope(LATE_CHANNEL_ID, 2, "common", {
        kind: "directory_common",
        title: "Arrived second",
        description: "",
        preview: "",
        scope: "workspace",
        state: "idle",
        systemKind: null,
        lastActivityAt: "2026-09-01T12:00:00.000Z",
        completedAt: null,
        archivedAt: null,
      })],
    });

    // Before the viewer row's retry delay ran out: the Channel row's own
    // drain applied it.
    expect(Date.now()).toBeLessThan(retryAt);
    expect(await viewerUnread(workspace)).toEqual([{ unread_count: 3 }]);
    expect(await outboxRows(workspace, LATE_CHANNEL_ID)).toEqual([]);
  });
});

/** What a Channel's Main conversation stamps on a directory effect. */
function childEnvelope(parentId: string, sourceVersion: number, partition: "common" | "user", effect: ConversationEffect) {
  return ConversationEffectEnvelopeSchema.parse({
    kind: "conversation_effect",
    contractVersion: 1,
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: "workstream",
    parentId,
    substreamId: "0",
    generation: 1,
    messageId: `00000000-0000-7000-8000-00000000${String(sourceVersion).padStart(4, "0")}`,
    partitionKey: partition === "common" ? "common" : `user:${USER_ID}`,
    sourceVersion,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(effect),
    effect,
  });
}

async function viewerUnread(stub: DurableObjectStub) {
  return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ unread_count: number }>(
    `SELECT unread_count FROM channel_viewers WHERE workstream_id = ? AND user_id = ?`,
    LATE_CHANNEL_ID, USER_ID,
  ).toArray());
}
