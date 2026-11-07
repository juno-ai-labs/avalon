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
  ParentEffectEnvelopeSchema,
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
  deliverChildEffects,
  pendingChildEffects,
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
const ACTIVITY_WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000baa");
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
 * The real member create, through the product service and stopping short of
 * the endpoint's execution-receipt wake, so no model run is admitted and the
 * only alarm work the object has is its outbox.
 */
async function openWorkstream(stub: DurableObjectStub<AgentLoopDO>, workstreamId: string, title: string): Promise<void> {
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

    // The opening turn keeps writing the Channel row until it settles (here it
    // fails: there is no model), and each write is a new version. Wait it out,
    // so the version read below is the one the drain alone must leave alone.
    const SETTLED = ["needs_input", "completed", "cancelled", "failed", "budget_exhausted", "idle"];
    await expect.poll(async () => {
      const common = (await pendingChildEffects(child)).filter((envelope) => envelope.effect.kind === "directory_common");
      const effect = common.at(-1)?.effect;
      return effect?.kind === "directory_common" ? effect.state : null;
    }, { timeout: 10_000, interval: 100 }).toBeOneOf(SETTLED);

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

  it("carries a child's directory through its hosted parent's per-child row to the channels row in one delivery", async () => {
    const child = childStub(LEG_WORKSTREAM_ID);
    await parkEffectQueue(child);
    await openWorkstream(child, LEG_WORKSTREAM_ID, "Both legs");
    const workspace = workspaceStub();

    // One leg now: the consumer hands the child's effects to the Organization
    // object, which applies the parent step and then its own directory step
    // from the local outbox before the call returns. No second Queue hop.
    const delivered = await deliverChildEffects(env, child);
    const childCommon = delivered.filter((envelope) => envelope.effect.kind === "directory_common");
    expect(childCommon.length).toBeGreaterThan(0);

    // The per-child row holds the child's newest common projection, at the
    // child's own version number.
    const perChild = await runInDurableObject(workspace, (_instance, state) => state.storage.sql.exec<{
      substream_id: string;
      source_version: number;
      effect_json: string;
    }>(
      `SELECT substream_id, source_version, effect_json FROM parent_child_projections WHERE parent_id = ?`,
      LEG_WORKSTREAM_ID,
    ).toArray());
    expect(perChild).toEqual([{
      substream_id: "0",
      source_version: Math.max(...childCommon.map((envelope) => envelope.sourceVersion)),
      effect_json: JSON.stringify(childCommon.at(-1)!.effect),
    }]);
    expect(JSON.parse(perChild[0]!.effect_json)).toMatchObject({ kind: "directory_common", title: "Both legs" });

    // The directory row is already there, at the parent's newest common
    // version, and nothing of the directory is left waiting in the outbox.
    const { directory, commonVersion, pendingDirectory } = await runInDurableObject(workspace, (_instance, state) => ({
      directory: state.storage.sql.exec<{ workstream_id: string; title: string; waterline: number }>(
        `SELECT workstream_id, title, waterline FROM channels WHERE workstream_id = ?`,
        LEG_WORKSTREAM_ID,
      ).toArray(),
      commonVersion: state.storage.sql.exec<{ next_version: number }>(
        `SELECT next_version FROM parent_projection_keys WHERE parent_id = ? AND projection_key = 'common'`,
        LEG_WORKSTREAM_ID,
      ).one().next_version - 1,
      pendingDirectory: state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM parent_outbox
          WHERE parent_id = ? AND effect_kind IN ('directory_common', 'directory_user')`,
        LEG_WORKSTREAM_ID,
      ).one().count,
    }));
    expect(commonVersion).toBeGreaterThan(0);
    expect(directory).toEqual([{ workstream_id: LEG_WORKSTREAM_ID, title: "Both legs", waterline: commonVersion }]);
    expect(pendingDirectory).toBe(0);
  });
});

describe("a parent with two children", () => {
  it("retains private child unread locally without publishing it into Main's directory", async () => {
    const workspace = workspaceStub();
    const reserve = {
      workspaceId: WORKSPACE_ID,
      parentId: SIBLING_WORKSTREAM_ID,
      createdByUserId: USER_ID,
      authorityGeneration: 1,
    };
    const childEffects = [
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
    ];

    // Through the facade, the way the Queue consumer and the create route
    // reach it, and read in the same invocation: the Channel's viewer row and
    // the Breakout's land in the writes themselves, not in an outbox row a
    // later drain applies.
    await runInDurableObject(workspace, async (instance, state) => {
      await instance.reserveChild({
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
      await instance.reserveChild({ ...reserve, substreamId: SIBLING_CHILD_ID, kind: "child" });
      for (const envelope of childEffects) {
        await instance.receiveChildEffects({ substreamId: envelope.substreamId, envelopes: [envelope] });
      }
      const perChild = state.storage.sql.exec<{ substream_id: string }>(
        `SELECT substream_id FROM parent_child_viewer_projections WHERE parent_id = ? AND user_id = ? ORDER BY substream_id`,
        SIBLING_WORKSTREAM_ID,
        USER_ID,
      ).toArray();
      expect(perChild.map((row) => row.substream_id)).toEqual(["0", SIBLING_CHILD_ID]);
      // Main advances the Channel row (the creator's provisional row at
      // version 1, then the child's unread at 2), while the Breakout carries
      // its own tagged projection to the Space dashboard and is not folded
      // into Main.
      expect(state.storage.sql.exec<{ unread_count: number; waterline: number }>(
        `SELECT unread_count, waterline FROM channel_viewers WHERE workstream_id = ? AND user_id = ?`,
        SIBLING_WORKSTREAM_ID,
        USER_ID,
      ).toArray()).toEqual([{ unread_count: 2, waterline: 2 }]);
      expect(state.storage.sql.exec<{ unread_count: number; waterline: number }>(
        `SELECT unread_count, waterline FROM breakout_viewers
          WHERE workstream_id = ? AND substream_id = ? AND user_id = ?`,
        SIBLING_WORKSTREAM_ID,
        SIBLING_CHILD_ID,
        USER_ID,
      ).toArray()).toEqual([{ unread_count: 3, waterline: 1 }]);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM parent_outbox WHERE parent_id = ?`,
        SIBLING_WORKSTREAM_ID,
      ).one().count).toBe(0);
    });
  });
});

describe("the Organization's parent outbox", () => {
  it("applies directory and activity rows in the write and leaves a mention for the alarm to send to ACTIVITY_QUEUE", async () => {
    const workspace = workspaceStub();
    // Refused while parked, so an alarm that fires early defers the mention
    // row instead of sending it; recorded once unparked.
    const gate = await captureEffectQueue(workspace);
    await workspace.reserveChild({
      workspaceId: WORKSPACE_ID,
      parentId: ACTIVITY_WORKSTREAM_ID,
      createdByUserId: USER_ID,
      authorityGeneration: 1,
      substreamId: asSubstreamId("0"),
      kind: "main",
      directory: {
        title: "Activity leaves by Queue",
        description: "",
        scope: "personal",
        systemKind: null,
        emailAddress: null,
        titleStatus: "settled",
        createdAt: "2026-09-01T12:00:00.000Z",
      },
    });
    const viewer = childEnvelope({
      parentKind: "workstream",
      parentId: ACTIVITY_WORKSTREAM_ID,
      substreamId: "0",
      sourceVersion: 1,
      effect: viewerEffect(4),
    });
    const activity = childEnvelope({
      parentKind: "workstream",
      parentId: ACTIVITY_WORKSTREAM_ID,
      substreamId: "0",
      sourceVersion: 2,
      effect: activityEffect("channel-activity-1"),
    });
    // A message that names somebody: its feed row lands in the write too, and
    // the consumer still has to snapshot the mention, which only it can do.
    const mention = childEnvelope({
      parentKind: "workstream",
      parentId: ACTIVITY_WORKSTREAM_ID,
      substreamId: "0",
      sourceVersion: 3,
      effect: {
        ...activityEffect("channel-mention-1"),
        eventId: "00000000-0000-7000-8000-000000000bc3",
        sourceKind: "workstream_message",
        sourceId: "00000000-0000-7000-8000-000000000bc4",
        targets: [{ userId: USER_ID, relation: "mentioned" }],
      } as ConversationEffect,
    });
    // Read in the same invocation as the writes, so the alarm, which could
    // apply an outbox row too, cannot be what put these rows there.
    const before = await runInDurableObject(workspace, async (instance, state) => {
      await instance.receiveChildEffects({ substreamId: asSubstreamId("0"), envelopes: [viewer] });
      await instance.receiveChildEffects({ substreamId: asSubstreamId("0"), envelopes: [activity] });
      await instance.receiveChildEffects({ substreamId: asSubstreamId("0"), envelopes: [mention] });
      return {
        viewers: state.storage.sql.exec<{ unread_count: number }>(
          `SELECT unread_count FROM channel_viewers WHERE workstream_id = ? AND user_id = ?`,
          ACTIVITY_WORKSTREAM_ID,
          USER_ID,
        ).toArray(),
        feed: state.storage.sql.exec<{ dedupe_key: string }>(
          `SELECT dedupe_key FROM workspace_activity_events WHERE audience_workstream_id = ? ORDER BY dedupe_key`,
          ACTIVITY_WORKSTREAM_ID,
        ).toArray().map((row) => row.dedupe_key),
        outbox: state.storage.sql.exec<{ effect_kind: string; message_id: string }>(
          `SELECT effect_kind, message_id FROM parent_outbox WHERE parent_id = ?`,
          ACTIVITY_WORKSTREAM_ID,
        ).toArray(),
      };
    });
    expect(before.viewers).toEqual([{ unread_count: 4 }]);
    expect(before.feed).toEqual(["channel-activity-1", "channel-mention-1"]);
    expect(before.outbox).toEqual([{ effect_kind: "activity_event", message_id: `substream:0:${mention.messageId}` }]);
    expect(gate.sent).toEqual([]);

    // Hand the Queue back, make the row due, and let the real alarm send it.
    gate.parked = false;
    await runInDurableObject(workspace, async (_instance, state) => {
      state.storage.sql.exec(`UPDATE parent_outbox SET not_before = 0 WHERE parent_id = ?`, ACTIVITY_WORKSTREAM_ID);
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(workspace);
    await expect.poll(async () => runInDurableObject(workspace, (_instance, state) => state.storage.sql.exec<{
      count: number;
    }>(`SELECT COUNT(*) AS count FROM parent_outbox WHERE parent_id = ?`, ACTIVITY_WORKSTREAM_ID).one().count), {
      timeout: 10_000,
      interval: 100,
    }).toBe(0);

    const sent = gate.sent.map((body) => ParentEffectEnvelopeSchema.safeParse(body))
      .flatMap((parsed) => parsed.success && parsed.data.parentId === ACTIVITY_WORKSTREAM_ID ? [parsed.data] : []);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: "parent_effect",
      parentKind: "workstream",
      parentId: ACTIVITY_WORKSTREAM_ID,
      messageId: `substream:0:${mention.messageId}`,
      effect: { kind: "activity_event", dedupeKey: "channel-mention-1" },
    });
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

  it("sends a directory effect without its Sidekick attachments when only they push it past the limit", async () => {
    const child = childStub(ATTACHMENTS_WORKSTREAM_ID);
    const capture = await captureEffectQueue(child, { logLevel: "warn" });
    expect((await child.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: ATTACHMENTS_WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    const envelope = childEnvelope({
      parentKind: "workstream",
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
