/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The Queue legs an effect travels: a conversation object's outbox to its
 * parent, and a hosted parent's outbox inside the Organization object.
 *
 * The conversation drain is alarm work on real Durable Object SQLite and
 * deletes the row the moment `sendBatch` accepts it, so what is proved there
 * is the bookkeeping around the send: the row exists before the drain, is gone
 * after it, and the projection version survives it. A Channel's parent lives
 * in `WorkspaceDO`, which applies directory and activity rows to its own
 * tables in the parent write's transaction; only the work that has to leave
 * the object (a mention to snapshot, a notification to deliver) waits in the
 * outbox for the alarm and leaves on `ACTIVITY_QUEUE`. This file is the one place that proves the real drain; the
 * consumer is the production one, and the test Worker only binds the Queue as
 * a producer, so `helpers/conversation-effects` hands queued bodies to it by
 * hand.
 */
import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConversationEffectEnvelopeSchema,
  EFFECT_QUEUE_MESSAGE_MAX_BYTES,
  asAutomationId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  conversationEffectHash,
  type ConversationEffect,
  type ConversationEffectEnvelope,
} from "@rally/contracts";

import type { AuthContext, Env } from "../src/env";
import {
  conversationObjectName,
  workspaceDOName,
} from "../src/durable-objects/names";
import type { AgentLoopDO } from "../src/durable-objects/agent-loop-do";
import type { WorkstreamObjectProductService } from "../src/durable-objects/workstream-object-product";
import {
  consumeEffectBodies,
  pendingChildEffects,
} from "./helpers/conversation-effects";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";
import { createCanvas } from "../src/services/canvas-service";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000ba0");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000ba1");
const SESSION_ID = "00000000-0000-7000-8000-000000000ba2";
const DRAIN_WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000ba3");
const AUTOMATION_ID = asAutomationId("00000000-0000-7000-8000-000000000ba7");
const AUTOMATION_RUN_ID = asSubstreamId("00000000-0000-7000-8000-000000000ba8");
const OVERSIZED_WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000ba9");
const ATTACHMENTS_WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000bab");

/** The child outbox channel; `dueRegionalEffects` reads nothing else. */
const REGIONAL_EFFECT_CHANNEL = "regional_effect_v1";

const AUTH: AuthContext = {
  sessionId: SESSION_ID,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  region: "global",
  role: "member",
};

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, {
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });
  // The D1 anchors `createCanvas` claims for the conversation it makes.
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
      verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL)`),
  ]);
  await workspaceStub().initializeWorkspace(WORKSPACE_ID, "wnam");
}, 30_000);

afterEach(() => {
  vi.restoreAllMocks();
});

function workspaceStub() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

function childStub(parentId: string, substreamId = asSubstreamId("0")): DurableObjectStub<AgentLoopDO> {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, parentId, substreamId),
  ));
}

interface QueueGate {
  /** While true the object's producer refuses, so its drain defers rows instead of deleting them. */
  parked: boolean;
}

/**
 * Keep an object's outbox readable.
 *
 * The drain alarm fires the moment an effect commits and deletes every row
 * `ACTIVITY_QUEUE` accepts, so a read placed after the mutation races the
 * drain (docs/testing.md). A producer that refuses makes the drain defer the
 * rows instead, and the helpers then hand exactly those rows to the real
 * consumer. Flip `parked` off to hand the real binding back.
 */
async function parkEffectQueue(
  stub: DurableObjectStub,
  options: { logLevel?: "warn" } = {},
): Promise<QueueGate> {
  const gate: QueueGate = { parked: true };
  const refused = () => Promise.reject(new Error("effect_queue_parked_by_test"));
  const parked = { send: refused, sendBatch: refused };
  await runInDurableObject(stub, (instance) => {
    const target = instance as unknown as { env: Env };
    target.env = new Proxy(target.env, {
      get: (current, property, receiver) => {
        if (property === "ACTIVITY_QUEUE" && gate.parked) return parked;
        if (property === "LOG_LEVEL" && options.logLevel) return options.logLevel;
        return Reflect.get(current, property, receiver);
      },
    });
  });
  return gate;
}

interface QueueCapture extends QueueGate {
  /** Every body the object handed `ACTIVITY_QUEUE` while unparked. */
  sent: unknown[];
}

/**
 * `parkEffectQueue`, except that once unparked the producer records what it is
 * handed instead of reaching the test Worker's Queue, so the test can read
 * exactly what the real drain sent.
 */
async function captureEffectQueue(
  stub: DurableObjectStub,
  options: { logLevel?: "warn" } = {},
): Promise<QueueCapture> {
  const capture: QueueCapture = { parked: true, sent: [] };
  const refused = () => Promise.reject(new Error("effect_queue_parked_by_test"));
  const recorder = {
    send: async (body: unknown) => {
      if (capture.parked) return refused();
      capture.sent.push(body);
    },
    sendBatch: async (messages: Iterable<{ body: unknown }>) => {
      if (capture.parked) return refused();
      for (const message of messages) capture.sent.push(message.body);
    },
  };
  await runInDurableObject(stub, (instance) => {
    const target = instance as unknown as { env: Env };
    target.env = new Proxy(target.env, {
      get: (current, property, receiver) => {
        if (property === "ACTIVITY_QUEUE") return recorder;
        if (property === "LOG_LEVEL" && options.logLevel) return options.logLevel;
        return Reflect.get(current, property, receiver);
      },
    });
  });
  return capture;
}

/**
 * The real Canvas create, then its first message through the product service,
 * stopping short of the endpoint's execution-receipt wake, so no model run is
 * admitted and the only alarm work the object has is its outbox.
 */
async function openWorkstream(stub: DurableObjectStub<AgentLoopDO>, workstreamId: string, title: string): Promise<void> {
  await createCanvas(env, { workspaceId: WORKSPACE_ID, creatorUserId: USER_ID, canvasId: workstreamId, title });
  await runInDurableObject(stub, async (instance) => {
    const product = (instance as unknown as { product: WorkstreamObjectProductService }).product;
    await product.createMessage(AUTH, {
      text: "starting",
      clientMessageId: `queue-open-${workstreamId}`,
      mentions: [],
      confirmedParticipantUserIds: [],
      attachmentIds: [],
    });
  });
}

async function outboxCount(stub: DurableObjectStub): Promise<number> {
  return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ count: number }>(
    `SELECT COUNT(*) AS count FROM durable_outbox
     WHERE channel = ? AND state IN ('pending', 'inflight')`, REGIONAL_EFFECT_CHANNEL,
  ).one().count);
}

async function projectionVersion(stub: DurableObjectStub, key: string): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ next_version: number }>(
    `SELECT next_version FROM projection_keys WHERE projection_key = ?`,
    key,
  ).toArray()[0]?.next_version ?? null);
}

let envelopeSeq = 0;

/** What a child stamps on an effect, built the way `enqueueEffectsInCurrentTransaction` does. */
function childEnvelope(input: {
  parentKind: "canvas" | "automation" | "workstream";
  parentId: string;
  substreamId: string;
  sourceVersion: number;
  effect: ConversationEffect;
}): ConversationEffectEnvelope {
  envelopeSeq += 1;
  const partitionKey = input.effect.kind === "directory_common"
    ? "common"
    : input.effect.kind === "directory_user"
      ? `user:${input.effect.userId}`
      : "activity";
  return ConversationEffectEnvelopeSchema.parse({
    kind: "conversation_effect",
    contractVersion: 1,
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: input.parentKind,
    parentId: input.parentId,
    substreamId: input.substreamId,
    generation: 1,
    messageId: `00000000-0000-7000-8000-${String(envelopeSeq).padStart(9, "0")}bb0`,
    partitionKey,
    sourceVersion: input.sourceVersion,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(input.effect),
    effect: input.effect,
  });
}

/** An activity effect as a child stamps it; its content is not what these cases are about. */
function activityEffect(dedupeKey: string): ConversationEffect {
  return {
    kind: "activity_event",
    eventId: "00000000-0000-7000-8000-000000000bc1",
    eventType: "workstream_message_created",
    subjectSequenceNumber: 1,
    actorType: "agent",
    actorUserId: null,
    actorLabel: "Rally",
    title: "A conversation said something",
    body: "Where this is heard depends on the parent.",
    canonicalUrl: null,
    digestible: false,
    occurredAt: "2026-09-01T12:00:00.000Z",
    sourceKind: "message",
    sourceId: "00000000-0000-7000-8000-000000000bc2",
    dedupeKey,
    metadata: {},
    targets: [],
  };
}

describe("a conversation object's outbox", () => {
  it("leaves a product mutation's effect pending, and the real drain sends it and keeps the projection version", async () => {
    const child = childStub(DRAIN_WORKSTREAM_ID);
    const gate = await parkEffectQueue(child);
    await openWorkstream(child, DRAIN_WORKSTREAM_ID, "Drained by the alarm");

    // The opening message's run keeps writing the Canvas's row until it
    // settles (here it fails: there is no model), and each write is a new
    // version. Let the object's own alarm take the message and wait the run
    // out, so the version read below is the one the drain alone must leave
    // alone.
    await runDurableObjectAlarm(child);
    await expect.poll(() => runInDurableObject(child, (_instance, state) => ({
      runs: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM runs").one().count,
      open: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM runs WHERE terminalized_at IS NULL").one().count,
      pending: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM pending_loop_inputs").one().count,
      executing: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM substream_loops WHERE status = 'executing'").one().count,
    })), { timeout: 10_000, interval: 100 }).toEqual({ runs: 1, open: 0, pending: 0, executing: 0 });

    const pending = await pendingChildEffects(child);
    expect(pending.map((envelope) => envelope.effect.kind)).toContain("directory_common");
    for (const envelope of pending) {
      expect(envelope).toMatchObject({
        kind: "conversation_effect",
        parentKind: "canvas",
        parentId: DRAIN_WORKSTREAM_ID,
        substreamId: "0",
      });
    }
    // Written per effect in the same transaction as the outbox row and
    // deleted by nothing, so it is what the drain must leave alone.
    const version = await projectionVersion(child, "common");
    expect(version).toBeGreaterThan(1);

    // Hand the real binding back, make the deferred rows due, and let the
    // real alarm handler run: the Queue accepts, the rows go, the version stays.
    gate.parked = false;
    await runInDurableObject(child, async (_instance, state) => {
      state.storage.sql.exec(`UPDATE durable_outbox SET not_before = 0 WHERE channel = ?`, REGIONAL_EFFECT_CHANNEL);
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(child);
    // The alarm may have auto-fired before the helper looked; the poll is the
    // wait for that case, and the empty outbox is the state only a successful
    // send settles.
    await expect.poll(() => outboxCount(child), { timeout: 10_000, interval: 100 }).toBe(0);
    expect(await projectionVersion(child, "common")).toBe(version);
  });

});

describe("an automation's child", () => {
  it("has its activity receipted by the automation and forwarded nowhere", async () => {
    // The Sidekick's parent is hosted by the Organization object.
    const automation = workspaceStub();
    await parkEffectQueue(automation);
    await automation.sidekickCreate({
      workspaceId: WORKSPACE_ID,
      automationId: AUTOMATION_ID,
      authorUserId: USER_ID,
      scope: "personal",
      authorityGeneration: 1,
    });
    const run = childStub(AUTOMATION_ID, AUTOMATION_RUN_ID);
    expect((await run.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "automation",
      parentId: AUTOMATION_ID,
      substreamId: AUTOMATION_RUN_ID,
      generation: 1,
    })).status).toBe(200);

    // What the run's object stamps on an activity effect; built by hand so the
    // case stays about the parent's answer rather than about which product
    // mutation of a run produces activity.
    const envelope = childEnvelope({
      parentKind: "automation",
      parentId: AUTOMATION_ID,
      substreamId: AUTOMATION_RUN_ID,
      sourceVersion: 1,
      effect: activityEffect("run-activity-1"),
    });
    expect(await consumeEffectBodies(env, [envelope])).toEqual({ acked: 1, retried: 0 });

    await runInDurableObject(automation, (_instance, state) => {
      expect(state.storage.sql.exec<{ substream_id: string; payload_hash: string }>(
        `SELECT substream_id, payload_hash FROM sidekick_child_receipts WHERE sidekick_id = ? AND message_id = ?`,
        AUTOMATION_ID, envelope.messageId,
      ).toArray()).toEqual([{ substream_id: AUTOMATION_RUN_ID, payload_hash: envelope.payloadHash }]);
      // Parked above, so a forwarded row would still be here to be counted.
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM parent_outbox WHERE parent_id = ?`, AUTOMATION_ID,
      ).one().count).toBe(0);
    });
  });
});

describe("a retired parent's effect", () => {
  it("still parses at the Queue boundary, is refused by name and retried toward the dead-letter queue", async () => {
    // A Thread's effect is a defect to find, not traffic to drop
    // (docs/hosted-conversation-parents.md): it is never acknowledged.
    const envelope = childEnvelope({
      parentKind: "workstream",
      parentId: "00000000-0000-7000-8000-0000000000e9",
      substreamId: "0",
      sourceVersion: 1,
      effect: activityEffect("retired-activity-1"),
    });
    expect(await consumeEffectBodies(env, [envelope])).toEqual({ acked: 0, retried: 1 });
    // The refusal the retry carries, named by kind.
    await expect(workspaceStub().receiveChildEffects({ substreamId: envelope.substreamId, envelopes: [envelope] }))
      .rejects.toThrow("conversation_parent_kind_retired:workstream");
  });
});

describe("an envelope the Queue would refuse", () => {
  it("is dropped by the drain with a warning rather than retried forever", async () => {
    const child = childStub(OVERSIZED_WORKSTREAM_ID);
    await parkEffectQueue(child, { logLevel: "warn" });
    expect((await child.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "canvas",
      parentId: OVERSIZED_WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);

    // Only `resourceLinks` can push a directory effect past the message limit.
    const envelope = childEnvelope({
      parentKind: "canvas",
      parentId: OVERSIZED_WORKSTREAM_ID,
      substreamId: "0",
      sourceVersion: 1,
      effect: {
        kind: "directory_common",
        title: "Too many links",
        description: "",
        preview: "",
        scope: "personal",
        state: "idle",
        systemKind: null,
        lastActivityAt: "2026-09-01T12:00:00.000Z",
        completedAt: null,
        archivedAt: null,
        resourceLinks: Array.from({ length: 2_500 }, (_, index) => ({
          resourceId: `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`,
          watchEnabled: false,
          relationshipType: "context" as const,
        })),
      },
    });
    const payload = JSON.stringify(envelope);
    expect(new TextEncoder().encode(payload).byteLength).toBeGreaterThan(EFFECT_QUEUE_MESSAGE_MAX_BYTES);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runInDurableObject(child, async (_instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO durable_outbox
           (message_id, channel, destination_kind, destination_id, partition_key,
            source_version, source_epoch, contract_version, payload_json, payload_ref,
            payload_hash, state, attempts, not_before, created_at, acked_at)
         VALUES (?, ?, 'queue', 'global', 'common', 1, 1, 1, ?, NULL, ?, 'pending', 0, ?, ?, NULL)`,
        envelope.messageId,
        REGIONAL_EFFECT_CHANNEL,
        payload,
        envelope.payloadHash,
        now,
        now,
      );
      await state.storage.setAlarm(now);
    });
    await runDurableObjectAlarm(child);

    await expect.poll(() => outboxCount(child), { timeout: 10_000, interval: 100 }).toBe(0);
    const dropped = warned.mock.calls
      .map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry?.event === "conversation_effect_oversized");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      message_id: envelope.messageId,
      effect_kind: "directory_common",
      limit_bytes: EFFECT_QUEUE_MESSAGE_MAX_BYTES,
      outcome: "dropped",
    });
  });

  it("sends a directory effect without its Sidekick attachments when only they push it past the limit", async () => {
    const child = childStub(ATTACHMENTS_WORKSTREAM_ID);
    const capture = await captureEffectQueue(child, { logLevel: "warn" });
    expect((await child.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "canvas",
      parentId: ATTACHMENTS_WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    const envelope = childEnvelope({
      parentKind: "canvas",
      parentId: ATTACHMENTS_WORKSTREAM_ID,
      substreamId: "0",
      sourceVersion: 1,
      effect: {
        kind: "directory_common",
        title: "Too many Sidekicks",
        description: "",
        preview: "",
        scope: "personal",
        state: "idle",
        systemKind: null,
        lastActivityAt: "2026-09-01T12:00:00.000Z",
        completedAt: null,
        archivedAt: null,
        sidekickAttachmentIds: Array.from({ length: 3_500 },
          (_, index) => `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`),
      },
    });
    const payload = JSON.stringify(envelope);
    expect(new TextEncoder().encode(payload).byteLength).toBeGreaterThan(EFFECT_QUEUE_MESSAGE_MAX_BYTES);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runInDurableObject(child, async (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM durable_outbox`);
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO durable_outbox
           (message_id, channel, destination_kind, destination_id, partition_key,
            source_version, source_epoch, contract_version, payload_json, payload_ref,
            payload_hash, state, attempts, not_before, created_at, acked_at)
         VALUES (?, ?, 'queue', 'global', 'common', 1, 1, 1, ?, NULL, ?, 'pending', 0, ?, ?, NULL)`,
        envelope.messageId,
        REGIONAL_EFFECT_CHANNEL,
        payload,
        envelope.payloadHash,
        now,
        now,
      );
      await state.storage.setAlarm(now);
    });
    capture.parked = false;
    await runDurableObjectAlarm(child);

    // Every other directory field still reaches the parent, and the row the
    // trimmed body stands for is gone rather than resent.
    await expect.poll(() => outboxCount(child), { timeout: 10_000, interval: 100 }).toBe(0);
    const sent = capture.sent as Array<{ messageId: string; effect: Record<string, unknown> }>;
    const body = sent.find((item) => item.messageId === envelope.messageId);
    expect(body?.effect).toMatchObject({ kind: "directory_common", title: "Too many Sidekicks" });
    expect(body?.effect).not.toHaveProperty("sidekickAttachmentIds");
    const omitted = warned.mock.calls
      .map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry?.event === "conversation_effect_oversized");
    expect(omitted).toHaveLength(1);
    expect(omitted[0]).toMatchObject({ message_id: envelope.messageId, attachment_count: 3_500, outcome: "attachments_omitted" });
  });
});
