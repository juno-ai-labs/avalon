import { seedParticipantGrants } from "./helpers/hosted-parent";
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
  type SubstreamId,
  type UserId,
  type WorkstreamId,
} from "@rally/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mainAttachmentsUnreported } from "../src/durable-objects/channel-rails";
import { hostedParentStub } from "./helpers/hosted-parent";
import { type SidekickDirectoryRow, writeSidekickDirectoryRow } from "./helpers/sidekick";

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

function sidekick(automationId: string, extra: {
  title: string; scope: "personal" | "workspace" | "workstream"; owningWorkstreamId?: string; authorUserId?: string;
  runAsUserId?: string; nextRunAt?: string; lifecycle?: "active" | "deleted";
}): SidekickDirectoryRow {
  return {
    automationId,
    workspaceId,
    authorUserId: extra.authorUserId ?? member,
    ...(extra.runAsUserId ? { runAsUserId: extra.runAsUserId } : {}),
    lifecycle: extra.lifecycle ?? "active",
    loadable: true,
    scope: extra.scope,
    owningWorkstreamId: extra.owningWorkstreamId ?? null,
    title: extra.title,
    description: `${extra.title} does things`,
    nextRunAt: extra.nextRunAt ?? null,
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
let requestSeq = 0;
async function connect(userId: UserId, options: { channelsBySpace?: boolean } = {}) {
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
  if (options.channelsBySpace) socket.send(JSON.stringify({ type: "channels_by_space" }));
  socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  return { socket, stream, sync: await sync };
}

type SpaceChannelsFrame = Frame & {
  items: Array<{ id: string; privateChildren?: Array<{ substreamId: string }> }>;
  stateVersions: Array<{ workstreamId: string }>;
  rails: Rail[];
  nextAfter: string | null;
};

/** The one frame answering a `space_channels` request. */
async function askSpace(
  connection: Awaited<ReturnType<typeof connect>>,
  target: { spaceId: string; after?: string; rails: boolean },
): Promise<SpaceChannelsFrame> {
  requestSeq += 1;
  const requestId = `00000000-0000-7000-8002-${String(requestSeq).padStart(12, "0")}`;
  const answer = connection.stream.next(
    (frame) => frame.type === "workspace_space_channels" && frame.requestId === requestId,
    "space channels",
  );
  connection.socket.send(JSON.stringify({ type: "space_channels", requestId, ...target }));
  return await answer as SpaceChannelsFrame;
}

function completeSpaceBootstrap(state: DurableObjectState) {
  state.storage.sql.exec(`UPDATE space_bootstrap SET phase = 'complete' WHERE id = 1`);
}

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
  workstreamId, `00000000-0000-7000-8000-${workstreamId.slice(-12)}`, scope);
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
      expires_at TEXT NOT NULL, impersonator_user_id TEXT)`),
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
  await seedParticipantGrants(env, workspaceId, channelA, [owner, member]);
  await seedParticipantGrants(env, workspaceId, channelB, [member]);
  await seedParticipantGrants(env, workspaceId, channelC, [owner, guest]);
  await seedParticipantGrants(env, workspaceId, channelA, [member], breakoutA);
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
  ]) await writeSidekickDirectoryRow(env, automation);
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
    await writeSidekickDirectoryRow(env, sidekick(runAs, { title: "Delegated", scope: "personal", authorUserId: owner, runAsUserId: member }));
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
    // What decides whether opening the Channel asks its Main to report.
    const unreported = () => runInDurableObject(organization(), (_instance, state) =>
      mainAttachmentsUnreported(state.storage.sql, channelC));
    expect(await unreported()).toBe(true);

    const pushed = rowPast(connection, channelC, before.railWaterline);
    await publish(channelC, [common("Channel C", { sidekickAttachmentIds: [] })]);
    await pushed;
    expect((await railOf(connection, channelC)).sidekicks.attached).toEqual([]);
    expect(await unreported()).toBe(false);
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

});

describe("channel_rails for a guest, and a row that no longer parses", () => {
  it("tells a guest in the room that it owns nothing", async () => {
    await writeSidekickDirectoryRow(env, sidekick("00000000-0000-7000-8000-0000000d72c1", { title: "C's helper", scope: "workstream", owningWorkstreamId: channelC }));
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
    connection.socket.close(1000, "done");
  });

  it("lists a guest the Channel they take part in, and nothing of an Organization-wide one they are not in", async () => {
    const connection = await connect(guest);
    const sidebar = connection.sync.sidebar as { workstreams: { items: Array<{ id: string }> }; automations: { items: unknown[] } };
    // Channel A is Organization-wide; Channel C is one the guest takes part in.
    expect(sidebar.workstreams.items.map((item) => item.id)).toEqual([channelC]);
    // The Sidekick library is a member's.
    expect(sidebar.automations.items).toEqual([]);

    requestSeq += 1;
    const requestId = `00000000-0000-7000-8002-${String(requestSeq).padStart(12, "0")}`;
    const page = connection.stream.next((frame) => frame.type === "workspace_workstream_page" && frame.requestId === requestId, "page");
    connection.socket.send(JSON.stringify({ type: "list_workstreams", requestId, limit: 50, includeSystem: true }));
    expect(((await page) as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual([channelC]);

    // Somebody joins each Channel's Main: the guest is pushed Channel C's row
    // and nothing for Channel A, which a member watching does see move.
    const owners = await connect(owner);
    const ownerSawA = rowPast(owners, channelA, (await railOf(owners, channelA)).railWaterline);
    const guestSawC = rowPast(connection, channelC, (await railOf(connection, channelC)).railWaterline);
    await publish(channelA, [viewer(reader, true, "2026-09-25T12:30:00.000Z")]);
    await publish(channelC, [viewer(reader, true, "2026-09-25T12:30:00.000Z")]);
    await ownerSawA;
    await guestSawC;
    owners.socket.close(1000, "done");

    // Bringing Channel C to the foreground answers with its recency row.
    const recency = connection.stream.next((frame) => frame.type === "workspace_workstream_recency", "recency");
    connection.socket.send(JSON.stringify({
      type: "set_presence", revision: 1, applicationState: "foreground", foregroundWorkstreamId: channelC,
    }));
    expect(((await recency) as { workstream: { id: string } }).workstream.id).toBe(channelC);

    const frames = await askRails(connection, { workstreamIds: [channelA, channelC] });
    expect(frames.flatMap((frame) => frame.rails).map((rail) => rail.workstreamId)).toEqual([channelC]);
    expect(frames.flatMap((frame) => frame.unavailable)).toEqual([channelA]);
    expect(connection.stream.received.filter((frame) => frame.type === "workspace_workstream_state"
      && frame.workstreamId === channelA)).toEqual([]);
    connection.socket.close(1000, "done");
  });

  it("answers the retired Space target with one empty final frame, and keeps the socket", async () => {
    await runInDurableObject(organization(), (_instance, state) => insertSpace(state, [channelA, channelC]));
    const connection = await connect(owner);
    const answer = await askRails(connection, { spaceId, after: channelA });
    expect(answer).toHaveLength(1);
    expect(answer[0]).toMatchObject({ rails: [], oversized: [], unavailable: [], nextAfter: null, final: true });
    // Still open: a named request after it is answered.
    expect((await railOf(connection, channelA)).workstreamId).toBe(channelA);
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

describe("space_channels and the sidebar without Channel rows", () => {
  it("answers a Space with the Channel rows the viewer may see, their breakouts, and their rails", async () => {
    await runInDurableObject(organization(), (_instance, state) => insertSpace(state, [channelA, channelB, channelC]));
    const connection = await connect(member);
    const answer = await askSpace(connection, { spaceId, rails: true });
    // Channel C is Organization-wide; B is the member's own.
    expect(answer.items.map((item) => item.id)).toEqual([channelA, channelB, channelC]);
    expect(answer.stateVersions.map((version) => version.workstreamId)).toEqual([channelA, channelB, channelC]);
    expect(answer.items[0]!.privateChildren?.map((child) => child.substreamId)).toEqual([breakoutA]);
    expect(answer.rails.map((rail) => rail.workstreamId)).toEqual([channelA, channelB, channelC]);
    expect(answer.nextAfter).toBeNull();

    const bare = await askSpace(connection, { spaceId, rails: false });
    expect(bare.items).toHaveLength(3);
    expect(bare.rails).toEqual([]);
    connection.socket.close(1000, "done");

    const ownerConnection = await connect(owner);
    const owners = await askSpace(ownerConnection, { spaceId, rails: true });
    expect(owners.items.map((item) => item.id)).toEqual([channelA, channelC]);
    ownerConnection.socket.close(1000, "done");

    // A guest lists the Channel they take part in, and not the
    // Organization-wide ones beside it.
    const guestConnection = await connect(guest);
    const guests = await askSpace(guestConnection, { spaceId, rails: true });
    expect(guests.items.map((item) => item.id)).toEqual([channelC]);
    expect(guests.rails.map((rail) => rail.workstreamId)).toEqual([channelC]);
    guestConnection.socket.close(1000, "done");
  });

  it("keeps every row and leaves out the rails that do not fit beside them", async () => {
    await runInDurableObject(organization(), (_instance, state) => insertSpace(state, [channelA, channelB, channelC]));
    const connection = await connect(member);
    const bare = await askSpace(connection, { spaceId, rails: false });
    const [railA] = (await askRails(connection, { workstreamIds: [channelA] }))[0]!.rails;
    // Room for the rows and Channel A's rail, not for the next one.
    await setFrameLimit(frameBytes(bare) + frameBytes(railA) + 1);
    const answer = await askSpace(connection, { spaceId, rails: true });
    expect(answer.items).toHaveLength(3);
    expect(answer.rails.map((rail) => rail.workstreamId)).toEqual([channelA]);
    expect(frameBytes(answer)).toBeLessThanOrEqual(frameBytes(bare) + frameBytes(railA) + 1);
    connection.socket.close(1000, "done");
  });

  it("leaves a system Channel off the page, so it never fills one or becomes its cursor", async () => {
    const digest = "00000000-0000-4000-8000-0000000d7000";
    await runInDurableObject(organization(), (_instance, state) => {
      insertChannel(state, digest, "workspace");
      state.storage.sql.exec(`UPDATE channels SET system_kind = 'digest' WHERE workstream_id = ?`, digest);
      insertSpace(state, [digest, channelA, channelC]);
    });
    const connection = await connect(owner);
    const answer = await askSpace(connection, { spaceId, rails: true });
    expect(answer.items.map((item) => item.id)).toEqual([channelA, channelC]);
    expect(answer.rails.map((rail) => rail.workstreamId)).toEqual([channelA, channelC]);
    expect(answer.nextAfter).toBeNull();
    connection.socket.close(1000, "done");
  });

  it("pages a Space by id, naming as `nextAfter` only a Channel it answered", async () => {
    const hex = (prefix: string, index: number) =>
      `00000000-0000-4000-8000-0000000${prefix}${index.toString(16).padStart(4, "0")}`;
    const hidden = Array.from({ length: 260 }, (_, index) => hex("c", index));
    const shown = Array.from({ length: 260 }, (_, index) => hex("e", index));
    const connection = await connect(owner);
    await runInDurableObject(organization(), (_instance, state) => {
      for (const id of hidden) insertChannel(state, id, "personal");
      for (const id of shown) insertChannel(state, id, "workspace");
      insertSpace(state, [...hidden, channelA, channelB, channelC, ...shown]);
    });
    const visible = [channelA, channelC, ...shown];

    const first = await askSpace(connection, { spaceId, rails: false });
    expect(first.items.map((item) => item.id)).toEqual(visible.slice(0, 250));
    expect(first.nextAfter).toBe(visible[249]);
    const second = await askSpace(connection, { spaceId, after: first.nextAfter!, rails: false });
    expect(second.items.map((item) => item.id)).toEqual(visible.slice(250));
    expect(second.nextAfter).toBeNull();
    connection.socket.close(1000, "done");
  });

  it("sends a member the Spaces and no Channel rows once the Space hierarchy is whole, and a guest neither", async () => {
    await runInDurableObject(organization(), (_instance, state) => insertSpace(state, [channelA, channelB, channelC]));
    // Still opening: a Channel may sit in no Space, so the page is sent as before.
    const opening = await connect(member);
    const openingSidebar = opening.sync.sidebar as { workstreams: { items: unknown[] }; channelsBySpace?: true };
    expect(openingSidebar.channelsBySpace).toBeUndefined();
    expect(openingSidebar.workstreams.items.length).toBeGreaterThan(0);
    opening.socket.close(1000, "done");

    await runInDurableObject(organization(), (_instance, state) => completeSpaceBootstrap(state));
    const connection = await connect(member);
    const sidebar = connection.sync.sidebar as {
      workstreams: { items: unknown[]; nextCursor: string | null };
      spaces?: { active: { items: Array<{ id: string }> } };
      channelsBySpace?: true;
    };
    expect(sidebar.channelsBySpace).toBe(true);
    expect(sidebar.workstreams).toMatchObject({ items: [], nextCursor: null });
    expect(sidebar.spaces?.active.items.map((space) => space.id)).toContain(spaceId);
    connection.socket.close(1000, "done");

    // A desktop that still sends the retired `channels_by_space` is answered
    // the same way: the event is an unknown type now, and ignored.
    const retired = await connect(member, { channelsBySpace: true });
    expect((retired.sync.sidebar as { channelsBySpace?: true }).channelsBySpace).toBe(true);
    retired.socket.close(1000, "done");

    // A guest is answered the same way, with the Spaces their own Channels
    // reach: Channel C, which they take part in, puts this Space in theirs.
    const guestConnection = await connect(guest);
    const guestSidebar = guestConnection.sync.sidebar as {
      workstreams: { items: unknown[] };
      spaces?: { active: { items: Array<{ id: string; reach: string }> } };
      channelsBySpace?: true;
    };
    expect(guestSidebar.channelsBySpace).toBe(true);
    expect(guestSidebar.workstreams.items).toEqual([]);
    expect(guestSidebar.spaces?.active.items.map((space) => [space.id, space.reach])).toEqual([[spaceId, "through_channel"]]);
    guestConnection.socket.close(1000, "done");
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
    await writeSidekickDirectoryRow(env, sidekick(skRecommended, { title: "Monday brief", scope: "workspace" }));
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
    await writeSidekickDirectoryRow(env, sidekick(skOwned, {
      title: "Room helper", scope: "workstream", owningWorkstreamId: channelA, nextRunAt: "2026-09-26T09:00:00.000Z",
    }));
    expect((await railOf(connection, channelA)).railWaterline).toBe(before);

    const pushed = rowPast(connection, channelA, before);
    await writeSidekickDirectoryRow(env, sidekick(skOwned, {
      title: "Room helper, renamed", scope: "workstream", owningWorkstreamId: channelA,
    }));
    await pushed;
    expect((await railOf(connection, channelA)).sidekicks.owned).toEqual([expect.objectContaining({ name: "Room helper, renamed" })]);
    connection.socket.close(1000, "done");
  });

  it("advances when a Sidekick the room owns is added", async () => {
    const added = "00000000-0000-7000-8000-0000000d72c2";
    const connection = await connect(owner);
    const before = (await railOf(connection, channelC)).railWaterline;
    const pushed = rowPast(connection, channelC, before);
    await writeSidekickDirectoryRow(env, sidekick(added, { title: "New helper", scope: "workstream", owningWorkstreamId: channelC }));
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


describe("attached Sidekick activity", () => {
  const count = (parentId = channelA, substreamId = asSubstreamId("0"), userId = member) =>
    organization().readSidekickActivity({ workspaceId, userId, parentKind: "workstream", parentId, substreamId });

  async function sidekickEffect(id: string, substreamId: SubstreamId, state: string, extra: Partial<CommonEffect> = {}) {
    // These older rail fixtures are directory rows; import the hosted fields
    // before sending the same child effects a real hosted Sidekick receives.
    await runInDurableObject(organization(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE automation_directory SET region = 'global',
        created_at = COALESCE(created_at, 0), updated_at = COALESCE(updated_at, 0),
        current_definition_revision = COALESCE(current_definition_revision, 0),
        authority_generation = COALESCE(authority_generation, 1),
        connector_bindings_json = COALESCE(connector_bindings_json, '{}'),
        default_plugin_ids_json = COALESCE(default_plugin_ids_json, '[]'),
        activity_source_plugin_ids_json = COALESCE(activity_source_plugin_ids_json, '{}'),
        evaluator_projection_json = COALESCE(evaluator_projection_json, '[]'),
        stop_generation = COALESCE(stop_generation, 0)
        WHERE automation_id = ?`, id);
    });
    const effect = common("Helper", { state, ...extra });
    const message = { ...envelope(asWorkstreamId(id), substreamId, effect), parentKind: "automation" as const };
    await organization().receiveChildEffects({ substreamId, envelopes: [message] });
    return message;
  }

  async function run(id: string, runId: SubstreamId, trigger: "manual" | "schedule") {
    await runInDurableObject(organization(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO sidekick_runs
        (sidekick_id, run_id, occurrence_key, trigger_json, definition_revision, harness_run_id, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, 'pending', 0, 0)`, id, runId, runId, JSON.stringify({ type: trigger }), runId);
    });
    return sidekickEffect(id, runId, "running");
  }

  it("tracks setup, manual and scheduled execution, deduplicates Sidekicks and publishes start/finish", async () => {
    const connection = await connect(member);
    const initialWaterline = (connection.sync.sidebar as { automations: { waterline: number } }).automations.waterline;
    const changed = connection.stream.next((frame) => frame.type === "workspace_sidebar_list"
      && frame.list === "automations" && Number(frame.waterline) > initialWaterline, "Sidekick started");
    await runInDurableObject(organization(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE automation_directory SET lifecycle = 'draft' WHERE automation_id = ?`, skOwned);
    });
    await sidekickEffect(skOwned, asSubstreamId("0"), "running");
    await changed;
    expect(await count()).toEqual({ count: 1 });
    const manualId = asSubstreamId("00000000-0000-7000-8000-0000000d7111");
    const scheduleId = asSubstreamId("00000000-0000-7000-8000-0000000d7112");
    await runInDurableObject(organization(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE automation_directory SET lifecycle = 'active' WHERE automation_id = ?`, skOwned);
    });
    const stale = await run(skOwned, manualId, "manual");
    await run(skRecommended, scheduleId, "schedule");
    expect(await count()).toEqual({ count: 2 });
    await sidekickEffect(skOwned, asSubstreamId("0"), "completed");
    expect(await count()).toEqual({ count: 2 });
    await sidekickEffect(skOwned, manualId, "completed");
    const beforeFinish = Math.max(initialWaterline, ...connection.stream.received
      .filter((frame) => frame.type === "workspace_sidebar_list" && frame.list === "automations")
      .map((frame) => Number(frame.waterline)));
    const finished = connection.stream.next((frame) => frame.type === "workspace_sidebar_list"
      && frame.list === "automations" && Number(frame.waterline) > beforeFinish, "Sidekick finished");
    await sidekickEffect(skRecommended, scheduleId, "failed");
    await finished;
    expect(await count()).toEqual({ count: 0 });
    await organization().receiveChildEffects({ substreamId: manualId, envelopes: [stale] });
    expect(await count()).toEqual({ count: 0 });
    connection.socket.close();
  });

  it("keeps homes and loaded attachments local to the selected conversation and excludes background children", async () => {
    const localSidekick = "00000000-0000-7000-8000-0000000d7113";
    await writeSidekickDirectoryRow(env, { ...sidekick(localSidekick, {
      title: "Breakout helper", scope: "workstream", owningWorkstreamId: channelA,
    }), owningSubstreamId: breakoutA });
    await sidekickEffect(localSidekick, asSubstreamId("0"), "running");
    await sidekickEffect(skAttached, asSubstreamId("0"), "running");
    // A stale personal skill attachment is hidden by the rail's audience rule.
    await sidekickEffect(skPersonal, asSubstreamId("0"), "running");
    await sidekickEffect(skOwned, asSubstreamId("00000000-0000-7000-8000-0000000d7114"), "running", { backgroundAgent: true });
    expect(await count()).toEqual({ count: 1 });
    expect(await count(channelA, breakoutA)).toEqual({ count: 1 });
    expect(await count(channelB)).toEqual({ count: 0 });
    await organization().attachSidekickConversation({
      workspaceId, userId: member, automationId: skAttached, reference: channelB,
    });
    expect(await count(channelB)).toEqual({ count: 1 });
    await sidekickEffect(localSidekick, asSubstreamId("0"), "needs_input");
    expect(await count(channelA, breakoutA)).toEqual({ count: 0 });
    await expect(runInDurableObject(organization(), (instance) =>
      instance.readSidekickActivity({ workspaceId, userId: reader, parentKind: "workstream", parentId: channelB, substreamId: "0" }),
    )).rejects.toThrow("Conversation not found");
  });

  it("shows a Channel's attached defaults, and clears after the execution stops", async () => {
    await runInDurableObject(organization(), (_instance, state) => {
      completeSpaceBootstrap(state);
      insertSpace(state, [channelA]);
      state.storage.sql.exec(`INSERT INTO space_defaults
        (space_id, kind, target_id, state, generation, created_at, updated_at)
        VALUES (?, 'sidekick', ?, 'active', 1, 0, 0)`, spaceId, skRecommended);
    });
    const target = { workspaceId, userId: member, parentKind: "space" as const, parentId: spaceId, substreamId: "0" };
    await sidekickEffect(skRecommended, asSubstreamId("0"), "running");
    expect(await organization().readSidekickActivity(target)).toEqual({ count: 1 });
    await sidekickEffect(skRecommended, asSubstreamId("0"), "idle");
    expect(await organization().readSidekickActivity(target)).toEqual({ count: 0 });
  });
});
