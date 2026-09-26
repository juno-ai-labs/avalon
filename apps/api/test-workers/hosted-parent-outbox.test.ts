/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The Organization object's `parent_outbox` drain, on real workerd.
 *
 * `conversation-effect-queue.test.ts` proves one activity row leaves on
 * `ACTIVITY_QUEUE`. This file proves the limits the drain keeps around that
 * send (docs/hosted-conversation-parents.md, "The outbox is work that leaves
 * the object"): a row too large for one Queue message is dropped rather than
 * retried, due rows are split into `sendBatch` calls under the per-call size,
 * a refused batch defers only its own rows on the alarm's retry schedule, two
 * drains never send the same row, a row that cannot be read is kept as failed
 * without blocking the rest, and one failing alarm phase does not skip the
 * others. A viewer effect that reaches its parent before the Channel's row
 * fails its delivery rather than waiting in the outbox.
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
import { QUEUE_BATCH_MAX_BYTES } from "../src/durable-objects/conversation-parent-object";
import { SCHEDULED_ALARM_RETRY_BASE_MS } from "../src/durable-objects/scheduled-alarms";
import { hostedParentStub } from "./helpers/hosted-parent";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000e00");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000e01");
const SESSION_ID = "00000000-0000-7000-8000-000000000e02";
const CHANNEL_ID = "00000000-0000-7000-8000-000000000e03";
const LATE_CHANNEL_ID = "00000000-0000-7000-8000-000000000e05";

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
}

/**
 * Replace `ACTIVITY_QUEUE` on the Organization object with a recorder. Bodies
 * that are not parent effects (the alarm's other phases) are accepted and not
 * recorded, so the calls are exactly the outbox drain's.
 */
async function recordQueue(stub: DurableObjectStub): Promise<QueueRecorder> {
  const recorder: QueueRecorder = { calls: [], refuse: () => false };
  const queue = {
    send: async () => {},
    sendBatch: async (messages: Iterable<{ body: unknown }>) => {
      const effects = [...messages].flatMap(({ body }) => {
        const parsed = ParentEffectEnvelopeSchema.safeParse(body);
        return parsed.success ? [parsed.data] : [];
      });
      if (effects.length === 0) return;
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
  state: string;
  last_error_code: string | null;
}

async function outboxRows(stub: DurableObjectStub, parentId: string): Promise<OutboxRow[]> {
  return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<OutboxRow>(
    `SELECT message_id, effect_kind, attempts, not_before, state, last_error_code FROM parent_outbox
      WHERE parent_id = ? ORDER BY message_id`,
    parentId,
  ).toArray());
}

/** The drain the alarm and an import run; a parent write leaves its rows to the alarm. */
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

  it("keeps a refused batch's rows pending on the alarm's retry schedule while the other batches leave", async () => {
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
      expect(row).toMatchObject({ attempts: 1, state: "pending", last_error_code: "activity_queue_refused_by_test" });
      // The first step of the alarm's schedule is at least half its base.
      expect(row.not_before).toBeGreaterThanOrEqual(before + SCHEDULED_ALARM_RETRY_BASE_MS / 2);
    }

    // Refused again, each row waits longer: the schedule doubles per attempt.
    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec("UPDATE parent_outbox SET not_before = 0 WHERE parent_id = ?", CHANNEL_ID);
    });
    const again = Date.now();
    await drain(workspace);
    for (const row of await outboxRows(workspace, CHANNEL_ID)) {
      expect(row.attempts).toBe(2);
      expect(row.not_before).toBeGreaterThanOrEqual(again + SCHEDULED_ALARM_RETRY_BASE_MS);
    }
  });

  it("keeps a row it cannot read as failed, with its code, and still sends the rows behind it", async () => {
    const workspace = workspaceStub();
    const recorder = await recordQueue(workspace);
    const good = [activityEnvelope(CHANNEL_ID, 1, 100), activityEnvelope(CHANNEL_ID, 2, 100)];
    await seedOutbox(workspace, good);
    // Valid JSON the envelope schema refuses, under another parent and the
    // same message id as a good row: the rows are keyed by parent and
    // message, so both are held.
    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO parent_outbox
           (parent_id, message_id, partition_key, source_version, source_epoch, effect_kind,
            payload_json, payload_hash, state, attempts, not_before, created_at)
         VALUES (?, ?, 'activity', 1, 1, 'activity_event', ?, 'unreadable', 'pending', 0, 0, 0)`,
        LATE_CHANNEL_ID, good[0]!.messageId, JSON.stringify({ kind: "parent_effect", contractVersion: 1 }),
      );
    });

    await drain(workspace);

    expect(sentIds(recorder)).toEqual(good.map((envelope) => envelope.messageId));
    expect(await outboxRows(workspace, CHANNEL_ID)).toEqual([]);
    const [kept] = await outboxRows(workspace, LATE_CHANNEL_ID);
    expect(kept).toMatchObject({ state: "failed", attempts: 0 });
    expect(kept!.last_error_code).toMatch(/^parent_outbox_row_invalid:/u);
    // Never due again, so it is not the first row of every later pass.
    await drain(workspace);
    expect(recorder.calls).toHaveLength(1);
    expect(await runInDurableObject(workspace, (instance) => (
      instance as unknown as { nextParentOutboxDueAt(): number | null }
    ).nextParentOutboxDueAt())).toBeNull();
  });

  it("keeps an imported directory row whose message id the directory refuses as failed, not retried", async () => {
    const workspace = workspaceStub();
    await recordQueue(workspace);
    const effect: ParentEffect = {
      kind: "directory_common", title: "Imported", description: "", preview: "", scope: "workspace", state: "idle",
      systemKind: null, lastActivityAt: "2026-09-01T12:00:00.000Z", completedAt: null, archivedAt: null,
    } as ParentEffect;
    // A legacy object's pending row, carried over at import, under a message
    // id the directory's handoff refuses (it requires a UUIDv7).
    const legacy = ParentEffectEnvelopeSchema.parse({
      kind: "parent_effect", contractVersion: 1, region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "workstream", parentId: LATE_CHANNEL_ID, generation: 1, messageId: "legacy-directory-1",
      partitionKey: "common", sourceVersion: 1, requiredProjectionVersion: null,
      payloadHash: conversationEffectHash(effect), effect,
    });
    await seedOutbox(workspace, [legacy]);

    await drain(workspace);

    const [kept] = await outboxRows(workspace, LATE_CHANNEL_ID);
    expect(kept).toMatchObject({ state: "failed", attempts: 0 });
    expect(kept!.last_error_code).toContain("messageId");
    expect(await runInDurableObject(workspace, (instance) => (
      instance as unknown as { nextParentOutboxDueAt(): number | null }
    ).nextParentOutboxDueAt())).toBeNull();
  });

  it("runs every hosted alarm phase when one throws, and still fails the alarm", async () => {
    const workspace = workspaceStub();
    await recordQueue(workspace);
    await runInDurableObject(workspace, async (instance, state) => {
      (instance as unknown as { drainParentOutbox(): Promise<void> }).drainParentOutbox = async () => {
        throw new Error("parent_outbox_failed_by_test");
      };
      // A follow-up due now, which the phase after the outbox runs.
      state.storage.sql.exec(
        `INSERT INTO workspace_directory_followups (followup_json, attempts, not_before, created_at)
         VALUES (?, 0, 0, 0)`,
        JSON.stringify({
          workspaceId: WORKSPACE_ID, publishSnapshotAll: false, snapshotUsers: [], reachChangedUsers: [],
          commonChanges: [], viewerChanges: [], breakoutChanges: [], breakoutViewerChanges: [],
          reopenBootstrap: false, watchReconciliations: [], archivalChanges: [], refreshTerminal: false,
          refreshWatchKinds: false, directoryChanged: true, syncTopics: [], refreshProductAlarm: false,
        }),
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const failed = await runDurableObjectAlarm(workspace).then(() => null, (error: unknown) => error);

    expect(String(failed)).toContain("parent_outbox_failed_by_test");
    expect(await runInDurableObject(workspace, (_instance, state) => (
      state.storage.sql.exec("SELECT id FROM workspace_directory_followups").toArray()
    ))).toEqual([]);
  });

  it("fails a viewer effect that reaches its parent before the Channel's row, and applies its redelivery", async () => {
    const workspace = workspaceStub();
    await recordQueue(workspace);
    // Common and viewer effects travel on different partitions, so the
    // viewer's can reach the parent first. Its apply has no Channel row to
    // land on, so the parent's transaction fails with it and the Queue
    // redelivers the message; nothing waits in the outbox, and no receipt
    // answers the redelivery.
    const viewer = childEnvelope(LATE_CHANNEL_ID, 1, "user", {
      kind: "directory_user",
      userId: USER_ID,
      isParticipant: true,
      participantAddedAt: "2026-09-01T12:00:00.000Z",
      unreadCount: 3,
      youAreMentioned: false,
      unseen: false,
      listable: true,
    });
    const refused = await workspace.receiveChildEffects({ substreamId: "0", envelopes: [viewer] })
      .then(() => null, (error: unknown) => error);
    expect(String(refused)).toContain("FOREIGN KEY");
    expect(await outboxRows(workspace, LATE_CHANNEL_ID)).toEqual([]);
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
    await workspace.receiveChildEffects({ substreamId: "0", envelopes: [viewer] });

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
