/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The two Queue legs an effect travels: a conversation object's outbox to its
 * parent, and the parent's outbox to the workspace.
 *
 * Both drains are alarm work on real Durable Object SQLite, and both delete
 * the row the moment `sendBatch` accepts it, so what is proved here is the
 * bookkeeping around the send: the row exists before the drain, is gone after
 * it, the projection version survives it, and the receivers dedupe and
 * aggregate what arrives. The consumer itself is the production one; the test
 * Worker only binds the Queue as a producer, so `helpers/conversation-effects`
 * hands the queued bodies to it by hand.
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
  automationDOName,
  conversationObjectName,
  workspaceDOName,
  workstreamDOName,
} from "../src/durable-objects/names";
import type { SubstreamAgent } from "../src/durable-objects/substream-agent";
import type { WorkstreamObjectProductService } from "../src/durable-objects/workstream-object-product";
import {
  consumeEffectBodies,
  deliverChildEffects,
  deliverParentEffects,
  pendingChildEffects,
  pendingParentEffects,
} from "./helpers/conversation-effects";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000ba0");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000ba1");
const SESSION_ID = "00000000-0000-7000-8000-000000000ba2";
const DRAIN_WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000ba3");
const LEG_WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000ba4");
const SIBLING_WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000ba5");
const SIBLING_CHILD_ID = asSubstreamId("00000000-0000-7000-8000-000000000ba6");
const AUTOMATION_ID = asAutomationId("00000000-0000-7000-8000-000000000ba7");
const AUTOMATION_RUN_ID = asSubstreamId("00000000-0000-7000-8000-000000000ba8");
const OVERSIZED_WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000ba9");

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
  await workspaceStub().initializeWorkspace(WORKSPACE_ID, "wnam");
}, 30_000);

afterEach(() => {
  vi.restoreAllMocks();
});

function workspaceStub() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

function workstreamStub(workstreamId: string) {
  return env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
    workstreamDOName("global", WORKSPACE_ID, asWorkstreamId(workstreamId)),
  ));
}

function automationStub() {
  return env.AUTOMATION_DOS.get(env.AUTOMATION_DOS.idFromName(
    automationDOName("global", WORKSPACE_ID, AUTOMATION_ID),
  ));
}

function childStub(parentId: string, substreamId = asSubstreamId("0")): DurableObjectStub<SubstreamAgent> {
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

/**
 * The real member create, through the product service and stopping short of
 * the endpoint's execution-receipt wake, so no model run is admitted and the
 * only alarm work the object has is its outbox.
 */
async function openWorkstream(stub: DurableObjectStub<SubstreamAgent>, workstreamId: string, title: string): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    const product = (instance as unknown as { product: WorkstreamObjectProductService }).product;
    await product.initialize(AUTH, {
      workspaceId: WORKSPACE_ID,
      workstreamId,
      generation: 1,
      title,
      objective: "Prove the Queue legs",
      descriptionSource: "authored",
      titleStatus: "settled",
      scope: "personal",
      emailAddress: null,
      creatorUserId: USER_ID,
      openingMessage: "starting",
      clientMessageId: `queue-open-${workstreamId}`,
      participantUserIds: [],
      attachmentIds: [],
      modelOverride: null,
      executionPrincipal: { type: "user", userId: USER_ID },
      reason: "user_message",
    });
  });
}

async function outboxCount(stub: DurableObjectStub): Promise<number> {
  return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ count: number }>(
    `SELECT COUNT(*) AS count FROM durable_outbox WHERE state IN ('pending', 'inflight')`,
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
  parentKind: "workstream" | "automation";
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

function viewerEffect(unreadCount: number): ConversationEffect {
  return {
    kind: "directory_user",
    userId: USER_ID,
    isParticipant: true,
    participantAddedAt: "2026-09-01T12:00:00.000Z",
    unreadCount,
    youAreMentioned: false,
    unseen: false,
    listable: true,
    seenAttentionOrdinal: 0,
    manualUnreadFromOrdinal: null,
    manualUnreadGeneration: 0,
    latestMentionAttentionOrdinal: 0,
  };
}

describe("a conversation object's outbox", () => {
  it("leaves a product mutation's effect pending, and the real drain sends it and keeps the projection version", async () => {
    const child = childStub(DRAIN_WORKSTREAM_ID);
    const gate = await parkEffectQueue(child);
    await openWorkstream(child, DRAIN_WORKSTREAM_ID, "Drained by the alarm");

    const pending = await pendingChildEffects(child);
    expect(pending.map((envelope) => envelope.effect.kind)).toContain("directory_common");
    for (const envelope of pending) {
      expect(envelope).toMatchObject({
        kind: "conversation_effect",
        parentKind: "workstream",
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

  it("carries a child's directory through its parent's per-child row to the workspace directory", async () => {
    const child = childStub(LEG_WORKSTREAM_ID);
    await parkEffectQueue(child);
    await openWorkstream(child, LEG_WORKSTREAM_ID, "Both legs");
    const parent = workstreamStub(LEG_WORKSTREAM_ID);
    await parkEffectQueue(parent);

    const delivered = await deliverChildEffects(env, child);
    const childCommon = delivered.filter((envelope) => envelope.effect.kind === "directory_common");
    expect(childCommon.length).toBeGreaterThan(0);

    // The per-child row holds the child's newest common projection, at the
    // child's own version number.
    const perChild = await runInDurableObject(parent, (_instance, state) => state.storage.sql.exec<{
      substream_id: string;
      source_version: number;
      effect_json: string;
    }>(`SELECT substream_id, source_version, effect_json FROM substream_directory`).toArray());
    expect(perChild).toEqual([{
      substream_id: "0",
      source_version: Math.max(...childCommon.map((envelope) => envelope.sourceVersion)),
      effect_json: JSON.stringify(childCommon.at(-1)!.effect),
    }]);
    expect(JSON.parse(perChild[0]!.effect_json)).toMatchObject({ kind: "directory_common", title: "Both legs" });

    const queued = await pendingParentEffects(parent);
    const parentCommon = queued.filter((envelope) => envelope.effect.kind === "directory_common");
    expect(parentCommon.length).toBeGreaterThan(0);
    for (const envelope of queued) {
      expect(envelope).toMatchObject({ kind: "parent_effect", parentKind: "workstream", parentId: LEG_WORKSTREAM_ID });
    }

    await deliverParentEffects(env, parent);
    const directory = await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec<{
      workstream_id: string;
      title: string;
      waterline: number;
    }>(
      `SELECT workstream_id, title, waterline FROM workspace_workstream_directory WHERE workstream_id = ?`,
      LEG_WORKSTREAM_ID,
    ).toArray());
    // The waterline is the parent's version of its own row, the number the
    // workspace fences on, not any child's.
    expect(directory).toEqual([{
      workstream_id: LEG_WORKSTREAM_ID,
      title: "Both legs",
      waterline: parentCommon.at(-1)!.sourceVersion,
    }]);
  });
});

describe("a parent with two children", () => {
  it("sums one viewer's unread across both and numbers the aggregate itself", async () => {
    const parent = workstreamStub(SIBLING_WORKSTREAM_ID);
    await parkEffectQueue(parent);
    const reserve = {
      workspaceId: WORKSPACE_ID,
      parentId: SIBLING_WORKSTREAM_ID,
      createdByUserId: USER_ID,
      authorityGeneration: 1,
    };
    await parent.reserveChild({
      ...reserve,
      substreamId: asSubstreamId("0"),
      kind: "main",
      directory: {
        title: "Two children",
        description: "",
        scope: "personal",
        systemKind: null,
        emailAddress: null,
        titleStatus: "settled",
        createdAt: "2026-09-01T12:00:00.000Z",
      },
    });
    await parent.reserveChild({ ...reserve, substreamId: SIBLING_CHILD_ID, kind: "child" });

    const result = await consumeEffectBodies(env, [
      childEnvelope({
        parentKind: "workstream",
        parentId: SIBLING_WORKSTREAM_ID,
        substreamId: "0",
        sourceVersion: 1,
        effect: viewerEffect(2),
      }),
      childEnvelope({
        parentKind: "workstream",
        parentId: SIBLING_WORKSTREAM_ID,
        substreamId: SIBLING_CHILD_ID,
        sourceVersion: 1,
        effect: viewerEffect(3),
      }),
    ]);
    expect(result).toEqual({ acked: 2, retried: 0 });

    const perChild = await runInDurableObject(parent, (_instance, state) => state.storage.sql.exec<{
      substream_id: string;
    }>(`SELECT substream_id FROM substream_user_directory WHERE user_id = ? ORDER BY substream_id`, USER_ID).toArray());
    expect(perChild.map((row) => row.substream_id)).toEqual(["0", SIBLING_CHILD_ID]);

    const queued = (await pendingParentEffects(parent))
      .filter((envelope) => envelope.effect.kind === "directory_user");
    // The provisional row was the parent's version 1; each child's aggregate
    // is a newer version of the parent's own key, never the child's number.
    expect(queued.map((envelope) => envelope.sourceVersion)).toEqual([2, 3]);
    expect(queued.at(-1)?.effect).toMatchObject({ kind: "directory_user", unreadCount: 5, listable: true });

    await deliverParentEffects(env, parent);
    const viewer = await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec<{
      unread_count: number;
      waterline: number;
    }>(
      `SELECT unread_count, waterline FROM workspace_workstream_viewers WHERE workstream_id = ? AND user_id = ?`,
      SIBLING_WORKSTREAM_ID,
      USER_ID,
    ).toArray());
    expect(viewer).toEqual([{ unread_count: 5, waterline: 3 }]);
  });
});

describe("an automation's child", () => {
  it("has its activity receipted by the automation and forwarded nowhere", async () => {
    const automation = automationStub();
    await parkEffectQueue(automation);
    await automation.create({
      workspaceId: WORKSPACE_ID,
      automationId: AUTOMATION_ID,
      authorUserId: USER_ID,
      scope: "personal",
      owningWorkstreamId: null,
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
      effect: {
        kind: "activity_event",
        eventId: "00000000-0000-7000-8000-000000000bc1",
        eventType: "workstream_message_created",
        subjectSequenceNumber: 1,
        actorType: "agent",
        actorUserId: null,
        actorLabel: "Rally",
        title: "A run said something",
        body: "Nothing outside the automation should hear this.",
        canonicalUrl: null,
        digestible: false,
        occurredAt: "2026-09-01T12:00:00.000Z",
        sourceKind: "message",
        sourceId: "00000000-0000-7000-8000-000000000bc2",
        dedupeKey: "run-activity-1",
        metadata: {},
        targets: [],
      },
    });
    expect(await consumeEffectBodies(env, [envelope])).toEqual({ acked: 1, retried: 0 });

    await runInDurableObject(automation, (_instance, state) => {
      expect(state.storage.sql.exec<{ substream_id: string; payload_hash: string }>(
        `SELECT substream_id, payload_hash FROM child_effect_receipts WHERE message_id = ?`,
        envelope.messageId,
      ).toArray()).toEqual([{ substream_id: AUTOMATION_RUN_ID, payload_hash: envelope.payloadHash }]);
      // Parked above, so a forwarded row would still be here to be counted.
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM durable_outbox WHERE effect_kind <> 'directory_automation'`,
      ).one().count).toBe(0);
    });
  });
});

describe("an envelope the Queue would refuse", () => {
  it("is dropped by the drain with a warning rather than retried forever", async () => {
    const child = childStub(OVERSIZED_WORKSTREAM_ID);
    await parkEffectQueue(child, { logLevel: "warn" });
    expect((await child.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: OVERSIZED_WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);

    // Only `resourceLinks` can push a directory effect past the message limit.
    const envelope = childEnvelope({
      parentKind: "workstream",
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
});
