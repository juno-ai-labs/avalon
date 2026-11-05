/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Every Activity row is a push: the starts and finishes the feed reads from
 * the directory, pushed by the Organization object after the directory batch
 * that made them commits, and read back through the feed when sent. Mentions
 * and adds push through their notification intents (`push-delivery.test.ts`).
 *
 * Driven through `receiveChildEffects`, the step a conversation's own publish
 * runs, so the push is decided from what production writes. What was pushed is
 * read from `workspace_activity_pushes`: the local environment has no APNs or
 * Web Push credentials, so `enqueuePushDelivery` queues nothing here and the
 * consumer is called directly with the message it would have queued.
 */
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  asSpaceId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  conversationEffectHash,
  type ConversationEffect,
  type ConversationEffectEnvelope,
  type SpaceId,
  type SubstreamId,
  type UserId,
  type WorkstreamId,
  DEFAULT_NOTIFICATION_CHANNELS,
  DEFAULT_PUSH_PREFERENCES,
  type NotificationChannels,
} from "@rally/contracts";

import migration from "../../../packages/db/migrations/0107_user_push_devices.sql?raw";
import webPushMigration from "../../../packages/db/migrations/0117_web_push_device_keys.sql?raw";
import { splitSqlStatements } from "../src/lib/sql-statements";
import { deliverPush } from "../src/queues/push-delivery-consumer";
import { registerPushDevice } from "../src/services/push-device-service";
import { clearFlagTargetingAttributeCache } from "../src/services/flag-targeting-attributes";
import { WorkspaceActivityPushes } from "../src/durable-objects/workspace-activity-push";
import { WorkspaceActivityFeed } from "../src/durable-objects/workspace-activity-feed";
import type { WorkspaceSpaceStorage } from "../src/durable-objects/workspace-space-storage";
import type { ApnsOutcome } from "../src/services/push/apns-transport";
import type { PushPayloads } from "../src/services/push/push-payload";
import { createTestEnv } from "../test/helpers/cloudflare-test";
import { hostedParentStub } from "./helpers/hosted-parent";
import { placeMembership } from "./helpers/space-membership";

const workspaceId = asWorkspaceId("00000000-0000-4000-8000-0000000a0001");
const thread = asWorkstreamId("00000000-0000-4000-8000-0000000a00a0");
const breakout = asSubstreamId("00000000-0000-4000-8000-0000000a00a1");
/** Starts the thread. */
const owner = asUserId("00000000-0000-4000-8000-0000000a0011");
/** Has a Mac. */
const member = asUserId("00000000-0000-4000-8000-0000000a0012");
/** Has no device. */
const bystander = asUserId("00000000-0000-4000-8000-0000000a0013");

const organization = () => hostedParentStub(env, workspaceId);
const flags = createTestEnv({ FLAGS: { getBooleanDetails: async () => ({ value: true, reason: "TARGETING_MATCH" }) } }).FLAGS!;
const pushEnv = () => ({ ...env, FLAGS: flags });

let messageSeq = 0;
function envelope(parentId: WorkstreamId, substreamId: SubstreamId, effect: ConversationEffect): ConversationEffectEnvelope {
  messageSeq += 1;
  return {
    kind: "conversation_effect",
    contractVersion: 1,
    region: "global",
    workspaceId,
    parentKind: "workstream",
    parentId,
    substreamId,
    generation: 1,
    messageId: `00000000-0000-7000-8000-${String(messageSeq).padStart(12, "0")}`,
    partitionKey: effect.kind === "directory_user" ? `user:${effect.userId}` : "common",
    sourceVersion: messageSeq,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(effect),
    effect,
  };
}

function common(title: string, extra: Partial<Extract<ConversationEffect, { kind: "directory_common" }>> = {}) {
  const now = new Date().toISOString();
  return {
    kind: "directory_common" as const,
    title,
    description: "",
    preview: "",
    scope: "workspace" as const,
    state: "running",
    systemKind: null,
    lastActivityAt: now,
    completedAt: null,
    archivedAt: null,
    createdByUserId: owner,
    latestAttentionOrdinal: 0,
    unreadTrackingStartOrdinal: 0,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

function viewer(userId: UserId) {
  return {
    kind: "directory_user" as const,
    userId,
    isParticipant: true,
    unreadCount: 0,
    youAreMentioned: false,
    listable: true,
    seenAttentionOrdinal: 0,
    manualUnreadFromOrdinal: null,
    manualUnreadGeneration: 0,
    latestMentionAttentionOrdinal: 0,
  };
}

/** Publish a conversation the way it publishes itself, through the parent step. */
async function publish(substreamId: SubstreamId, effects: ConversationEffect[]): Promise<void> {
  await organization().receiveChildEffects({
    substreamId,
    envelopes: effects.map((effect) => envelope(thread, substreamId, effect)),
  });
}

async function pushed(): Promise<Array<{ user_id: string; item_id: string }>> {
  return runInDurableObject(organization(), (_instance, state) => state.storage.sql.exec<{ user_id: string; item_id: string }>(
    `SELECT user_id, item_id FROM workspace_activity_pushes ORDER BY user_id, item_id`,
  ).toArray());
}

async function connect(userId: UserId) {
  const response = await organization().fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": workspaceId,
      "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": userId,
      "x-rally-session-id": `session-${userId}`,
      "x-rally-socket-ticket-id": "00000000-0000-7000-8001-000000000001",
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  if (response.status !== 101 || !response.webSocket) throw new Error(`workspace socket rejected: ${response.status}`);
  const socket = response.webSocket;
  socket.accept();
  const subscribed = new Promise<void>((resolve) => {
    socket.addEventListener("message", (event) => {
      if (String(event.data).includes("\"workspace_sync\"")) resolve();
    });
  });
  socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  await subscribed;
  return socket;
}

beforeEach(async () => {
  await reset();
  clearFlagTargetingAttributeCache();
  messageSeq = 0;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workstream_authority_control (id INTEGER PRIMARY KEY, phase TEXT NOT NULL,
      generation INTEGER NOT NULL, required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL)`),
    env.DB.prepare(`INSERT INTO workstream_authority_control VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, region TEXT NOT NULL, analytics_workspace_id TEXT,
      abandoned_at TEXT, placement_affinity TEXT DEFAULT 'wnam')`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, region) VALUES (?, 'Test', 'global')`).bind(workspaceId),
    env.DB.prepare(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT)`),
    env.DB.prepare(`CREATE TABLE workspace_members (access_class TEXT NOT NULL DEFAULT 'member',
      incarnation TEXT DEFAULT 'existing-member', workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
      status TEXT NOT NULL, role TEXT NOT NULL, last_seen_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (workspace_id, user_id))`),
    env.DB.prepare(`CREATE TABLE sessions (workspace_incarnation TEXT DEFAULT 'existing-member', id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, region TEXT NOT NULL, revoked_at TEXT,
      expires_at TEXT NOT NULL, impersonator_user_id TEXT)`),
    ...[[owner, "Maya"], [member, "Theo"], [bystander, "Priya"]].flatMap(([userId, name]) => [
      env.DB.prepare(`INSERT INTO users (id, email, name) VALUES (?, ?, ?)`).bind(userId, `${name}@example.test`, name),
      env.DB.prepare(`INSERT INTO workspace_members (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'member')`)
        .bind(workspaceId, userId),
      env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
        VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(`session-${userId}`, userId, workspaceId),
    ]),
    ...[migration, webPushMigration].flatMap(splitSqlStatements).map((sql) => env.DB.prepare(sql)),
  ]);
  for (const userId of [owner, member]) {
    await registerPushDevice(env, { userId, workspaceId, sessionId: `session-${userId}`, region: "global", role: "member" },
      `mac-${userId}`, {
        platform: "macos", transport: "apns", topic: "ai.rallywith.desktop", apnsEnvironment: "production",
        token: (userId === owner ? "aa" : "bb").repeat(32), appVersion: "1",
      });
  }
  await organization().initializeWorkspace(workspaceId, "wnam");
  await runInDurableObject(organization(), (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO parent_metadata
      (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
      VALUES (?, 'workstream', ?, 'global', 1, 0, 0)`, thread, workspaceId);
    state.storage.sql.exec(`INSERT INTO parent_children (parent_id, substream_id, kind, created_by_user_id, created_at, title)
      VALUES (?, '0', 'main', ?, 0, 'Main'), (?, ?, 'child', ?, 1, 'Breakout')`,
    thread, owner, thread, breakout, owner);
  });
});

/** Seat `userId` in the Organization-wide Channel beside its owner. */
async function joinChannel(channelId: SpaceId, userId: UserId): Promise<void> {
  const result = await organization().noteSpaceAudience({
    workspaceId, userId: owner, spaceId: channelId, audience: { scope: "workspace", participantUserIds: [owner, userId] },
  });
  if (!result.ok) throw new Error(`noteSpaceAudience refused: ${result.code}`);
}

describe("Activity rows pushed from the directory", () => {
  it("given an Organization-wide thread somebody starts, then each other member with a device is pushed its start, once", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner)]);
    // The starter is not told of their own start, and a member with no device has nothing to receive it.
    expect(await pushed()).toEqual([{ user_id: member, item_id: `started:${thread}` }]);

    await publish(asSubstreamId("0"), [common("Q3 plan, renamed")]);
    expect(await pushed()).toEqual([{ user_id: member, item_id: `started:${thread}` }]);
  });

  it("given a thread whose start is older than pushing, when it reaches the directory, then nobody is pushed", async () => {
    const lastWeek = new Date(Date.now() - 7 * 86_400_000).toISOString();
    await publish(asSubstreamId("0"), [common("Old plan", { createdAt: lastWeek }), viewer(owner)]);
    expect(await pushed()).toEqual([]);
  });

  it("given runs finishing in a thread a member takes part in, then each finish is pushed once, and later traffic is not a finish", async () => {
    const finishes = async (userId: UserId) => (await pushed())
      .filter((row) => row.user_id === userId && row.item_id.startsWith("finished:")).length;
    await publish(asSubstreamId("0"), [common("Q3 plan", { scope: "personal" }), viewer(owner), viewer(member)]);
    const finished = () => common("Q3 plan", { scope: "personal", state: "completed", completedAt: new Date().toISOString() });
    await publish(asSubstreamId("0"), [finished()]);
    // A completed thread's finish is stamped with its latest activity, so this
    // moves the row's time without a run having happened.
    await publish(asSubstreamId("0"), [{ ...finished(), preview: "a later message" }]);
    expect([await finishes(member), await finishes(owner)]).toEqual([1, 1]);

    await publish(asSubstreamId("0"), [common("Q3 plan", { scope: "personal", state: "running" })]);
    await publish(asSubstreamId("0"), [finished()]);
    // Both are decided; the delivery consumer applies the cooldown only
    // after a provider has accepted an alert, not after these decisions.
    expect([await finishes(member), await finishes(owner)]).toEqual([2, 2]);
  });

  it("given a member with the thread open in a foreground window, when its run finishes, then they are not pushed", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan", { scope: "personal" }), viewer(owner), viewer(member)]);
    const socket = await connect(member);
    socket.send(JSON.stringify({ type: "set_presence", revision: 1, applicationState: "foreground", foregroundWorkstreamId: thread }));
    // The presence frame is not answered; a ping's auto-response arriving says it was read.
    await new Promise<void>((resolve) => {
      socket.addEventListener("message", (event) => { if (String(event.data) === "pong") resolve(); });
      socket.send("ping");
    });
    await publish(asSubstreamId("0"), [common("Q3 plan", { scope: "personal", state: "completed",
      completedAt: new Date().toISOString() })]);

    expect((await pushed()).map((row) => [row.user_id, row.item_id.split(":")[0]])).toEqual([
      [owner, "finished"],
      [member, "started"],
    ]);
    socket.close(1000, "done");
  });

  it("given a private thread whose member's viewer row lands after its start, then that member is pushed the start", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan", { scope: "personal" }), viewer(owner)]);
    expect(await pushed()).toEqual([]);

    await publish(asSubstreamId("0"), [viewer(member)]);
    expect(await pushed()).toEqual([{ user_id: member, item_id: `started:${thread}` }]);
  });

  it("given an Organization-wide breakout somebody starts, then the thread's participants are pushed its start", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan", { createdAt: new Date(Date.now() - 86_400_000).toISOString() }), viewer(owner), viewer(member)]);
    await publish(breakout, [common("Pricing"), viewer(owner)]);
    expect(await pushed()).toEqual([{ user_id: member, item_id: `started:${breakout}` }]);
  });

  it("given an Organization-wide breakout somebody starts, then a member who may list the thread but is not in it is not pushed", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan", { createdAt: new Date(Date.now() - 86_400_000).toISOString() }), viewer(owner)]);
    await publish(breakout, [common("Pricing"), viewer(owner)]);
    expect(await pushed()).toEqual([]);
  });
});

describe("sending an Activity row's push", () => {
  const payloads = (send: { mock: { calls: unknown[][] } }) => send.mock.calls.map((call) => call[2] as PushPayloads);
  const message = (activityItemId: string) => ({ region: "global" as const, workspaceId, recipientUserId: member, activityItemId });

  it("reads as the sidebar row does and opens the thread", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner)]);
    const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));

    expect(await deliverPush(pushEnv(), message(`started:${thread}`), send)).toBe(true);

    const apns = JSON.parse(payloads(send)[0]!.apns) as { aps: { alert: { title: string } }; rally: { kind: string; url: string } };
    expect(apns.aps.alert.title).toBe("Maya started Q3 plan");
    expect(apns.rally.kind).toBe("thread_started");
    expect(apns.rally.url).toContain(`/workstreams/${thread}`);
  });

  it("still sends a finish whose time later traffic moved before it was sent", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan", { scope: "personal" }), viewer(owner), viewer(member)]);
    await publish(asSubstreamId("0"), [common("Q3 plan", { scope: "personal", state: "completed",
      completedAt: new Date().toISOString() })]);
    const queued = (await pushed()).find((row) => row.user_id === member && row.item_id.startsWith("finished:"))!.item_id;
    // A parent stamps a completed thread's finish with its latest activity.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await publish(asSubstreamId("0"), [{ ...common("Q3 plan", { scope: "personal", state: "completed",
      completedAt: new Date().toISOString() }), preview: "a later message" }]);
    const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));

    expect(await deliverPush(pushEnv(), message(queued), send)).toBe(true);
    expect(JSON.parse(payloads(send)[0]!.apns).aps.alert.title).toBe("Rally finished Q3 plan");
  });

  it("sends nothing once the person has opened what the row names", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner)]);
    await organization().recordActivityEvents({
      workspaceId, userId: member, events: [{ kind: "read", subject: { kind: "thread", threadId: thread }, through: 0 }],
    });
    const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));

    expect(await deliverPush(pushEnv(), message(`started:${thread}`), send)).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("a breakout merged into its thread", () => {
  const mergeEventId = "00000000-0000-7000-8000-0000000a0e01";

  /** The merge message's activity event, as the thread's conversation writes it. */
  function mergeEvent(): ConversationEffect {
    const messageId = "00000000-0000-7000-8000-0000000a0e02";
    return {
      kind: "activity_event",
      eventId: mergeEventId,
      eventType: "workstream_message_created",
      subjectSequenceNumber: 5,
      actorType: "user",
      actorUserId: owner,
      actorLabel: "Maya",
      title: "Q3 plan",
      body: "Sequence B is approved.",
      canonicalUrl: null,
      digestible: true,
      occurredAt: new Date().toISOString(),
      sourceKind: "workstream_message",
      sourceId: messageId,
      dedupeKey: `message:${messageId}`,
      metadata: { substreamId: "0", attentionOrdinal: 5, mergedFrom: { breakoutId: breakout, title: "Sequence B" } },
      targets: [],
    } as ConversationEffect;
  }

  it("given a merge message in a thread somebody else is in, then they are pushed it once, worded as the sidebar row", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner), viewer(member)]);
    const before = await pushed();
    await publish(asSubstreamId("0"), [mergeEvent()]);
    await publish(asSubstreamId("0"), [{ ...common("Q3 plan"), preview: "later traffic" }]);

    const merges = (await pushed()).filter((row) => !before.some((earlier) => earlier.item_id === row.item_id && earlier.user_id === row.user_id));
    expect(merges).toEqual([{ user_id: member, item_id: `merged:${mergeEventId}` }]);

    const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));
    expect(await deliverPush(pushEnv(), { region: "global", workspaceId, recipientUserId: member, activityItemId: `merged:${mergeEventId}` }, send)).toBe(true);
    const calls = (send as { mock: { calls: unknown[][] } }).mock.calls;
    const apns = JSON.parse((calls[0]![2] as PushPayloads).apns) as { aps: { alert: { title: string } }; rally: { kind: string; url: string } };
    expect(apns.aps.alert.title).toBe("Maya merged Sequence B into Q3 plan");
    expect(apns.rally.kind).toBe("merged");
    expect(apns.rally.url).toContain(`/workstreams/${thread}`);
    expect(apns.rally.url).not.toContain(breakout);
  });

  it("given a merge message in an Organization-wide thread, then a member who may list it but is not in it is not pushed", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner)]);
    const before = await pushed();
    await publish(asSubstreamId("0"), [mergeEvent()]);

    expect((await pushed()).filter((row) => !before.some((earlier) => earlier.item_id === row.item_id && earlier.user_id === row.user_id)))
      .toEqual([]);
  });
});

describe("news in an Organization-wide Channel", () => {
  it("given a thread started in a Channel, then its participants are pushed the start and a member in neither the Channel nor the thread is not", async () => {
    const reserved = await organization().reserveSpace({ workspaceId, userId: owner,
      space: { name: "GTM", iconKey: "briefcase", colorKey: "blue", scope: "workspace" } });
    if (!reserved.ok) throw new Error(`reserveSpace refused: ${reserved.code}`);
    const channelId = asSpaceId(reserved.space.id);
    await joinChannel(channelId, bystander);
    await registerPushDevice(env, { userId: bystander, workspaceId, sessionId: `session-${bystander}`, region: "global", role: "member" },
      `mac-${bystander}`, {
        platform: "macos", transport: "apns", topic: "ai.rallywith.desktop", apnsEnvironment: "production",
        token: "cc".repeat(32), appVersion: "1",
      });
    // Placed before its start is decided, as a thread born in a Channel is.
    await placeMembership(organization(), { workspaceId, userId: owner, spaceId: channelId, workstreamId: thread });
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner)]);

    expect(await pushed()).toEqual([{ user_id: bystander, item_id: `started:${thread}` }]);
  });
});

describe("a private thread merged into its Channel", () => {
  it("given a merge from a thread a member cannot open, then they are pushed it, worded and linked as the Channel's, never naming the thread", async () => {
    // Only Maya is in the thread.
    await publish(asSubstreamId("0"), [common("Comp bands", { scope: "personal" }), viewer(owner)]);
    const reserved = await organization().reserveSpace({ workspaceId, userId: owner,
      space: { name: "GTM", iconKey: "briefcase", colorKey: "blue", scope: "workspace" } });
    if (!reserved.ok) throw new Error(`reserveSpace refused: ${reserved.code}`);
    const channelId = asSpaceId(reserved.space.id);
    await placeMembership(organization(), { workspaceId, userId: owner, spaceId: channelId, workstreamId: thread });
    await joinChannel(channelId, member);
    const before = await pushed();

    const merged = await organization().mergeThreadIntoChannel({
      auth: { sessionId: `session-${owner}`, userId: owner, workspaceId, region: "global", role: "member" },
      workstreamId: thread, spaceId: null, body: "Bands are set.", embeds: [], operationId: "op-private",
    });
    expect(merged).toMatchObject({ ok: true, spaceId: channelId });

    const merges = (await pushed()).filter((row) => !before.some((earlier) => earlier.item_id === row.item_id && earlier.user_id === row.user_id));
    expect(merges.map((row) => row.user_id)).toEqual([member]);

    const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));
    expect(await deliverPush(pushEnv(), { region: "global", workspaceId, recipientUserId: member, activityItemId: merges[0]!.item_id }, send)).toBe(true);
    const calls = (send as { mock: { calls: unknown[][] } }).mock.calls;
    const apns = JSON.parse((calls[0]![2] as PushPayloads).apns) as { aps: { alert: { title: string } }; rally: { url: string } };
    expect(apns.aps.alert.title).toBe("Maya merged a private thread into GTM");
    expect(apns.rally.url).not.toContain("Comp bands");
    expect(apns.rally.url).toContain("/s/");
    expect(apns.rally.url).not.toContain("/c/");
  });
});

describe("how each person chose to hear about each kind", () => {
  const choose = (userId: UserId, notify: Partial<NotificationChannels>) =>
    organization().saveMemberPreferences({ workspaceId, userId, preferences: { notify } });
  /** Whether sending this row's push reaches a device. */
  const sends = async (userId: UserId, activityItemId: string) => {
    const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));
    await deliverPush(pushEnv(), { region: "global", workspaceId, recipientUserId: userId, activityItemId }, send);
    return send.mock.calls.length > 0;
  };
  /** Senders that record instead of reaching Resend or Slack, which cannot run here. */
  const senders = () => ({
    email: vi.fn<(env: unknown, input: unknown) => Promise<"sent">>(async () => "sent"),
    slack: vi.fn<(env: unknown, input: unknown) => Promise<"sent">>(async () => "sent"),
  });

  it("given a member who chose no channel for new threads, then a start is not sent to them, and choosing push again sends nothing late", async () => {
    await choose(member, { newThreads: [] });
    await publish(asSubstreamId("0"), [common("Q3 plan", { scope: "personal" }), viewer(owner), viewer(member)]);
    expect(await sends(member, `started:${thread}`)).toBe(false);
    // Decided once, whatever they chose, so a later batch about the same
    // conversation does not queue the old start again.
    expect(await pushed()).toEqual([{ user_id: member, item_id: `started:${thread}` }]);

    await choose(member, { newThreads: ["push"] });
    await publish(asSubstreamId("0"), [viewer(member)]);
    expect(await pushed()).toEqual([{ user_id: member, item_id: `started:${thread}` }]);
  });

  it("given a member with no device who chose email for new threads, then a start is decided for them and sent by email", async () => {
    await choose(bystander, { newThreads: ["email"] });
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner)]);
    expect(await pushed()).toEqual([
      { user_id: member, item_id: `started:${thread}` },
      { user_id: bystander, item_id: `started:${thread}` },
    ]);

    const sent = senders();
    expect(await deliverPush(pushEnv(), { region: "global", workspaceId, recipientUserId: bystander,
      activityItemId: `started:${thread}`, channel: "email" }, undefined, undefined, sent)).toBe(true);
    expect(sent.email).toHaveBeenCalledOnce();
    expect(sent.email.mock.calls[0]![1]).toMatchObject({
      recipientEmail: "Priya@example.test", title: "Maya started Q3 plan", workspaceName: "Test",
    });
    expect(sent.slack).not.toHaveBeenCalled();
  });

  it("given an email queued before the member stopped choosing email, then nothing is sent", async () => {
    await choose(bystander, { newThreads: ["email"] });
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner)]);
    await choose(bystander, { newThreads: [] });

    const sent = senders();
    expect(await deliverPush(pushEnv(), { region: "global", workspaceId, recipientUserId: bystander,
      activityItemId: `started:${thread}`, channel: "email" }, undefined, undefined, sent)).toBe(true);
    expect(sent.email).not.toHaveBeenCalled();
  });

  it("given a save from a client that knows no channels, then the kinds already set are kept", async () => {
    await choose(member, { mentions: ["email"] });
    const saved = await organization().saveMemberPreferences({ workspaceId, userId: member, preferences: { showAgentWork: false } });
    expect(saved.notify).toEqual({ ...DEFAULT_NOTIFICATION_CHANNELS, mentions: ["email"] });
    expect(saved.push).toEqual({ ...DEFAULT_PUSH_PREFERENCES, mentions: false });
  });

  it("given an older client turning one push switch off, then only push leaves that kind and the rest is kept", async () => {
    await organization().saveMemberPreferences({ workspaceId, userId: member, preferences: { showAgentWork: false } });
    expect(await organization().saveMemberPreferences({ workspaceId, userId: member, preferences: { push: { added: false } } }))
      .toEqual({
        showAgentWork: false,
        push: { ...DEFAULT_PUSH_PREFERENCES, added: false },
        notify: { ...DEFAULT_NOTIFICATION_CHANNELS, added: ["slack_agent_dm"] },
      });
  });
});

/** Human traffic without an @mention: participant replies must still reach Activity. */
describe("human reply activity", () => {
  const first = "00000000-0000-7000-8000-0000000a0f01";
  const second = "00000000-0000-7000-8000-0000000a0f02";
  function reply(eventId: string, ordinal: number, text: string): ConversationEffect {
    return {
      kind: "activity_event", eventId, eventType: "workstream_message_created",
      subjectSequenceNumber: ordinal, actorType: "user", actorUserId: owner, actorLabel: "Maya",
      title: "Q3 plan", body: text, canonicalUrl: null, digestible: true,
      occurredAt: new Date(Date.now() + ordinal).toISOString(), sourceKind: "workstream_message", sourceId: eventId,
      dedupeKey: `message:${eventId}`, metadata: { substreamId: "0", attentionOrdinal: ordinal }, targets: [],
    };
  }
  async function activity(userId = member) {
    const result = await organization().listActivity({ workspaceId, userId, cursor: null, only: null });
    if (!result.ok) throw new Error(result.code);
    return result.page.items.filter((item) => item.kind === "new_message");
  }
  async function expireCooldown() {
    await runInDurableObject(organization(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE workspace_activity_pushes SET pushed_at = pushed_at - 120001`);
      state.storage.sql.exec(`UPDATE workspace_activity_alerts SET alerted_at = alerted_at - 120001`);
    });
  }

  it("shows unmentioned replies to participants, excludes the author and bystanders, and batches their push onto the latest reply", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner), viewer(member)]);
    await publish(asSubstreamId("0"), [reply(first, 1, "First draft")]);
    // No production APNs credentials in workerd: seed the successful enqueue
    // receipt, then exercise the production batching predicate on real SQL.
    await runInDurableObject(organization(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE workspace_activity_pushes SET delivery_enqueued = 1 WHERE item_id = ?`, `message:${first}`);
    });
    await publish(asSubstreamId("0"), [reply(second, 2, "Need advil?")]);
    expect(await activity()).toMatchObject([{ id: `message:${second}`, preview: "Need advil?", unread: true, unreadMessageCount: 2 }]);
    expect(await activity(owner)).toEqual([]);
    expect(await activity(bystander)).toEqual([]);
    expect((await pushed()).filter((row) => row.item_id.startsWith("message:")))
      .toEqual([{ user_id: member, item_id: `message:${first}` }]);
    const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));
    await deliverPush(pushEnv(), { region: "global", workspaceId, recipientUserId: member, activityItemId: `message:${first}` }, send);
    const calls = (send as { mock: { calls: unknown[][] } }).mock.calls;
    expect(JSON.parse((calls[0]![2] as PushPayloads).apns).aps.alert)
      .toEqual({ title: "Maya replied in Q3 plan", body: "Need advil?" });
  });

  it("keeps a reply unread while an earlier message is visible, then cancels delivery once the reply is read", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner), viewer(member)]);
    await publish(asSubstreamId("0"), [reply(first, 5, "Please review")]);
    const read = (through: number) => organization().recordActivityEvents({
      workspaceId, userId: member, events: [{ kind: "read", subject: { kind: "thread", threadId: thread }, through }],
    });
    await read(4);
    expect(await activity()).toMatchObject([{ unread: true, unreadMessageCount: 1 }]);
    await read(5);
    expect(await activity()).toMatchObject([{ unread: false, unreadMessageCount: 0 }]);
    const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));
    await deliverPush(pushEnv(), { region: "global", workspaceId, recipientUserId: member, activityItemId: `message:${first}` }, send);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps reply activity when alerts are disabled, then withdraws it when participation ends", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner), viewer(member)]);
    await publish(asSubstreamId("0"), [reply(first, 1, "First draft")]);
    await organization().saveMemberPreferences({ workspaceId, userId: member, preferences: { notify: { newMessages: [] } } });
    expect(await activity()).toMatchObject([{ unread: true }]);
    const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));
    await deliverPush(pushEnv(), { region: "global", workspaceId, recipientUserId: member, activityItemId: `message:${first}` }, send);
    expect(send).not.toHaveBeenCalled();
    await publish(asSubstreamId("0"), [{ ...viewer(member), isParticipant: false }]);
    expect(await activity()).toEqual([]);
  });

  it("leaves an explicit mention on its own immediate path instead of duplicating it as a reply alert", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner), viewer(member)]);
    const event = reply(first, 1, "Please review");
    if (event.kind !== "activity_event") throw new Error("expected activity event");
    await publish(asSubstreamId("0"), [{ ...event, targets: [{ userId: member, relation: "mentioned" }] }]);
    expect(await activity()).toMatchObject([{ unread: true, unreadMessageCount: 1 }]);
    expect((await pushed()).filter((row) => row.item_id.startsWith("message:"))).toEqual([]);
  });

  it("does not send an opening reply already covered by an invitation, but sends later replies", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner), viewer(member)]);
    const opening = reply(first, 1, "Opening message");
    if (opening.kind !== "activity_event") throw new Error("expected activity event");
    const added: ConversationEffect = { ...opening, eventId: "00000000-0000-7000-8000-0000000a0f03",
      eventType: "workstream_participant_added", sourceKind: "workstream_participant", dedupeKey: "added:opening",
      targets: [{ userId: member, relation: "added" }] };
    await publish(asSubstreamId("0"), [added, opening]);
    expect((await pushed()).filter((row) => row.item_id.startsWith("message:"))).toEqual([]);
    const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));
    await deliverPush(pushEnv(), { region: "global", workspaceId, recipientUserId: member, activityItemId: `message:${first}` }, send);
    expect(send).not.toHaveBeenCalled();
    await publish(asSubstreamId("0"), [reply(second, 2, "A later reply")]);
    await deliverPush(pushEnv(), { region: "global", workspaceId, recipientUserId: member, activityItemId: `message:${second}` }, send);
    expect(send).toHaveBeenCalledTimes(1);
    const calls = (send as { mock: { calls: unknown[][] } }).mock.calls;
    const payload = JSON.parse((calls[0]![2] as PushPayloads).apns) as { rally: { kind: string; url: string }; aps: { alert: { title: string } } };
    expect(payload.rally.kind).toBe("mention");
    expect(payload.rally.url).toContain(thread);
    expect(payload.aps.alert.title).toBe("Maya replied in Q3 plan");
  });

  it("does not forward empty breakout participant-add rows into the shared log", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner)]);
    await publish(breakout, [common("Private"), viewer(owner), viewer(member)]);
    const event = reply(first, 1, "Invitation");
    if (event.kind !== "activity_event") throw new Error("expected activity event");
    await publish(breakout, [{ ...event, eventType: "workstream_participant_added", targets: [{ userId: member, relation: "added" }] }]);
    const rows = await runInDurableObject(organization(), (_instance, state) =>
      state.storage.sql.exec(`SELECT event_id FROM workspace_activity_events WHERE event_id = ?`, first).toArray());
    expect(rows).toEqual([]);
  });

  it("seeks only participating conversation history, independent of unrelated organization traffic", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner)]);
    await publish(asSubstreamId("0"), [reply(first, 6, "Relevant")]);
    await publish(asSubstreamId("0"), [{ ...viewer(member), seenAttentionOrdinal: 5 }]);
    await runInDurableObject(organization(), (instance, state) => {
      const internals = instance as unknown as { spaceStorage(): WorkspaceSpaceStorage };
      const reads = (): number => {
        const cursors: Array<{ rowsRead: number }> = [];
        // Instrument the real runtime cursor, without substituting SQL or storage.
        const sql = new Proxy(state.storage.sql, { get(target, key) {
          if (key !== "exec") return Reflect.get(target, key, target);
          return (...args: unknown[]) => {
            const cursor = Reflect.apply(target.exec, target, args);
            if (String(args[0]).includes("latest_replies AS")) cursors.push(cursor);
            return cursor;
          };
        } });
        const storage = new Proxy(state.storage, { get(target, key) { return key === "sql" ? sql : Reflect.get(target, key, target); } });
        const feed = new WorkspaceActivityFeed(storage, internals.spaceStorage());
        const page = feed.page({ userId: member, accessClass: "member" }, null);
        if (page === "invalid_cursor") throw new Error("unexpected cursor error");
        expect(page.items.filter((item) => item.kind === "new_message")).toMatchObject([{ unreadMessageCount: 1 }]);
        expect(cursors).toHaveLength(1);
        return cursors[0]!.rowsRead;
      };
      const before = reads();
      // History in another conversation the recipient does not participate in.
      for (let i = 0; i < 500; i++) state.storage.sql.exec(`INSERT INTO workspace_activity_events (
        event_id, event_type, subject_type, subject_id, actor_type, actor_user_id, actor_label, title, body,
        audience_kind, audience_workstream_id, digestible, occurred_at, created_at, source_kind, dedupe_key, metadata_json
      ) VALUES (?, 'workstream_message_created', 'workstream', 'unrelated', 'user', ?, 'Other', 'Other', '',
        'workstream', 'unrelated', 0, 1, 1, 'workstream_message', ?, '{"substreamId":"0","attentionOrdinal":1}')`, `unrelated:${i}`, owner, `unrelated:${i}`);
      // Latest and unread seeks may each inspect one terminal index entry.
      // Add already-read messages to the participating conversation too:
      // the unread ordinal range must skip those rather than scan them.
      for (let i = 0; i < 500; i++) state.storage.sql.exec(`INSERT INTO workspace_activity_events (
        event_id, event_type, subject_type, subject_id, actor_type, actor_user_id, actor_label, title, body,
        audience_kind, audience_workstream_id, digestible, occurred_at, created_at, source_kind, dedupe_key, metadata_json
      ) VALUES (?, 'workstream_message_created', 'workstream', ?, 'user', ?, 'Maya', 'Q3 plan', '',
        'workstream', ?, 0, 1, 1, 'workstream_message', ?, '{"substreamId":"0","attentionOrdinal":1}')`, `read:${i}`, thread, owner, thread, `read:${i}`);
      expect(reads()).toBeLessThanOrEqual(before + 2);
    });
  });

  it("bounds reply-batch lookups independently of old decision receipts", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner), viewer(member)]);
    await publish(asSubstreamId("0"), [reply(first, 1, "Relevant")]);
    const item = (await activity())[0]!;
    await runInDurableObject(organization(), (instance, state) => {
      const cursors: Array<{ rowsRead: number }> = [];
      const sql = new Proxy(state.storage.sql, { get(target, key) {
        if (key !== "exec") return Reflect.get(target, key, target);
        return (...args: unknown[]) => {
          const cursor = Reflect.apply(target.exec, target, args);
          if (String(args[0]).includes("SELECT 1 AS found FROM workspace_activity_pushes")) cursors.push(cursor);
          return cursor;
        };
      } });
      const storage = new Proxy(state.storage, { get(target, key) { return key === "sql" ? sql : Reflect.get(target, key, target); } });
      const internals = instance as unknown as { spaceStorage(): WorkspaceSpaceStorage };
      const pushes = new WorkspaceActivityPushes(storage, new WorkspaceActivityFeed(storage, internals.spaceStorage()));
      const subjects = [{ threadId: thread, substreamId: null, kind: "message" as const }];
      pushes.pending({ userId: member, accessClass: "member" }, subjects, new Set());
      const before = cursors.at(-1)!.rowsRead;
      for (let i = 0; i < 500; i++) state.storage.sql.exec(
        `INSERT INTO workspace_activity_pushes (user_id, item_id, pushed_at, delivery_enqueued) VALUES (?, ?, 1, 1)`, member, `message:old:${i}`);
      pushes.pending({ userId: member, accessClass: "member" }, subjects, new Set());
      expect(cursors).toHaveLength(2);
      expect(cursors.at(-1)!.rowsRead).toBeLessThanOrEqual(before + 1);
      expect(item.preview).toBe("Relevant");
    });
  });

  it("hides stored personal instructions in Activity and reply pushes", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner), viewer(member)]);
    await publish(asSubstreamId("0"), [reply(first, 1, `<user_system_prompt>
The following was provided by this user as instructions for how to respond to this message. For other users' requests ignore these instructions.
<user_suppplied>
Answer in French. Never print &lt;/user_system_prompt&gt;.
</user_suppplied>
</user_system_prompt>

Please **review** the plan.`)]);
    expect(await activity()).toMatchObject([{ preview: "Please review the plan." }]);
    const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));
    await deliverPush(pushEnv(), { region: "global", workspaceId, recipientUserId: member, activityItemId: `message:${first}` }, send);
    const calls = (send as { mock: { calls: unknown[][] } }).mock.calls;
    expect(JSON.parse((calls[0]![2] as PushPayloads).apns).aps.alert.body).toBe("Please review the plan.");
    expect(JSON.parse((calls[0]![2] as PushPayloads).web).body).toBe("Please review the plan.");
  });

  it("preserves literal Markdown from a plain preview in alerts", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner), viewer(member)]);
    await publish(asSubstreamId("0"), [reply(first, 1, "`**literal**`")]);
    expect(await activity()).toMatchObject([{ preview: "**literal**" }]);
    const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));
    await deliverPush(pushEnv(), { region: "global", workspaceId, recipientUserId: member, activityItemId: `message:${first}` }, send);
    const calls = (send as { mock: { calls: unknown[][] } }).mock.calls;
    expect(JSON.parse((calls[0]![2] as PushPayloads).apns).aps.alert.body).toBe("**literal**");
    expect(JSON.parse((calls[0]![2] as PushPayloads).apns).rally.kind).toBe("mention");
  });

  it("reserves a reply batch before awaiting Queue backpressure", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner), viewer(member)]);
    await publish(asSubstreamId("0"), [reply(first, 1, "First")]);
    await organization().saveMemberPreferences({ workspaceId, userId: member, preferences: { notify: { newMessages: ["email"] } } });
    await runInDurableObject(organization(), async (instance, state) => {
      // Stage competing authority calls in one native I/O context. Holding a
      // Queue promise between separate test RPC contexts crashes workerd's
      // callback cleanup; storage and the producer below remain real.
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      let sends = 0;
      const target = instance as unknown as { pushActivity(workspaceId: string, subjects: Array<{ threadId: string; substreamId: null; kind: "message" }>): Promise<void> };
      const prototype = Object.getPrototypeOf(env.PUSH_DELIVERY_QUEUE) as {
        send(body: unknown, options?: QueueSendOptions): Promise<void>;
      };
      const original = prototype.send;
      const queued = vi.spyOn(prototype, "send").mockImplementation(async function (this: typeof prototype, body, options) {
        if (typeof body === "object" && body !== null && "activityItemId" in body) {
          sends++;
          if (sends === 1) { entered(); await held; }
        }
        return original.call(this, body, options);
      });
      state.storage.sql.exec(`DELETE FROM workspace_activity_pushes WHERE item_id = ?`, `message:${first}`);
      const sending = target.pushActivity(workspaceId, [{ threadId: thread, substreamId: null, kind: "message" }]);
      try {
        await started;
        state.storage.sql.exec(`INSERT INTO workspace_activity_events (
          event_id, event_type, subject_type, subject_id, actor_type, actor_user_id, actor_label, title, body,
          audience_kind, audience_workstream_id, digestible, occurred_at, created_at, source_kind, dedupe_key, metadata_json
        ) VALUES (?, 'workstream_message_created', 'workstream', ?, 'user', ?, 'Maya', 'Q3 plan', 'Second',
          'workstream', ?, 0, ?, ?, 'workstream_message', ?, '{"substreamId":"0","attentionOrdinal":2}')`,
          second, thread, owner, thread, Date.now(), Date.now(), `message:${second}`);
        await target.pushActivity(workspaceId, [{ threadId: thread, substreamId: null, kind: "message" }]);
        expect(state.storage.sql.exec<{ item_id: string }>(
          `SELECT item_id FROM workspace_activity_pushes WHERE item_id LIKE 'message:%' ORDER BY item_id`,
        ).toArray()).toEqual([]);
        expect(sends).toBe(1);
      } finally { release(); await sending; queued.mockRestore(); }
      expect(state.storage.sql.exec<{ item_id: string }>(
        `SELECT item_id FROM workspace_activity_pushes WHERE item_id LIKE 'message:%' ORDER BY item_id`,
      ).toArray()).toEqual([{ item_id: `message:${first}` }]);
    });
  });

  it("releases a failed enqueue reservation so the pending reply can be retried", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner), viewer(member)]);
    await publish(asSubstreamId("0"), [reply(first, 1, "First")]);
    await organization().saveMemberPreferences({ workspaceId, userId: member, preferences: { notify: { newMessages: ["email"] } } });
    await runInDurableObject(organization(), async (instance, state) => {
      const target = instance as unknown as { pushActivity(workspaceId: string, subjects: Array<{ threadId: string; substreamId: null; kind: "message" }>): Promise<void> };
      state.storage.sql.exec(`DELETE FROM workspace_activity_pushes WHERE item_id = ?`, `message:${first}`);
      const prototype = Object.getPrototypeOf(env.PUSH_DELIVERY_QUEUE) as { send(body: unknown, options?: QueueSendOptions): Promise<void> };
      const original = prototype.send;
      const unavailable = vi.spyOn(prototype, "send").mockImplementation(async function (this: typeof prototype, body, options) {
        if (typeof body === "object" && body !== null && "activityItemId" in body) throw new Error("queue_unavailable");
        return original.call(this, body, options);
      });
      try {
        await expect(target.pushActivity(workspaceId, [{ threadId: thread, substreamId: null, kind: "message" }])).rejects.toThrow("queue_unavailable");
        expect(state.storage.sql.exec(`SELECT item_id FROM workspace_activity_pushes WHERE item_id = ?`, `message:${first}`).toArray()).toEqual([]);
      } finally { unavailable.mockRestore(); }
      await target.pushActivity(workspaceId, [{ threadId: thread, substreamId: null, kind: "message" }]);
      expect(state.storage.sql.exec<{ delivery_enqueued: number }>(`SELECT delivery_enqueued FROM workspace_activity_pushes WHERE item_id = ?`, `message:${first}`).one())
        .toEqual({ delivery_enqueued: 1 });
    });
  });

  it("keeps a failed Queue handoff in the durable follow-up until its retry succeeds", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner), viewer(member)]);
    await organization().saveMemberPreferences({ workspaceId, userId: member, preferences: { notify: { newMessages: ["email"] } } });
    const input = { substreamId: asSubstreamId("0"), envelopes: [envelope(thread, asSubstreamId("0"), reply(first, 1, "Retry me"))] };
    await runInDurableObject(organization(), async (instance, state) => {
      const target = instance as unknown as { receiveChildEffects(input: unknown): Promise<unknown>; runDirectoryFollowUps(ids: number[]): Promise<void> };
      const prototype = Object.getPrototypeOf(env.PUSH_DELIVERY_QUEUE) as { send(body: unknown, options?: QueueSendOptions): Promise<void> };
      const original = prototype.send;
      const unavailable = vi.spyOn(prototype, "send").mockImplementation(async function (this: typeof prototype, body, options) {
        if (typeof body === "object" && body !== null && "activityItemId" in body) throw new Error("queue_unavailable");
        return original.call(this, body, options);
      });
      try { await target.receiveChildEffects(input); } finally { unavailable.mockRestore(); }
      const pending = state.storage.sql.exec<{ id: number }>(`SELECT id FROM workspace_directory_followups
        WHERE state = 'pending' AND json_array_length(json_extract(followup_json, '$.activityPushSubjects')) > 0`).toArray();
      expect(pending.length).toBeGreaterThan(0);
      expect(state.storage.sql.exec(`SELECT item_id FROM workspace_activity_pushes WHERE item_id = ?`, `message:${first}`).toArray()).toEqual([]);
      await target.runDirectoryFollowUps(pending.map((row) => row.id));
      expect(state.storage.sql.exec(`SELECT delivery_enqueued FROM workspace_activity_pushes WHERE item_id = ?`, `message:${first}`).one())
        .toEqual({ delivery_enqueued: 1 });
      expect(state.storage.sql.exec(`SELECT id FROM workspace_directory_followups WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(pending.map((row) => row.id))).toArray()).toEqual([]);
    });
  });

  it.each(["sent", "transient"] as const)("serializes concurrent consumers and releases a %s provider handoff", async (outcome) => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner), viewer(member)]);
    await publish(asSubstreamId("0"), [reply(first, 1, "First")]);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));
    send.mockImplementationOnce(async () => { entered(); await held; return { outcome }; });
    const delivery = deliverPush(pushEnv(), { region: "global", workspaceId, recipientUserId: member, activityItemId: `message:${first}` }, send);
    await started;
    const next = { region: "global" as const, workspaceId, recipientUserId: member, activityItemId: `message:${second}` };
    try {
      await publish(asSubstreamId("0"), [reply(second, 2, "Second")]);
      expect(await deliverPush(pushEnv(), next, send)).toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
    } finally { release(); }
    expect(await delivery).toBe(outcome === "sent");
    expect(await deliverPush(pushEnv(), next, send)).toBe(true);
    expect(send).toHaveBeenCalledTimes(outcome === "sent" ? 1 : 2);
  });

  it("recovers expired delivery claims and fences a stale consumer's release", async () => {
    const claim = { workspaceId, userId: member, threadId: thread, substreamId: null, itemId: `message:${first}`,
      channel: "push" as const, claimId: crypto.randomUUID() };
    const newer = { ...claim, claimId: crypto.randomUUID() };
    const third = { ...claim, claimId: crypto.randomUUID() };
    expect(await organization().claimActivityAlert(claim)).toBe("claimed");
    expect(await organization().claimActivityAlert(newer)).toBe("busy");
    await runInDurableObject(organization(), (_instance, state) => state.storage.sql.exec(`UPDATE workspace_activity_alert_claims SET expires_at = 0`).toArray());
    expect(await organization().claimActivityAlert(newer)).toBe("claimed");
    await organization().releaseActivityAlert(claim);
    expect(await organization().claimActivityAlert(third)).toBe("busy");
    await organization().releaseActivityAlert(newer);
    expect(await organization().claimActivityAlert(third)).toBe("claimed");
    await organization().releaseActivityAlert(third);
  });

  it("honors the initial participation read cursor before the first Activity read", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner)]);
    await publish(asSubstreamId("0"), [reply(first, 5, "History")]);
    await publish(asSubstreamId("0"), [{ ...viewer(member), seenAttentionOrdinal: 5 }]);
    expect(await activity()).toMatchObject([{ unread: false, unreadMessageCount: 0 }]);
    await publish(asSubstreamId("0"), [reply(second, 6, "After joining")]);
    expect(await activity()).toMatchObject([{ preview: "After joining", unread: true, unreadMessageCount: 1 }]);
  });

  it("keeps breakout replies private, text-free, and on their own participation read cursor", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner), viewer(member), viewer(bystander)]);
    await publish(breakout, [common("Private breakout", { scope: "personal" }), viewer(owner), viewer(member)]);
    await publish(breakout, [reply(first, 5, "Private text")]);
    expect(await activity()).toMatchObject([{ breakout: { substreamId: breakout }, preview: "", unread: true, unreadMessageCount: 1 }]);
    expect(await activity(bystander)).toEqual([]);
    // Reading the parent does not settle a breakout message.
    await publish(asSubstreamId("0"), [{ ...viewer(member), seenAttentionOrdinal: 99 }]);
    expect(await activity()).toMatchObject([{ unread: true }]);
    await publish(breakout, [{ ...viewer(bystander), seenAttentionOrdinal: 5 }]);
    expect(await activity(bystander)).toMatchObject([{ unread: false, unreadMessageCount: 0 }]);
    await runInDurableObject(organization(), (_instance, state) => {
      expect(state.storage.sql.exec<{ body: string; audience_user_id: string }>(
        `SELECT body, audience_user_id FROM workspace_activity_events WHERE event_id = ?`, first,
      ).one()).toEqual({ body: "", audience_user_id: owner });
    });
  });

  it("disabled or read-cancelled reply alerts do not suppress an enabled completion alert", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner), viewer(member)]);
    await organization().saveMemberPreferences({ workspaceId, userId: member, preferences: { notify: { newMessages: [] } } });
    await publish(asSubstreamId("0"), [reply(first, 1, "Disabled")]);
    const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));
    await deliverPush(pushEnv(), { region: "global", workspaceId, recipientUserId: member, activityItemId: `message:${first}` }, send);
    await organization().saveMemberPreferences({ workspaceId, userId: member, preferences: { notify: { newMessages: ["push"] } } });
    await publish(asSubstreamId("0"), [reply(second, 2, "Read before delivery")]);
    await organization().recordActivityEvents({ workspaceId, userId: member,
      events: [{ kind: "read", subject: { kind: "thread", threadId: thread }, through: 2 }] });
    await deliverPush(pushEnv(), { region: "global", workspaceId, recipientUserId: member, activityItemId: `message:${second}` }, send);
    expect(send).not.toHaveBeenCalled();
    await publish(asSubstreamId("0"), [common("Q3 plan", { state: "completed", completedAt: new Date(Date.now() + 10).toISOString() })]);
    const finished = (await pushed()).find((row) => row.user_id === member && row.item_id.startsWith("finished:"))!;
    await deliverPush(pushEnv(), { region: "global", workspaceId, recipientUserId: member, activityItemId: finished.item_id }, send);
    expect(send).toHaveBeenCalledOnce();
  });

  it("a disabled completion does not suppress an enabled reply alert", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner), viewer(member)]);
    await organization().saveMemberPreferences({ workspaceId, userId: member, preferences: { notify: { runFinished: [] } } });
    await publish(asSubstreamId("0"), [common("Q3 plan", { state: "completed", completedAt: new Date().toISOString() })]);
    const finished = (await pushed()).find((row) => row.user_id === member && row.item_id.startsWith("finished:"))!;
    const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));
    await deliverPush(pushEnv(), { region: "global", workspaceId, recipientUserId: member, activityItemId: finished.item_id }, send);
    expect(send).not.toHaveBeenCalled();
    await publish(asSubstreamId("0"), [reply(first, 1, "New reply")]);
    await deliverPush(pushEnv(), { region: "global", workspaceId, recipientUserId: member, activityItemId: `message:${first}` }, send);
    expect(send).toHaveBeenCalledOnce();
  });

  it("starts the shared cooldown only after an actual alert, per delivery channel", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner), viewer(member)]);
    await publish(asSubstreamId("0"), [reply(first, 1, "First")]);
    const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));
    const address = { region: "global" as const, workspaceId, recipientUserId: member };
    await deliverPush(pushEnv(), { ...address, activityItemId: `message:${first}` }, send);
    await publish(asSubstreamId("0"), [reply(second, 2, "Later")]);
    await deliverPush(pushEnv(), { ...address, activityItemId: `message:${second}` }, send);
    expect(send).toHaveBeenCalledOnce();
    // A push must not suppress an independently chosen email for the same item.
    await organization().saveMemberPreferences({ workspaceId, userId: member, preferences: { notify: { newMessages: ["push", "email"] } } });
    const email = vi.fn(async () => "sent" as const);
    await deliverPush(pushEnv(), { ...address, activityItemId: `message:${second}`, channel: "email" }, undefined, undefined,
      { email, slack: vi.fn(async () => "sent" as const) });
    expect(email).toHaveBeenCalledOnce();
    await expireCooldown();
    await deliverPush(pushEnv(), { ...address, activityItemId: `message:${second}` }, send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sends the next ordinary reply after the two-minute cooldown", async () => {
    await publish(asSubstreamId("0"), [common("Q3 plan"), viewer(owner), viewer(member)]);
    await publish(asSubstreamId("0"), [reply(first, 1, "First")]);
    await expireCooldown();
    await publish(asSubstreamId("0"), [reply(second, 2, "Later")]);
    expect((await pushed()).filter((row) => row.item_id.startsWith("message:"))).toEqual([
      { user_id: member, item_id: `message:${first}` }, { user_id: member, item_id: `message:${second}` },
    ]);
  });
});
