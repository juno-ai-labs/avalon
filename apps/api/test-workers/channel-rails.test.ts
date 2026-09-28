/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A Channel's rail on the Organization socket: `channel_rails` answers and the
 * `railWaterline` each Channel row carries.
 *
 * Every test drives the Organization object through the RPCs production uses
 * (a conversation's effects, a recommendation, a Sidekick's directory row, a
 * runtime SQL write) and reads what a real hibernating workspace socket
 * receives. `docs/realtime-sockets.md` owns the frame and
 * `docs/hosted-conversation-parents.md` the waterline.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import {
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  conversationEffectHash,
  type ConversationEffect,
  type ConversationEffectEnvelope,
  type ParentEffectEnvelope,
  type SubstreamId,
  type UserId,
  type WorkstreamId,
} from "@rally/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hostedParentStub } from "./helpers/hosted-parent";

const workspaceId = asWorkspaceId("00000000-0000-4000-8000-0000000d7001");
/** Organization-wide; member and owner are its participants. */
const channelA = asWorkstreamId("00000000-0000-4000-8000-0000000d70a0");
/** Personal to the member. */
const channelB = asWorkstreamId("00000000-0000-4000-8000-0000000d70b0");
/** Organization-wide, and its Main has never reported attachments. */
const channelC = asWorkstreamId("00000000-0000-4000-8000-0000000d70c0");
const unknownChannel = asWorkstreamId("00000000-0000-4000-8000-0000000d70f0");
const breakoutA = asSubstreamId("00000000-0000-4000-8000-0000000d70a1");
const spaceId = "00000000-0000-4000-8000-0000000d7050";
const member = asUserId("00000000-0000-4000-8000-0000000d7011");
const owner = asUserId("00000000-0000-4000-8000-0000000d7012");
/** An Organization member who reads the Organization-wide Channels and is in none. */
const reader = asUserId("00000000-0000-4000-8000-0000000d7013");
/** A guest of the Organization, in Channel C's Main. */
const guest = asUserId("00000000-0000-4000-8000-0000000d7014");
const skOwned = "00000000-0000-4000-8000-0000000d7021";
const skRecommended = "00000000-0000-4000-8000-0000000d7022";
const skAttached = "00000000-0000-4000-8000-0000000d7023";
const skPersonal = "00000000-0000-4000-8000-0000000d7024";
const plan = "00000000-0000-4000-8000-0000000d7031";
const report = "00000000-0000-4000-8000-0000000d7032";
const unlisted = "00000000-0000-4000-8000-0000000d7033";
const breakoutOnly = "00000000-0000-4000-8000-0000000d7035";
const unlinked = "00000000-0000-4000-8000-0000000d7036";
const at = "2026-09-25T12:00:00.000Z";

const organization = () => hostedParentStub(env, workspaceId);

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

type CommonEffect = Extract<ConversationEffect, { kind: "directory_common" }>;
type Link = NonNullable<CommonEffect["resourceLinks"]>[number];
const link = (resourceId: string, relationshipType: Link["relationshipType"] = "attachment"): Link =>
  ({ resourceId, watchEnabled: false, relationshipType });

function common(title: string, extra: Partial<CommonEffect> = {}): CommonEffect {
  return {
    kind: "directory_common",
    title,
    description: "",
    preview: "",
    scope: "workspace",
    state: "idle",
    systemKind: null,
    lastActivityAt: at,
    completedAt: null,
    archivedAt: null,
    createdByUserId: owner,
    latestAttentionOrdinal: 0,
    unreadTrackingStartOrdinal: 0,
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

function viewer(userId: UserId, isParticipant: boolean, participantAddedAt: string | null = null) {
  return {
    kind: "directory_user" as const,
    userId,
    isParticipant,
    participantAddedAt,
    unreadCount: 0,
    youAreMentioned: false,
    listable: isParticipant,
    seenAttentionOrdinal: 0,
    manualUnreadFromOrdinal: null,
    manualUnreadGeneration: 0,
    latestMentionAttentionOrdinal: 0,
  };
}

async function publish(parentId: WorkstreamId, effects: ConversationEffect[], substreamId = asSubstreamId("0")) {
  await organization().receiveChildEffects({
    substreamId,
    envelopes: effects.map((effect) => envelope(parentId, substreamId, effect)),
  });
}

/** Channel A's Main as the setup leaves it; a test republishes it with one thing changed. */
const channelAMain = (extra: Partial<CommonEffect> = {}) => common("Channel A", {
  resourceLinks: [link(plan), link(report, "generated"), link(unlisted)],
  sidekickAttachmentIds: [skAttached, skPersonal],
  ...extra,
});

let automationSeq = 0;
function sidekick(automationId: string, extra: {
  title: string; scope: "personal" | "workspace" | "workstream"; owningWorkstreamId?: string; authorUserId?: string;
  runAsUserId?: string; nextRunAt?: string; lifecycle?: "active" | "deleted";
}): ParentEffectEnvelope {
  automationSeq += 1;
  const effect = {
    kind: "directory_automation" as const,
    automationId,
    authorUserId: extra.authorUserId ?? member,
    ...(extra.runAsUserId ? { runAsUserId: extra.runAsUserId } : {}),
    lifecycle: extra.lifecycle ?? "active" as const,
    loadable: true,
    scope: extra.scope,
    owningWorkstreamId: extra.owningWorkstreamId ?? null,
    title: extra.title,
    description: `${extra.title} does things`,
    nextRunAt: extra.nextRunAt ?? null,
  };
  return {
    kind: "parent_effect",
    contractVersion: 1,
    region: "global",
    workspaceId,
    parentKind: "automation",
    parentId: automationId,
    generation: 1,
    messageId: `automation-${automationSeq}`,
    partitionKey: "automation",
    sourceVersion: automationSeq,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(effect),
    effect,
  };
}

type Frame = Record<string, unknown> & { type?: string };
type Rail = {
  workstreamId: string;
  railWaterline: number;
  participantUserIds: string[];
  sidekicks: { owned: Array<{ id: string }>; recommended: Array<{ id: string; name: string }>; attached?: Array<{ id: string }> };
  resources: Array<{ id: string; title: string; direction: string; currentVersion: number }>;
};
type RailsFrame = Frame & {
  requestId: string; rails: Rail[]; oversized: Array<{ workstreamId: string }>;
  unavailable: string[]; nextAfter: string | null; final: boolean;
};

function frames(socket: WebSocket) {
  const received: Frame[] = [];
  const waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  socket.addEventListener("message", (event) => {
    received.push(String(event.data) === "pong" ? { type: "pong" } : JSON.parse(String(event.data)) as Frame);
    const frame = received.at(-1)!;
    const index = waiters.findIndex((waiter) => waiter.match(frame));
    if (index >= 0) waiters.splice(index, 1)[0]!.resolve(frame);
  });
  return {
    received,
    next(match: (frame: Frame) => boolean, label: string): Promise<Frame> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${label} arrived`)), 5_000);
        waiters.push({ match, resolve: (frame) => { clearTimeout(timer); resolve(frame); } });
      });
    },
  };
}

let ticketSeq = 0;
async function connect(userId: UserId) {
  ticketSeq += 1;
  const response = await organization().fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": workspaceId,
      "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": userId,
      "x-rally-session-id": `session-${userId}`,
      "x-rally-socket-ticket-id": `00000000-0000-7000-8001-${String(ticketSeq).padStart(12, "0")}`,
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`workspace socket rejected: ${response.status} ${await response.text()}`);
  }
  const socket = response.webSocket;
  socket.accept();
  const stream = frames(socket);
  const sync = stream.next((frame) => frame.type === "workspace_sync", "subscribe answer");
  socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  await sync;
  return { socket, stream };
}

let requestSeq = 0;
/** Every frame of one `channel_rails` answer, once its final frame has arrived. */
async function askRails(
  connection: Awaited<ReturnType<typeof connect>>,
  target: { workstreamIds: string[] } | { spaceId: string; after?: string },
): Promise<RailsFrame[]> {
  requestSeq += 1;
  const requestId = `00000000-0000-7000-8002-${String(requestSeq).padStart(12, "0")}`;
  const ours = (frame: Frame) => frame.type === "workspace_channel_rails" && frame.requestId === requestId;
  const final = connection.stream.next((frame) => ours(frame) && frame.final === true, "final rails frame");
  connection.socket.send(JSON.stringify({ type: "channel_rails", requestId, ...target }));
  await final;
  return connection.stream.received.filter(ours) as RailsFrame[];
}

async function railOf(connection: Awaited<ReturnType<typeof connect>>, workstreamId: string): Promise<Rail> {
  const [frame] = await askRails(connection, { workstreamIds: [workstreamId] });
  const rail = frame!.rails.find((item) => item.workstreamId === workstreamId);
  if (!rail) throw new Error(`no rail for ${workstreamId}: ${JSON.stringify(frame)}`);
  return rail;
}

/** The next row pushed for a Channel whose waterline passed `after`. */
function rowPast(connection: Awaited<ReturnType<typeof connect>>, workstreamId: string, after: number) {
  return connection.stream.next((frame) => frame.type === "workspace_workstream_state"
    && frame.workstreamId === workstreamId
    && ((frame.workstream as { railWaterline?: number } | null)?.railWaterline ?? -1) > after,
  `a ${workstreamId} row past rail waterline ${after}`);
}

function setFrameLimit(bytes: number) {
  return runInDurableObject(organization(), (instance) => {
    (instance as unknown as { channelRailFrameBytes: number }).channelRailFrameBytes = bytes;
  });
}

function frameBytes(frame: unknown): number {
  return new TextEncoder().encode(JSON.stringify(frame)).byteLength;
}

/** A Space holding these Channels, Organization-wide unless said otherwise. */
function insertSpace(state: DurableObjectState, channels: readonly string[]) {
  state.storage.sql.exec(`INSERT INTO spaces
    (space_id, title, scope, authority_generation, source_version, payload_hash, revision, created_at, updated_at)
    VALUES (?, 'General', 'workspace', 1, 1, 'space', 1, 0, 0)`, spaceId);
  for (const channel of channels) {
    state.storage.sql.exec(`INSERT INTO space_channel_memberships
      (space_id, workstream_id, state, generation, joined_at, updated_at)
      VALUES (?, ?, 'active', 1, 0, 0)`, spaceId, channel);
  }
}

/** A Channel row with no Main behind it, for a Space that holds many. */
function insertChannel(state: DurableObjectState, workstreamId: string, scope: "workspace" | "personal") {
  state.storage.sql.exec(`INSERT INTO parent_metadata
    (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
    VALUES (?, 'workstream', ?, 'global', 1, 0, 0)`, workstreamId, workspaceId);
  state.storage.sql.exec(`INSERT INTO channels (
    workstream_id, authority_generation, waterline, source_event_id, payload_hash,
    title, description, preview, scope, exact_state, origin_type, title_status,
    latest_attention_ordinal, unread_tracking_start_ordinal, last_activity_at,
    source_created_at, source_updated_at, projected_at
  ) VALUES (?, 1, 1, ?, 'hash', 'Channel', '', '', ?, 'idle', 'ad_hoc', 'settled', 0, 0, 100, 100, 100, 100)`,
  workstreamId, `event-${workstreamId}`, scope);
}

function insertResource(state: DurableObjectState, id: string, title: string, extra: { metadata?: string } = {}) {
  state.storage.sql.exec(`INSERT INTO resources
    (id, workspace_id, resource_type, provider, title, mime_type, metadata_json, attachment_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'text/plain', ?, 'attached', ?, ?)`,
  id, workspaceId, "document", "avalon_upload", title, extra.metadata ?? "{}", at, at);
}

beforeEach(async () => {
  await reset();
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workstream_authority_control (id INTEGER PRIMARY KEY, phase TEXT NOT NULL,
      generation INTEGER NOT NULL, required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL)`),
    env.DB.prepare(`INSERT INTO workstream_authority_control VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT,
      abandoned_at TEXT, placement_affinity TEXT DEFAULT 'wnam')`),
    env.DB.prepare(`INSERT INTO workspaces (id, region) VALUES (?, 'global')`).bind(workspaceId),
    env.DB.prepare(`CREATE TABLE workspace_members (access_class TEXT NOT NULL DEFAULT 'member',
      incarnation TEXT DEFAULT 'existing-member', workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
      status TEXT NOT NULL, role TEXT NOT NULL, last_seen_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (workspace_id, user_id))`),
    ...[owner, member, reader].map((userId) => env.DB.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'member')`,
    ).bind(workspaceId, userId)),
    env.DB.prepare(`INSERT INTO workspace_members (access_class, workspace_id, user_id, status, role)
      VALUES ('guest', ?, ?, 'active', 'member')`).bind(workspaceId, guest),
    env.DB.prepare(`CREATE TABLE sessions (workspace_incarnation TEXT DEFAULT 'existing-member', id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, region TEXT NOT NULL, revoked_at TEXT,
      expires_at TEXT NOT NULL)`),
    ...[owner, member, reader, guest].map((userId) => env.DB.prepare(
      `INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
       VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`,
    ).bind(`session-${userId}`, userId, workspaceId)),
  ]);
  await organization().initializeWorkspace(workspaceId, "wnam");
  await runInDurableObject(organization(), (_instance, state) => {
    for (const parentId of [channelA, channelB, channelC]) {
      state.storage.sql.exec(`INSERT INTO parent_metadata
        (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
        VALUES (?, 'workstream', ?, 'global', 1, 0, 0)`, parentId, workspaceId);
      state.storage.sql.exec(`INSERT INTO parent_children (parent_id, substream_id, kind, created_by_user_id, created_at, title)
        VALUES (?, '0', 'main', ?, 0, 'Main')`, parentId, member);
    }
    state.storage.sql.exec(`INSERT INTO parent_children (parent_id, substream_id, kind, created_by_user_id, created_at, title)
      VALUES (?, ?, 'child', ?, 1, 'Breakout')`, channelA, breakoutA, member);
    state.storage.sql.exec(`INSERT INTO parent_breakout_members
      (parent_id, substream_id, user_id, active, version, added_by_user_id, added_at, updated_at)
      VALUES (?, ?, ?, 1, 1, ?, 1, 1)`, channelA, breakoutA, member, member);
    insertResource(state, plan, "Plan");
    insertResource(state, report, "Report");
    insertResource(state, unlisted, "Recovery backup", { metadata: JSON.stringify({ listing: "unlisted" }) });
    insertResource(state, breakoutOnly, "Breakout draft");
    insertResource(state, unlinked, "Somebody else's file");
  });
  await publish(channelA, [
    channelAMain(),
    viewer(owner, true, "2026-09-25T10:00:00.000Z"),
    viewer(member, true, "2026-09-25T11:00:00.000Z"),
  ]);
  // A breakout's links are the breakout's, not the Channel's.
  await publish(channelA, [common("Breakout", { resourceLinks: [link(breakoutOnly)] })], breakoutA);
  await publish(channelB, [common("Channel B", { scope: "personal", sidekickAttachmentIds: [] }), viewer(member, true, at)]);
  await publish(channelC, [common("Channel C"), viewer(owner, true, at), viewer(guest, true, at)]);
  for (const automation of [
    sidekick(skOwned, { title: "Room helper", scope: "workstream", owningWorkstreamId: channelA }),
    sidekick(skRecommended, { title: "Weekly brief", scope: "workspace" }),
    sidekick(skAttached, { title: "Summarizer", scope: "workspace" }),
    sidekick(skPersonal, { title: "My own", scope: "personal", authorUserId: owner }),
  ]) await organization().applyAutomationDirectory({ workspaceId, envelope: automation });
  await organization().setSidekickRecommendation({
    workspaceId, parentId: channelA, userId: member, sidekickId: skRecommended, attached: true,
  });
});

describe("channel_rails answers", () => {
  it("lists Main's participants, the rail's Sidekicks and Main's own resources", async () => {
    const connection = await connect(member);
    const rail = await railOf(connection, channelA);

    expect(rail.participantUserIds).toEqual([member, owner]);
    expect(rail.sidekicks.owned.map((item) => item.id)).toEqual([skOwned]);
    expect(rail.sidekicks.recommended).toEqual([
      { id: skRecommended, name: "Weekly brief", description: "Weekly brief does things", available: true },
      { id: skOwned, name: "Room helper", description: "Room helper does things", available: true },
    ]);
    // Another person's personal Sidekick is not shown in an Organization-wide
    // Channel, even though Main attached it.
    expect(rail.sidekicks.attached?.map((item) => item.id)).toEqual([skAttached]);
    // Main's links in Main's order; not the unlisted capture, the breakout's
    // file or an unlinked one.
    expect(rail.resources).toEqual([
      { id: plan, title: "Plan", resourceType: "document", mimeType: "text/plain", direction: "source", currentVersion: 1 },
      { id: report, title: "Report", resourceType: "document", mimeType: "text/plain", direction: "artifact", currentVersion: 1 },
    ]);
    connection.socket.close(1000, "done");
  });

  it("shows a personal Sidekick to the person it runs as, as SidekickDO's audience does", async () => {
    const runAs = "00000000-0000-7000-8000-0000000d72f1";
    await organization().applyAutomationDirectory({ workspaceId, envelope:
      sidekick(runAs, { title: "Delegated", scope: "personal", authorUserId: owner, runAsUserId: member }) });
    await publish(channelB, [common("Channel B", { scope: "personal", sidekickAttachmentIds: [runAs] }), viewer(member, true, at)]);
    const connection = await connect(member);
    const rail = await railOf(connection, channelB);
    expect(rail.sidekicks.attached?.map((item) => item.id)).toEqual([runAs]);
    connection.socket.close(1000, "done");
  });

  it("tells a reader who is not in the room that it owns nothing, as the REST read does", async () => {
    const connection = await connect(reader);
    const rail = await railOf(connection, channelA);
    expect(rail.sidekicks.owned).toEqual([]);
    expect(rail.sidekicks.recommended.map((item) => item.id)).toEqual([skRecommended, skOwned]);
    connection.socket.close(1000, "done");
  });

  it("names a Channel the viewer cannot see, and one that does not exist, as unavailable", async () => {
    const connection = await connect(owner);
    const [frame] = await askRails(connection, { workstreamIds: [channelA, channelB, unknownChannel] });
    expect(frame!.rails.map((rail) => rail.workstreamId)).toEqual([channelA]);
    expect(frame!.unavailable).toEqual([channelB, unknownChannel]);
    expect(frame!.final).toBe(true);
    connection.socket.close(1000, "done");
  });

  it("leaves out `attached` until Main has reported its attachments", async () => {
    const connection = await connect(owner);
    const before = await railOf(connection, channelC);
    expect(before.sidekicks).not.toHaveProperty("attached");

    const pushed = rowPast(connection, channelC, before.railWaterline);
    await publish(channelC, [common("Channel C", { sidekickAttachmentIds: [] })]);
    await pushed;
    expect((await railOf(connection, channelC)).sidekicks.attached).toEqual([]);
    connection.socket.close(1000, "done");
  });

  it("spreads named Channels over frames, and names a rail too large for any frame as oversized", async () => {
    const connection = await connect(owner);
    const [single] = await askRails(connection, { workstreamIds: [channelA] });
    // Room for Channel A's whole frame and a little more, never for A and C.
    const limit = frameBytes(single) + 40;
    await setFrameLimit(limit);
    const spread = await askRails(connection, { workstreamIds: [channelA, channelC] });
    expect(spread.map((frame) => [frame.rails.map((rail) => rail.workstreamId), frame.final]))
      .toEqual([[[channelA], false], [[channelC], true]]);
    for (const frame of spread) expect(frameBytes(frame)).toBeLessThanOrEqual(limit);

    // Room for Channel C's frame, which is smaller than Channel A's rail alone.
    const [small] = await askRails(connection, { workstreamIds: [channelC] });
    const smallLimit = frameBytes(small);
    await setFrameLimit(smallLimit);
    const [oversized, ...rest] = await askRails(connection, { workstreamIds: [channelA] });
    expect(frameBytes(oversized)).toBeLessThanOrEqual(smallLimit);
    expect(rest).toEqual([]);
    expect(oversized!.rails).toEqual([]);
    expect(oversized!.oversized).toEqual([{ workstreamId: channelA, railWaterline: expect.any(Number) }]);
    expect(oversized!.final).toBe(true);
    connection.socket.close(1000, "done");
  });

  it("pages a Space's Channels a frame at a time, passing over ones the viewer cannot see", async () => {
    await runInDurableObject(organization(), (_instance, state) => insertSpace(state, [channelA, channelB, channelC]));
    const connection = await connect(owner);
    const [whole] = await askRails(connection, { spaceId });
    expect(whole!.rails.map((rail) => rail.workstreamId)).toEqual([channelA, channelC]);
    expect(whole!.nextAfter).toBeNull();

    const [single] = await askRails(connection, { workstreamIds: [channelA] });
    await setFrameLimit(new TextEncoder().encode(JSON.stringify(single)).byteLength + 40);
    const [first] = await askRails(connection, { spaceId });
    expect(first!.rails.map((rail) => rail.workstreamId)).toEqual([channelA]);
    expect(first!.nextAfter).toBe(channelA);
    const [second] = await askRails(connection, { spaceId, after: channelA });
    expect(second!.rails.map((rail) => rail.workstreamId)).toEqual([channelC]);
    expect(second!.unavailable).toEqual([]);
    expect(second!.nextAfter).toBeNull();
    connection.socket.close(1000, "done");
  });
});

describe("channel_rails for a guest, a large Space, and a row that no longer parses", () => {
  it("tells a guest in the room that it owns nothing, and answers a Space with one empty final frame", async () => {
    await organization().applyAutomationDirectory({ workspaceId, envelope:
      sidekick("00000000-0000-7000-8000-0000000d72c1", { title: "C's helper", scope: "workstream", owningWorkstreamId: channelC }) });
    await runInDurableObject(organization(), (_instance, state) => insertSpace(state, [channelA, channelC]));
    // A member in the same room is told what it owns.
    const ownerConnection = await connect(owner);
    expect((await railOf(ownerConnection, channelC)).sidekicks.owned.map((item) => item.id))
      .toEqual(["00000000-0000-7000-8000-0000000d72c1"]);
    ownerConnection.socket.close(1000, "done");

    const connection = await connect(guest);
    const rail = await railOf(connection, channelC);
    expect(rail.participantUserIds).toEqual(expect.arrayContaining([guest, owner]));
    expect(rail.sidekicks.owned).toEqual([]);
    const answer = await askRails(connection, { spaceId });
    expect(answer).toHaveLength(1);
    expect(answer[0]).toMatchObject({ rails: [], oversized: [], unavailable: [], nextAfter: null, final: true });
    connection.socket.close(1000, "done");
  });

  it("answers a Space one bounded page of the Channels the viewer may see, never naming one they cannot", async () => {
    // More hidden Channels than one page, sorted ahead of every visible one,
    // and more visible ones than one page after them.
    const hex = (prefix: string, index: number) =>
      `00000000-0000-4000-8000-0000000${prefix}${index.toString(16).padStart(4, "0")}`;
    const hidden = Array.from({ length: 260 }, (_, index) => hex("c", index));
    const shown = Array.from({ length: 260 }, (_, index) => hex("e", index));
    // Subscribed before the Space fills: the snapshot of 500 Channels is not what this is about.
    const connection = await connect(owner);
    await runInDurableObject(organization(), (_instance, state) => {
      for (const id of hidden) insertChannel(state, id, "personal");
      for (const id of shown) insertChannel(state, id, "workspace");
      insertSpace(state, [...hidden, channelA, channelB, channelC, ...shown]);
    });
    const visible = [channelA, channelC, ...shown];

    const [first, ...firstRest] = await askRails(connection, { spaceId });
    expect(firstRest).toEqual([]);
    expect(first!.rails.map((rail) => rail.workstreamId)).toEqual(visible.slice(0, 250));
    expect(first!.nextAfter).toBe(visible[249]);
    const [second] = await askRails(connection, { spaceId, after: first!.nextAfter! });
    expect(second!.rails.map((rail) => rail.workstreamId)).toEqual(visible.slice(250));
    expect(second!.nextAfter).toBeNull();

    const named = [first!, second!].flatMap((frame) => [
      ...frame.rails.map((rail) => rail.workstreamId), ...frame.unavailable, ...frame.oversized.map((item) => item.workstreamId),
      ...(frame.nextAfter ? [frame.nextAfter] : []),
    ]);
    expect(named.filter((id) => hidden.includes(id) || id === channelB)).toEqual([]);
    connection.socket.close(1000, "done");
  });

  it("finishes an answer when a stored row no longer parses: the appearance is left out, the rail named oversized", async () => {
    await runInDurableObject(organization(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE automation_directory SET appearance_json = '{"icon":7}' WHERE automation_id = ?`, skOwned);
      // A participant id the rail's schema refuses.
      state.storage.sql.exec(`INSERT INTO channel_viewers (
        workstream_id, user_id, authority_generation, waterline, source_event_id, payload_hash,
        is_participant, unread_count, you_are_mentioned, listable, seen_attention_ordinal,
        manual_unread_generation, latest_mention_attention_ordinal, projected_at
      ) VALUES (?, 'not-a-user-id', 1, 1, 'event', 'hash', 1, 0, 0, 1, 0, 0, 0, 100)`, channelC);
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const connection = await connect(owner);
    const frames = await askRails(connection, { workstreamIds: [channelA, channelC] });
    expect(frames.at(-1)!.final).toBe(true);
    const rails = frames.flatMap((frame) => frame.rails);
    expect(rails.map((rail) => rail.workstreamId)).toEqual([channelA]);
    expect(rails[0]!.sidekicks.owned).toEqual([expect.objectContaining({ id: skOwned, name: "Room helper" })]);
    expect(rails[0]!.sidekicks.owned[0]).not.toHaveProperty("appearance");
    expect(frames.flatMap((frame) => frame.oversized)).toEqual([{ workstreamId: channelC, railWaterline: expect.any(Number) }]);
    expect(logged.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry?.event === "channel_rail_invalid"))
      .toEqual([expect.objectContaining({ workstream_id: channelC, code: expect.stringMatching(/^channel_rail_invalid:participantUserIds\.\d+:/u) })]);
    logged.mockRestore();
    connection.socket.close(1000, "done");
  });
});

describe("the rail waterline", () => {
  it("advances and pushes the row when somebody joins Main", async () => {
    const connection = await connect(owner);
    const before = (await railOf(connection, channelA)).railWaterline;
    const pushed = rowPast(connection, channelA, before);
    await publish(channelA, [viewer(reader, true, "2026-09-25T12:30:00.000Z")]);
    await pushed;
    expect((await railOf(connection, channelA)).participantUserIds).toEqual([reader, member, owner]);
    connection.socket.close(1000, "done");
  });

  it("advances when Main's links move, and not for an effect that only renamed the Channel", async () => {
    const connection = await connect(owner);
    const before = (await railOf(connection, channelA)).railWaterline;
    const renamed = connection.stream.next((frame) => frame.type === "workspace_workstream_state"
      && (frame.workstream as { title?: string } | null)?.title === "Channel A, renamed", "the renamed row");
    await publish(channelA, [channelAMain({ title: "Channel A, renamed" })]);
    expect(((await renamed).workstream as { railWaterline: number }).railWaterline).toBe(before);
    expect((await railOf(connection, channelA)).railWaterline).toBe(before);

    const pushed = rowPast(connection, channelA, before);
    await publish(channelA, [channelAMain({ resourceLinks: [link(report, "generated"), link(plan)] })]);
    await pushed;
    expect((await railOf(connection, channelA)).resources.map((resource) => resource.id)).toEqual([report, plan]);
    connection.socket.close(1000, "done");
  });

  it("advances when Main reports a different attachment list", async () => {
    const connection = await connect(owner);
    const before = (await railOf(connection, channelA)).railWaterline;
    const pushed = rowPast(connection, channelA, before);
    await publish(channelA, [channelAMain({ sidekickAttachmentIds: [] })]);
    await pushed;
    expect((await railOf(connection, channelA)).sidekicks.attached).toEqual([]);
    connection.socket.close(1000, "done");
  });

  it("advances when a recommendation is withdrawn", async () => {
    const connection = await connect(owner);
    const before = (await railOf(connection, channelA)).railWaterline;
    const pushed = rowPast(connection, channelA, before);
    await organization().setSidekickRecommendation({
      workspaceId, parentId: channelA, userId: member, sidekickId: skRecommended, attached: false,
    });
    await pushed;
    expect((await railOf(connection, channelA)).sidekicks.recommended.map((item) => item.id)).toEqual([skOwned]);
    connection.socket.close(1000, "done");
  });

  it("advances when a recommended Sidekick is renamed", async () => {
    const connection = await connect(owner);
    const before = (await railOf(connection, channelA)).railWaterline;
    const pushed = rowPast(connection, channelA, before);
    await organization().applyAutomationDirectory({
      workspaceId, envelope: sidekick(skRecommended, { title: "Monday brief", scope: "workspace" }),
    });
    await pushed;
    expect((await railOf(connection, channelA)).sidekicks.recommended[0]).toMatchObject({ name: "Monday brief" });
    connection.socket.close(1000, "done");
  });

  it("advances when a listed resource is renamed through the runtime SQL port", async () => {
    const connection = await connect(owner);
    const before = (await railOf(connection, channelA)).railWaterline;
    const pushed = rowPast(connection, channelA, before);
    await organization().executeRuntimeSql({
      workspaceId,
      requestId: "00000000-0000-7000-8003-000000000001",
      statements: [{ sql: `UPDATE resources SET title = ? WHERE id = ?`, params: ["Plan, revised", plan] }],
    });
    await pushed;
    expect((await railOf(connection, channelA)).resources[0]).toMatchObject({ id: plan, title: "Plan, revised", currentVersion: 2 });
    connection.socket.close(1000, "done");
  });
  it("advances when somebody leaves Main", async () => {
    const connection = await connect(owner);
    const before = (await railOf(connection, channelA)).railWaterline;
    const pushed = rowPast(connection, channelA, before);
    await publish(channelA, [viewer(member, false)]);
    await pushed;
    expect((await railOf(connection, channelA)).participantUserIds).toEqual([owner]);
    connection.socket.close(1000, "done");
  });

  it("advances when a participant stops being a member of the Organization", async () => {
    const connection = await connect(owner);
    const before = (await railOf(connection, channelA)).railWaterline;
    const pushed = rowPast(connection, channelA, before);
    await organization().applyMemberStatus({
      workspaceId, sequence: 1_000, removed: true,
      relationship: { workspaceId, userId: member, accessClass: "member", role: "member", status: "active",
        incarnation: "existing-member", revision: 1 },
    });
    await pushed;
    expect((await railOf(connection, channelA)).participantUserIds).toEqual([owner]);
    connection.socket.close(1000, "done");
  });

  it("advances when the Channel's scope changes", async () => {
    const connection = await connect(owner);
    const before = (await railOf(connection, channelA)).railWaterline;
    const pushed = rowPast(connection, channelA, before);
    await publish(channelA, [channelAMain({ scope: "personal" })]);
    await pushed;
    connection.socket.close(1000, "done");
  });

  it("advances when an owned Sidekick is renamed, and not when only its next run moved", async () => {
    const connection = await connect(owner);
    const before = (await railOf(connection, channelA)).railWaterline;
    await organization().applyAutomationDirectory({ workspaceId, envelope: sidekick(skOwned, {
      title: "Room helper", scope: "workstream", owningWorkstreamId: channelA, nextRunAt: "2026-09-26T09:00:00.000Z",
    }) });
    expect((await railOf(connection, channelA)).railWaterline).toBe(before);

    const pushed = rowPast(connection, channelA, before);
    await organization().applyAutomationDirectory({ workspaceId, envelope: sidekick(skOwned, {
      title: "Room helper, renamed", scope: "workstream", owningWorkstreamId: channelA,
    }) });
    await pushed;
    expect((await railOf(connection, channelA)).sidekicks.owned).toEqual([expect.objectContaining({ name: "Room helper, renamed" })]);
    connection.socket.close(1000, "done");
  });

  it("advances when a Sidekick the room owns is added", async () => {
    const added = "00000000-0000-7000-8000-0000000d72c2";
    const connection = await connect(owner);
    const before = (await railOf(connection, channelC)).railWaterline;
    const pushed = rowPast(connection, channelC, before);
    await organization().applyAutomationDirectory({ workspaceId, envelope:
      sidekick(added, { title: "New helper", scope: "workstream", owningWorkstreamId: channelC }) });
    await pushed;
    expect((await railOf(connection, channelC)).sidekicks.recommended.map((item) => item.id)).toEqual([added]);
    connection.socket.close(1000, "done");
  });

  it("advances when a resource Main already links arrives", async () => {
    const late = "00000000-0000-4000-8000-0000000d7037";
    await publish(channelA, [channelAMain({ resourceLinks: [link(plan), link(report, "generated"), link(unlisted), link(late)] })]);
    const connection = await connect(owner);
    const before = (await railOf(connection, channelA)).railWaterline;
    const pushed = rowPast(connection, channelA, before);
    await organization().executeRuntimeSql({
      workspaceId,
      requestId: "00000000-0000-7000-8003-000000000002",
      statements: [{
        sql: `INSERT INTO resources (id, workspace_id, resource_type, provider, title, mime_type, metadata_json,
          attachment_status, created_at, updated_at) VALUES (?, ?, 'document', 'avalon_upload', 'Late', 'text/plain', '{}', 'attached', ?, ?)`,
        params: [late, workspaceId, at, at],
      }],
    });
    await pushed;
    expect((await railOf(connection, channelA)).resources.map((resource) => resource.id)).toEqual([plan, report, late]);
    connection.socket.close(1000, "done");
  });

  it("advances when a listed resource becomes unlisted", async () => {
    const connection = await connect(owner);
    const before = (await railOf(connection, channelA)).railWaterline;
    const pushed = rowPast(connection, channelA, before);
    await organization().executeRuntimeSql({
      workspaceId,
      requestId: "00000000-0000-7000-8003-000000000003",
      statements: [{
        sql: `UPDATE resources SET metadata_json = json_set(metadata_json, '$.listing', 'unlisted') WHERE id = ?`,
        params: [plan],
      }],
    });
    await pushed;
    expect((await railOf(connection, channelA)).resources.map((resource) => resource.id)).toEqual([report]);
    connection.socket.close(1000, "done");
  });
});
