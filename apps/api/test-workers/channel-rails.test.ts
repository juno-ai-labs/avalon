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
import { beforeEach, describe, expect, it } from "vitest";

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
  runAsUserId?: string;
}): ParentEffectEnvelope {
  automationSeq += 1;
  const effect = {
    kind: "directory_automation" as const,
    automationId,
    authorUserId: extra.authorUserId ?? member,
    ...(extra.runAsUserId ? { runAsUserId: extra.runAsUserId } : {}),
    lifecycle: "active" as const,
    loadable: true,
    scope: extra.scope,
    owningWorkstreamId: extra.owningWorkstreamId ?? null,
    title: extra.title,
    description: `${extra.title} does things`,
    nextRunAt: null,
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
    env.DB.prepare(`CREATE TABLE sessions (workspace_incarnation TEXT DEFAULT 'existing-member', id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, region TEXT NOT NULL, revoked_at TEXT,
      expires_at TEXT NOT NULL)`),
    ...[owner, member, reader].map((userId) => env.DB.prepare(
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
  await publish(channelC, [common("Channel C"), viewer(owner, true, at)]);
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
    await setFrameLimit(new TextEncoder().encode(JSON.stringify(single)).byteLength + 40);
    const spread = await askRails(connection, { workstreamIds: [channelA, channelC] });
    expect(spread.map((frame) => [frame.rails.map((rail) => rail.workstreamId), frame.final]))
      .toEqual([[[channelA], false], [[channelC], true]]);

    // Room for Channel C's frame, which is smaller than Channel A's rail alone.
    const [small] = await askRails(connection, { workstreamIds: [channelC] });
    await setFrameLimit(new TextEncoder().encode(JSON.stringify(small)).byteLength);
    const [oversized, ...rest] = await askRails(connection, { workstreamIds: [channelA] });
    expect(rest).toEqual([]);
    expect(oversized!.rails).toEqual([]);
    expect(oversized!.oversized).toEqual([{ workstreamId: channelA, railWaterline: expect.any(Number) }]);
    expect(oversized!.final).toBe(true);
    connection.socket.close(1000, "done");
  });

  it("pages a Space's Channels a frame at a time, passing over ones the viewer cannot see", async () => {
    await runInDurableObject(organization(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO spaces
        (space_id, title, scope, authority_generation, source_version, payload_hash, revision, created_at, updated_at)
        VALUES (?, 'General', 'workspace', 1, 1, 'space', 1, 0, 0)`, spaceId);
      for (const channel of [channelA, channelB, channelC]) {
        state.storage.sql.exec(`INSERT INTO space_channel_memberships
          (space_id, workstream_id, state, generation, joined_at, updated_at)
          VALUES (?, ?, 'active', 1, 0, 0)`, spaceId, channel);
      }
    });
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

  it("advances when Main's links move, and not for an effect that only moved its preview", async () => {
    const connection = await connect(owner);
    const before = (await railOf(connection, channelA)).railWaterline;
    const quiet = connection.stream.next((frame) => frame.type === "workspace_workstream_state"
      && frame.workstreamId === channelA, "the preview row");
    await publish(channelA, [channelAMain({ preview: "Somebody said something" })]);
    expect(((await quiet).workstream as { railWaterline: number }).railWaterline).toBe(before);

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
});
