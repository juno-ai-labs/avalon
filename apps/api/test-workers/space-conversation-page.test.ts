/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The Space dashboard's list, on real workerd.
 *
 * What this suite is about is the *page*: which conversations a Space answers
 * with for one person, in what order, and how a breakout's own projection gets
 * there. Every part of that needs the runtime. The forwarding is a Channel
 * parent, hosted in the real WorkspaceDO, applying its breakout projection to
 * the Organization's own breakout tables; the idempotency is that parent's
 * receipt table and the directory's waterline; the visibility, the ordering
 * and the cursor are SQL over storage a double could only describe back to
 * itself.
 *
 * The case that matters most is the last one. The page's filter and
 * `conversationNeedsViewer` in `@rally/contracts` are one decision written
 * twice — once in SQL, where the page is made, and once in TypeScript, where
 * the desktop draws — and the SQL is the authority. Nothing in the type system
 * makes them agree. This does, by walking every combination of the four inputs
 * and asserting the answers match.
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
  conversationNeedsViewer,
  HarnessStatusSchema,
  WorkspaceSocketSyncEventSchema,
  WorkspaceSpaceConversationsEventSchema,
  WorkspaceWorkstreamStateEventSchema,
  type HarnessStatus,
  type SpaceId,
  type UserId,
  type WorkstreamAppearance,
  type WorkstreamId,
} from "@rally/contracts";
import {
  ConversationEffectEnvelopeSchema,
  conversationEffectHash,
  ParentEffectEnvelopeSchema,
  type ConversationEffect,
  type ParentEffect,
} from "@rally/contracts/conversation-effects";

import {
  SPACE_CHANNEL_PAGE_SIZE,
  WorkspaceSpaceStorage,
} from "../src/durable-objects/workspace-space-storage";
import {
  consumeEffectBodies,
  deliverParentEffects,
  pendingParentEffects,
} from "./helpers/conversation-effects";
import { hostedParentStub } from "./helpers/hosted-parent";
import { placeMembership } from "./helpers/space-membership";

/** Its own workspace id: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000d100");
const OWNER = asUserId("00000000-0000-7000-8000-00000000d101");
const MEMBER = asUserId("00000000-0000-7000-8000-00000000d102");
const GUEST = asUserId("00000000-0000-7000-8000-00000000d108");
const CHANNEL_A = asWorkstreamId("00000000-0000-7000-8000-00000000d103");
const CHANNEL_B = asWorkstreamId("00000000-0000-7000-8000-00000000d104");
const PRIVATE_CHANNEL = asWorkstreamId("00000000-0000-7000-8000-00000000d105");
const BREAKOUT_ONE = asSubstreamId("00000000-0000-7000-8000-00000000d106");
const BREAKOUT_TWO = asSubstreamId("00000000-0000-7000-8000-00000000d107");

/** The Organization object, which also hosts every Channel parent in it. */
const workspace = () => hostedParentStub(env, WORKSPACE_ID);

let effectSequence = 0;

/** A UUIDv7, which the workspace handoff requires of a directory effect. */
function messageId(): string {
  effectSequence += 1;
  return `00000000-0000-7000-8000-${String(effectSequence).padStart(10, "0")}d1`;
}

async function establishWorkspace(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT, abandoned_at TEXT
    )`),
    // `access_class` is load-bearing: every Space RPC refuses a guest, and a
    // fixture without the column proves the membership check and not that one.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      incarnation TEXT DEFAULT 'existing-member',
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT, access_class TEXT NOT NULL DEFAULT 'member',
      last_seen_at TEXT, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (workspace_id, user_id)
    )`),
    // The dashboard nudge is a socket message and nothing else, so this suite
    // opens real workspace sockets — which authenticate against this table.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      workspace_incarnation TEXT DEFAULT 'existing-member',
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, revoked_at TEXT, expires_at TEXT NOT NULL,
      impersonator_user_id TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_control (
      id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
      VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`INSERT OR REPLACE INTO workspaces(id, region) VALUES (?, 'global')`)
      .bind(WORKSPACE_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role, access_class) VALUES (?, ?, 'active', 'owner', 'member')`)
      .bind(WORKSPACE_ID, OWNER),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role, access_class) VALUES (?, ?, 'active', 'member', 'member')`)
      .bind(WORKSPACE_ID, MEMBER),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role, access_class) VALUES (?, ?, 'active', NULL, 'guest')`)
      .bind(WORKSPACE_ID, GUEST),
    env.DB.prepare(`INSERT OR REPLACE INTO sessions
      (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(`dashboard-session-${OWNER}`, OWNER, WORKSPACE_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO sessions
      (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(`dashboard-session-${MEMBER}`, MEMBER, WORKSPACE_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO sessions
      (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(`dashboard-session-${GUEST}`, GUEST, WORKSPACE_ID),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
}

interface ChannelState {
  appearance?: WorkstreamAppearance;
  description?: string;
  scope?: "personal" | "workspace";
  state?: string;
  lastActivityAt?: string;
  archivedAt?: string | null;
  latestAttentionOrdinal?: number;
}

function channelCommonEffect(title: string, overrides: ChannelState = {}): ParentEffect {
  return {
    kind: "directory_common",
    ...(overrides.appearance ? { appearance: overrides.appearance } : {}),
    title,
    description: overrides.description ?? "",
    preview: "",
    scope: overrides.scope ?? "workspace",
    state: overrides.state ?? "idle",
    systemKind: null,
    lastActivityAt: overrides.lastActivityAt ?? "2026-09-19T00:00:00.000Z",
    completedAt: null,
    archivedAt: overrides.archivedAt ?? null,
    createdByUserId: OWNER,
    latestAttentionOrdinal: overrides.latestAttentionOrdinal ?? 0,
    unreadTrackingStartOrdinal: 0,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    resourceLinks: [],
  };
}

interface ViewerState {
  isParticipant?: boolean;
  unreadCount?: number;
  youAreMentioned?: boolean;
  unseen?: boolean;
  listable?: boolean;
  seenAttentionOrdinal?: number;
  manualUnreadFromOrdinal?: number | null;
  latestMentionAttentionOrdinal?: number;
}

function viewerEffect(userId: UserId, overrides: ViewerState = {}): ParentEffect {
  return {
    kind: "directory_user",
    userId,
    isParticipant: overrides.isParticipant ?? true,
    participantAddedAt: "2026-09-19T00:00:00.000Z",
    unreadCount: overrides.unreadCount ?? 0,
    youAreMentioned: overrides.youAreMentioned ?? false,
    unseen: overrides.unseen ?? false,
    listable: overrides.listable ?? true,
    seenAttentionOrdinal: overrides.seenAttentionOrdinal ?? 0,
    manualUnreadFromOrdinal: overrides.manualUnreadFromOrdinal ?? null,
    manualUnreadGeneration: 0,
    latestMentionAttentionOrdinal: overrides.latestMentionAttentionOrdinal ?? 0,
  };
}

/** One Channel's own projection, straight at the workspace handoff. */
async function publishChannel(
  workstreamId: WorkstreamId,
  effects: readonly ParentEffect[],
  sourceVersion = 1,
): Promise<void> {
  await workspace().applyWorkstreamDirectoryEffects({
    workspaceId: WORKSPACE_ID,
    envelopes: effects.map((effect) => ParentEffectEnvelopeSchema.parse({
      kind: "parent_effect",
      contractVersion: 1,
      region: "global",
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: workstreamId,
      generation: 1,
      messageId: messageId(),
      partitionKey: effect.kind === "directory_user" ? `user:${effect.userId}` : "common",
      sourceVersion,
      requiredProjectionVersion: null,
      payloadHash: conversationEffectHash(effect),
      effect,
    })),
  });
}

function breakoutCommonEffect(title: string, overrides: {
  appearance?: WorkstreamAppearance;
  state?: string;
  scope?: "personal" | "workspace";
  lastActivityAt?: string;
  archivedAt?: string | null;
  latestAttentionOrdinal?: number;
} = {}): Extract<ConversationEffect, { kind: "directory_common" }> {
  return {
    kind: "directory_common",
    ...(overrides.appearance ? { appearance: overrides.appearance } : {}),
    title,
    description: "",
    preview: "",
    scope: overrides.scope ?? "personal",
    state: overrides.state ?? "needs_input",
    systemKind: null,
    lastActivityAt: overrides.lastActivityAt ?? "2026-09-19T10:00:00.000Z",
    completedAt: null,
    archivedAt: overrides.archivedAt ?? null,
    latestAttentionOrdinal: overrides.latestAttentionOrdinal ?? 0,
    unreadTrackingStartOrdinal: 0,
  };
}

function childEnvelope(
  workstreamId: WorkstreamId,
  substreamId: string,
  effect: ConversationEffect,
  sourceVersion: number,
  generation = 1,
) {
  return ConversationEffectEnvelopeSchema.parse({
    kind: "conversation_effect",
    contractVersion: 1,
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: "workstream",
    parentId: workstreamId,
    substreamId,
    generation,
    messageId: crypto.randomUUID(),
    partitionKey: `${effect.kind}:${substreamId}`,
    sourceVersion,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(effect),
    effect,
  });
}

/**
 * One breakout's projection, forwarded by its Channel the way production
 * forwards one.
 *
 * Deliberately not written straight at the directory: what is under test in
 * the first case is the *forward*, which is a decision the Channel parent
 * makes, and a hand-written envelope would have proved the receiving half
 * twice and the sending half not at all. The directory half is applied inside
 * the Organization object straight after the parent write; delivering the
 * parent outbox afterwards only sends what still leaves on the Queue.
 */
async function publishBreakout(
  workstreamId: WorkstreamId,
  substreamId: string,
  effects: readonly ConversationEffect[],
  sourceVersion = 1,
  generation = 1,
): Promise<void> {
  await workspace().receiveChildEffects({
    substreamId,
    envelopes: effects.map((effect) => (
      childEnvelope(workstreamId, substreamId, effect, sourceVersion, generation)
    )),
  });
  await deliverParentEffects(env, workspace());
}

/** Feed the page's WorkspaceDO authority without racing the parent's alarm. */
async function publishBreakoutProjection(
  workstreamId: WorkstreamId,
  substreamId: string,
  effects: readonly ConversationEffect[],
  sourceVersion = 1,
): Promise<void> {
  await workspace().applyWorkstreamDirectoryEffects({
    workspaceId: WORKSPACE_ID,
    envelopes: effects.map((effect) => ParentEffectEnvelopeSchema.parse({
      kind: "parent_effect",
      contractVersion: 1,
      region: "global",
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: workstreamId,
      substreamId,
      generation: 1,
      messageId: messageId(),
      partitionKey: effect.kind === "directory_user" ? `user:${effect.userId}` : "common",
      sourceVersion,
      requiredProjectionVersion: null,
      payloadHash: conversationEffectHash(effect),
      effect,
    })),
  });
}

/**
 * Advance a Channel parent's authority generation, the way an authority
 * transfer or an object restore does.
 *
 * Written straight into `parent_metadata` because what is under test is
 * what the *Organization* does with the projections that follow, and driving a
 * real transfer would be several objects' worth of setup for one number.
 */
async function advanceChannelGeneration(
  workstreamId: WorkstreamId,
  generation: number,
): Promise<void> {
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE parent_metadata SET authority_generation = ? WHERE parent_id = ?",
      generation,
      workstreamId,
    );
  });
}

/** The identity row every effect path on a Channel parent reads its address from. */
async function openChannelObject(workstreamId: WorkstreamId): Promise<void> {
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO parent_metadata
         (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
       VALUES (?, 'workstream', ?, 'global', 1, 1, 1)`,
      workstreamId,
      WORKSPACE_ID,
    );
    state.storage.sql.exec(
      `INSERT INTO parent_children
         (parent_id, substream_id, kind, created_by_user_id, created_at, status, updated_at)
       VALUES (?, '0', 'main', ?, 1, 'ready', 1)`,
      workstreamId,
      OWNER,
    );
  });
}

async function reserve(name: string): Promise<SpaceId> {
  const result = await workspace().reserveSpace({
    workspaceId: WORKSPACE_ID,
    userId: OWNER,
    space: { name, iconKey: "briefcase", colorKey: "blue", scope: "workspace" },
  });
  if (!result.ok) throw new Error(`reserveSpace refused: ${result.code}`);
  return asSpaceId(result.space.id);
}

async function place(spaceId: SpaceId, workstreamId: WorkstreamId): Promise<void> {
  await placeMembership(workspace(), { workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, workstreamId });
}

async function page(spaceId: SpaceId, userId: UserId, cursor: string | null = null, options: { kind?: "channel" | "breakout"; needsViewerOnly?: boolean } = {}) {
  const result = await workspace().listSpaceChannels({
    workspaceId: WORKSPACE_ID, userId, spaceId, cursor, ...options,
  });
  if (!result.ok) throw new Error(`listSpaceChannels refused: ${result.code}`);
  return result.page;
}

let ticketSequence = 0;

/**
 * A subscribed workspace socket, with every dashboard nudge it is sent
 * recorded in arrival order.
 *
 * The socket is the whole point: the signal this suite is about is *only* a
 * socket message — nothing durable is written for it — so a test that read it
 * back through an RPC would be asserting on a thing that does not exist. This
 * is the production delivery path, opened the way `space-authority.test.ts`
 * opens one.
 */
async function connectViewer(userId: UserId): Promise<{
  channelUpdates: number[];
  initialChannelCounts: number[];
  initialSpaceCounts: number[];
  nudgeCounts: number[][];
  nudges: string[][];
}> {
  ticketSequence += 1;
  const response = await workspace().fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": WORKSPACE_ID,
      "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": userId,
      "x-rally-session-id": `dashboard-session-${userId}`,
      "x-rally-socket-ticket-id":
        `00000000-0000-7000-8000-${String(ticketSequence).padStart(12, "0")}`,
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`workspace socket rejected: ${response.status} ${await response.text()}`);
  }
  const socket = response.webSocket;
  socket.accept();
  const nudges: string[][] = [];
  const nudgeCounts: number[][] = [];
  const channelUpdates: number[] = [];
  const initialChannelCounts: number[] = [];
  const initialSpaceCounts: number[] = [];
  const subscribed = new Promise<void>((resolve) => {
    socket.addEventListener("message", (event) => {
      const data = JSON.parse(String(event.data)) as unknown;
      const nudge = WorkspaceSpaceConversationsEventSchema.safeParse(data);
      if (nudge.success) {
        nudges.push([...nudge.data.spaceIds]);
        nudgeCounts.push(nudge.data.attentionCounts.map((entry) => entry.count));
        return;
      }
      const workstreamState = WorkspaceWorkstreamStateEventSchema.safeParse(data);
      if (workstreamState.success) {
        if (workstreamState.data.workstream) {
          channelUpdates.push(workstreamState.data.workstream.breakoutAttentionCount ?? 0);
        }
        return;
      }
      const sync = WorkspaceSocketSyncEventSchema.safeParse(data);
      if (sync.success) {
        initialChannelCounts.push(...(sync.data.sidebar?.workstreams.items ?? [])
          .map((item) => item.breakoutAttentionCount ?? 0));
        initialSpaceCounts.push(...(sync.data.sidebar?.spaces?.active.items ?? [])
          .map((item) => item.attentionCount ?? 0));
        resolve();
      }
    });
  });
  socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  await subscribed;
  return { channelUpdates, initialChannelCounts, initialSpaceCounts, nudgeCounts, nudges };
}

/** A subscribed workspace socket and every frame it is sent, parsed. */
async function connectRaw(userId: UserId): Promise<{ socket: WebSocket; frames: unknown[] }> {
  ticketSequence += 1;
  const response = await workspace().fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": WORKSPACE_ID,
      "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": userId,
      "x-rally-session-id": `dashboard-session-${userId}`,
      "x-rally-socket-ticket-id":
        `00000000-0000-7000-8000-${String(ticketSequence).padStart(12, "0")}`,
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`workspace socket rejected: ${response.status} ${await response.text()}`);
  }
  const socket = response.webSocket;
  socket.accept();
  const frames: unknown[] = [];
  socket.addEventListener("message", (event) => { frames.push(JSON.parse(String(event.data))); });
  socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  await vi.waitFor(() => {
    expect(frames.some((frame) => WorkspaceSocketSyncEventSchema.safeParse(frame).success)).toBe(true);
  }, { timeout: 5_000 });
  return { socket, frames };
}

function inspect(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
  return workspace().runInspectionSql({ sql, bindings: [] });
}

function breakoutRows(): Promise<{ rows: Record<string, unknown>[] }> {
  return inspect(`SELECT workstream_id, substream_id, title, exact_state
                    FROM breakouts ORDER BY substream_id`);
}

beforeEach(async () => {
  await reset();
  effectSequence = 0;
  await establishWorkspace();
});

describe("space dashboard conversation page", () => {
  it("lists settled conversations by kind without widening member or guest visibility", async () => {
    const spaceId = await reserve("Complete directory");
    await openChannelObject(CHANNEL_A);
    await publishChannel(CHANNEL_A, [channelCommonEffect("Settled thread", { state: "idle" }), viewerEffect(OWNER)]);
    await place(spaceId, CHANNEL_A);
    await publishBreakout(CHANNEL_A, BREAKOUT_ONE, [
      breakoutCommonEffect("Owner's settled breakout", { state: "idle" }), viewerEffect(OWNER) as ConversationEffect,
    ]);
    await publishBreakout(CHANNEL_A, BREAKOUT_TWO, [
      breakoutCommonEffect("Shared settled breakout", { state: "idle" }),
      viewerEffect(MEMBER) as ConversationEffect, viewerEffect(GUEST) as ConversationEffect,
    ]);
    expect((await page(spaceId, OWNER)).items).toEqual([]);
    expect((await page(spaceId, OWNER, null, { kind: "channel", needsViewerOnly: false })).items.map((item) => item.title)).toEqual(["Settled thread"]);
    expect((await page(spaceId, OWNER, null, { kind: "breakout", needsViewerOnly: false })).items.map((item) => item.title)).toEqual(["Owner's settled breakout"]);
    expect((await page(spaceId, MEMBER, null, { kind: "breakout", needsViewerOnly: false })).items.map((item) => item.title)).toEqual(["Shared settled breakout"]);
    expect((await page(spaceId, GUEST, null, { kind: "channel", needsViewerOnly: false })).items).toEqual([]);
    expect((await page(spaceId, GUEST, null, { kind: "breakout", needsViewerOnly: false })).items.map((item) => item.title)).toEqual(["Shared settled breakout"]);
  });

  it("given a breakout projection, when its Channel forwards it, then it lands in the breakout tables", async () => {
    await openChannelObject(CHANNEL_A);

    await publishBreakout(CHANNEL_A, BREAKOUT_ONE, [
      breakoutCommonEffect("Pricing"),
      viewerEffect(OWNER) as ConversationEffect,
    ]);

    // The row is the Organization's, written from the Channel's forward, and
    // it is in the breakout tables rather than the Channel directory: a
    // breakout listed as a Channel is what a `substream_id` column on
    // `channels` would have produced the first time a
    // sidebar query forgot to filter it out.
    expect(await breakoutRows()).toMatchObject({
      rows: [{ workstream_id: CHANNEL_A, substream_id: BREAKOUT_ONE, title: "Pricing", exact_state: "needs_input" }],
    });
    await expect(inspect("SELECT workstream_id FROM channels"))
      .resolves.toMatchObject({ rows: [] });
    await expect(inspect("SELECT user_id, listable FROM breakout_viewers"))
      .resolves.toMatchObject({ rows: [{ user_id: OWNER, listable: 1 }] });
  });

  it("given the same projection redelivered, when the Queue delivers it again, then it is acked and changes nothing", async () => {
    const spaceId = await reserve("Hiring");
    await openChannelObject(CHANNEL_A);
    await publishChannel(CHANNEL_A, [channelCommonEffect("Roadmap"), viewerEffect(OWNER)]);
    await place(spaceId, CHANNEL_A);

    // The breakout's projection as the Queue carries it to the Organization
    // object that hosts its Channel. The directory half no longer crosses a
    // Queue of its own, so this child effect is the one message whose
    // redelivery reaches the breakout row; the same bytes are delivered twice,
    // rather than a second projection that happens to look like it.
    const queued = [childEnvelope(CHANNEL_A, BREAKOUT_ONE, breakoutCommonEffect("Pricing"), 1)];
    expect(await consumeEffectBodies(env, queued)).toEqual({ acked: 1, retried: 0 });

    const after = await breakoutRows();
    expect(after).toMatchObject({ rows: [{ substream_id: BREAKOUT_ONE, title: "Pricing" }] });

    // At-least-once is the Queue's whole contract, so this is the ordinary
    // case. It must be acknowledged (a message that fails here is retried
    // until it reaches the dead-letter queue) and it must leave the row
    // exactly as the first delivery did.
    expect(await consumeEffectBodies(env, queued)).toEqual({ acked: 1, retried: 0 });
    expect(await breakoutRows()).toEqual(after);
  });

  it("given a Channel this viewer reaches only through a Breakout, when they read the page, then it lists the Breakout and not Main", async () => {
    const spaceId = await reserve("Hiring");
    await openChannelObject(PRIVATE_CHANNEL);
    await publishChannel(PRIVATE_CHANNEL, [
      channelCommonEffect("Private Channel", { scope: "personal", state: "needs_input" }),
      viewerEffect(OWNER),
    ]);
    await place(spaceId, PRIVATE_CHANNEL);
    // The breakout is listable for both people. What decides the answer is the
    // parent Channel, which only the owner is a participant of.
    await publishBreakout(PRIVATE_CHANNEL, BREAKOUT_ONE, [
      breakoutCommonEffect("Offer letter", { lastActivityAt: "2026-09-19T11:00:00.000Z" }),
      viewerEffect(OWNER) as ConversationEffect,
      viewerEffect(MEMBER) as ConversationEffect,
    ]);

    expect((await page(spaceId, OWNER)).items.map((item) => item.title))
      .toEqual(["Offer letter", "Private Channel"]);
    // The Breakout the member opens lists its Channel, and so the Space, for
    // them; Main, which they cannot open, stays off their page.
    expect((await page(spaceId, MEMBER)).items.map((item) => item.title)).toEqual(["Offer letter"]);
    // Listing through a Breakout grants no authority to archive Main.
    expect(await workspace().archiveSpace({ workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId }))
      .toMatchObject({ ok: false, code: "space_membership_final", blockedWorkstreamIds: [PRIVATE_CHANNEL] });
    expect(await inspect("SELECT operation_id FROM space_intents")).toMatchObject({ rows: [] });
  });

  it("given a Channel this viewer reaches only through a Breakout, when their socket lists it, then it carries its name and none of Main", async () => {
    await openChannelObject(PRIVATE_CHANNEL);
    await publishChannel(PRIVATE_CHANNEL, [
      channelCommonEffect("Private Channel", {
        scope: "personal", state: "needs_input", latestAttentionOrdinal: 4, description: "Who we hire next",
      }),
      viewerEffect(OWNER),
    ]);
    await publishBreakout(PRIVATE_CHANNEL, BREAKOUT_ONE, [
      breakoutCommonEffect("Offer letter"),
      viewerEffect(OWNER) as ConversationEffect,
      viewerEffect(MEMBER) as ConversationEffect,
    ]);
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE parent_children SET resolved = 1 WHERE parent_id = ? AND substream_id = '0'", PRIVATE_CHANNEL);
    });
    const listed = async (userId: UserId) => {
      const connection = await connectRaw(userId);
      const requestId = `00000000-0000-7000-8000-0000000${userId.slice(-5)}`;
      connection.socket.send(JSON.stringify({ type: "list_workstreams", requestId, limit: 50, includeSystem: false }));
      await vi.waitFor(() => {
        expect(connection.frames.some((frame) => (frame as { requestId?: string }).requestId === requestId)).toBe(true);
      }, { timeout: 5_000 });
      const page = connection.frames.find((frame) => (frame as { requestId?: string }).requestId === requestId) as {
        items: Array<Record<string, unknown>>;
      };
      return { connection, row: page.items.find((item) => item.id === PRIVATE_CHANNEL) };
    };
    const main = ["objective", "createdByUserId", "harnessStatus", "hasUnread", "participantUserIds"] as const;
    const pick = (row: Record<string, unknown> | undefined) => Object.fromEntries(main.map((key) => [key, row?.[key]]));

    // The owner, a participant of Main, is told Main's own fields.
    const ownerRow = (await listed(OWNER)).row;
    expect(ownerRow?.mainWithheld).toBeUndefined();
    expect(ownerRow?.resolved).toBe(true);
    expect(pick(ownerRow)).toEqual({
      objective: "Who we hire next", createdByUserId: OWNER, harnessStatus: "needs_input", hasUnread: true, participantUserIds: [OWNER],
    });
    // The member is told the Channel exists, so the Breakout has a place to
    // sit, and nothing that is Main's.
    const member = await listed(MEMBER);
    expect(member.row?.title).toBe("Private Channel");
    // The row says so, so a client never has to guess before dialling Main.
    expect(member.row?.mainWithheld).toBe(true);
    expect(member.row?.resolved).toBeUndefined();
    expect(pick(member.row)).toEqual({
      objective: "", createdByUserId: null, harnessStatus: "idle", hasUnread: false, participantUserIds: [],
    });
    // Main's rail is Main's too.
    const railRequestId = "00000000-0000-7000-8000-00000000d1fd";
    member.connection.socket.send(JSON.stringify({ type: "channel_rails", requestId: railRequestId, workstreamIds: [PRIVATE_CHANNEL] }));
    await vi.waitFor(() => {
      expect(member.connection.frames.some((frame) => (frame as { requestId?: string }).requestId === railRequestId)).toBe(true);
    }, { timeout: 5_000 });
    const rails = member.connection.frames.find((frame) => (frame as { requestId?: string }).requestId === railRequestId) as { rails: unknown[]; unavailable: string[] };
    expect(rails).toMatchObject({ rails: [], unavailable: [PRIVATE_CHANNEL] });

    // Main's face pile is Main's audience. The member has the Channel in front
    // of them, and neither joins it nor is told who is in it.
    const owner = await listed(OWNER);
    const presence = (frames: unknown[]) => frames.filter((frame) => (frame as { type?: string }).type === "workspace_presence") as Array<{ userIds: string[] }>;
    member.connection.socket.send(JSON.stringify({ type: "set_presence", revision: 1, applicationState: "foreground", foregroundWorkstreamId: PRIVATE_CHANNEL }));
    await vi.waitFor(() => {
      expect(member.connection.frames.some((frame) => (frame as { type?: string }).type === "workspace_workstream_recency")).toBe(true);
    }, { timeout: 5_000 });
    owner.connection.socket.send(JSON.stringify({ type: "set_presence", revision: 1, applicationState: "foreground", foregroundWorkstreamId: PRIVATE_CHANNEL }));
    await vi.waitFor(() => { expect(presence(owner.connection.frames).length).toBeGreaterThan(0); }, { timeout: 5_000 });
    expect(presence(owner.connection.frames).flatMap((frame) => frame.userIds)).not.toContain(MEMBER);
    expect(presence(member.connection.frames)).toEqual([]);
  });

  it("given a breakout in a Channel this viewer cannot see, then that Channel is a conversation-directory candidate for them alone", async () => {
    await openChannelObject(PRIVATE_CHANNEL);
    await publishChannel(PRIVATE_CHANNEL, [
      channelCommonEffect("Private Channel", { scope: "personal" }),
      viewerEffect(OWNER),
    ]);
    await publishBreakout(PRIVATE_CHANNEL, BREAKOUT_ONE, [
      breakoutCommonEffect("Offer letter"),
      viewerEffect(OWNER) as ConversationEffect,
      viewerEffect(MEMBER) as ConversationEffect,
    ]);
    const candidates = (userId: UserId) => workspace().listScopeGrantCandidates({
      workspaceId: WORKSPACE_ID, userId, membershipIncarnation: userId, accessClass: "member",
    });
    // The member reaches the Channel only through its breakout. The owner
    // already sees the Channel, so the member directory lists it for them.
    expect(await candidates(MEMBER)).toEqual([PRIVATE_CHANNEL]);
    expect(await candidates(OWNER)).toEqual([]);
  });

  it("given a breakout whose viewer row is not listable, when that person reads the page, then it is absent", async () => {
    const spaceId = await reserve("Hiring");
    await openChannelObject(CHANNEL_A);
    await publishChannel(CHANNEL_A, [
      channelCommonEffect("Roadmap", { state: "needs_input" }),
      viewerEffect(MEMBER),
    ]);
    await place(spaceId, CHANNEL_A);
    await publishBreakout(CHANNEL_A, BREAKOUT_ONE, [
      breakoutCommonEffect("Side thread", { lastActivityAt: "2026-09-19T11:00:00.000Z" }),
      viewerEffect(OWNER, { listable: true }) as ConversationEffect,
      viewerEffect(MEMBER, { listable: false }) as ConversationEffect,
    ]);

    // Both can read the Channel — it is Organization-wide — so the only thing
    // separating the two answers is the breakout's own viewer row.
    expect((await page(spaceId, OWNER)).items.map((item) => item.title))
      .toEqual(["Side thread", "Roadmap"]);
    expect((await page(spaceId, MEMBER)).items.map((item) => item.title)).toEqual(["Roadmap"]);
  });

  it("given a viewer row a generation behind, when the page is read, then an Organization-wide breakout is still listed", async () => {
    const spaceId = await reserve("Hiring");
    await openChannelObject(CHANNEL_A);
    await publishChannel(CHANNEL_A, [
      channelCommonEffect("Roadmap"), viewerEffect(OWNER), viewerEffect(MEMBER),
    ]);
    await place(spaceId, CHANNEL_A);
    await publishBreakout(CHANNEL_A, BREAKOUT_ONE, [
      breakoutCommonEffect("Open thread", { scope: "workspace" }),
      viewerEffect(OWNER) as ConversationEffect,
      viewerEffect(MEMBER) as ConversationEffect,
    ]);
    await publishBreakout(CHANNEL_A, BREAKOUT_TWO, [
      breakoutCommonEffect("Side thread", { lastActivityAt: "2026-09-19T09:00:00.000Z" }),
      viewerEffect(OWNER) as ConversationEffect,
      viewerEffect(MEMBER) as ConversationEffect,
    ]);
    expect((await page(spaceId, MEMBER)).items.map((item) => item.title))
      .toEqual(["Open thread", "Side thread"]);

    // An authority transfer or an object restore, followed by one more message
    // in each breakout. `directory_user` effects only go out for the users an
    // update affects, so nobody's viewer row moves with them and every one of
    // them is now a generation behind the shared row.
    await advanceChannelGeneration(CHANNEL_A, 2);
    await publishBreakout(
      CHANNEL_A, BREAKOUT_ONE,
      [breakoutCommonEffect("Open thread", { scope: "workspace", lastActivityAt: "2026-09-19T12:00:00.000Z" })],
      2, 2,
    );
    await publishBreakout(
      CHANNEL_A, BREAKOUT_TWO,
      [breakoutCommonEffect("Side thread", { lastActivityAt: "2026-09-19T11:00:00.000Z" })],
      2, 2,
    );

    // The Organization-wide breakout survives it, because its own scope is
    // what grants it and no viewer row is needed to read that. Under an inner
    // join it disappeared from this person's dashboard until they happened to
    // become an affected user of some later update.
    //
    // The personal one does not, and that is the deliberate other half: with
    // no viewer row at this generation the Organization does not know whether
    // this person is a participant of a private child, and a personal Channel
    // beside it answers the same way.
    expect((await page(spaceId, MEMBER)).items.map((item) => item.title))
      .toEqual(["Open thread"]);
  });

  it("given a cursor this Space did not issue, when the page is read, then the refusal names the cursor", async () => {
    const spaceId = await reserve("Hiring");

    const refused = await workspace().listSpaceChannels({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, cursor: "not-a-cursor",
    });

    // Not `space_not_found`, which is what this used to answer. The two ask
    // opposite things of the caller — one says stop, the other says drop the
    // cursor and read the first page — and "that space no longer exists" about
    // a Space the reader is looking at is a diagnosis nobody can act on.
    expect(refused).toMatchObject({ ok: false, code: "space_cursor_invalid" });
    expect((await page(spaceId, OWNER)).items).toEqual([]);
  });

  it("given a breakout whose naming pass died, when the page is read, then its row stops claiming a name is coming", async () => {
    const spaceId = await reserve("Hiring");
    await openChannelObject(CHANNEL_A);
    await publishChannel(CHANNEL_A, [channelCommonEffect("Roadmap"), viewerEffect(OWNER)]);
    await place(spaceId, CHANNEL_A);
    await publishBreakout(CHANNEL_A, BREAKOUT_ONE, [
      {
        ...breakoutCommonEffect("Untitled", { state: "needs_input" }),
        titleStatus: "naming",
        createdAt: "2026-09-18T00:00:00.000Z",
      } as ConversationEffect,
      viewerEffect(OWNER) as ConversationEffect,
    ]);

    // `naming` is a promise that a name is on its way, and the client draws a
    // skeleton for it. Past the grace the Channel row applies, a breakout row
    // beside it in the same list has to stop making that promise too —
    // otherwise a dead naming pass leaves one row shimmering forever while the
    // Channel above it does not.
    expect((await page(spaceId, OWNER)).items[0]).toMatchObject({
      title: "Untitled",
      titleStatus: "automatic",
    });
  });

  it("given conversations of both kinds, when the page is read, then it is newest first and the cursor continues it", async () => {
    const spaceId = await reserve("Hiring");
    await openChannelObject(CHANNEL_A);
    await openChannelObject(CHANNEL_B);
    await publishChannel(CHANNEL_A, [
      channelCommonEffect("Channel A", {
        appearance: { icon: "rocket", color: "blue" },
        state: "needs_input",
        lastActivityAt: "2026-09-19T09:00:00.000Z",
      }),
      viewerEffect(OWNER),
    ]);
    await publishChannel(CHANNEL_B, [
      channelCommonEffect("Channel B", { state: "needs_input", lastActivityAt: "2026-09-19T12:00:00.000Z" }),
      viewerEffect(OWNER),
    ]);
    await place(spaceId, CHANNEL_A);
    await place(spaceId, CHANNEL_B);
    await publishBreakout(CHANNEL_A, BREAKOUT_ONE, [
      breakoutCommonEffect("Breakout at eleven", {
        appearance: { icon: "sparkles", color: "rose" },
        lastActivityAt: "2026-09-19T11:00:00.000Z",
      }),
      viewerEffect(OWNER) as ConversationEffect,
    ]);
    await publishBreakout(CHANNEL_B, BREAKOUT_TWO, [
      breakoutCommonEffect("Breakout at ten"),
      viewerEffect(OWNER) as ConversationEffect,
    ]);

    const full = await page(spaceId, OWNER);
    // One list, ordered by activity across both kinds — not Channels then
    // breakouts, and not id order, which is what the page answered before.
    expect(full.items.map((item) => [item.kind, item.title])).toEqual([
      ["channel", "Channel B"],
      ["breakout", "Breakout at eleven"],
      ["breakout", "Breakout at ten"],
      ["channel", "Channel A"],
    ]);
    // A breakout row carries its parent, its substream id and the parent's
    // title, and its own id *is* that substream id — which is what the row's
    // link is built from.
    expect(full.items[1]).toMatchObject({
      id: BREAKOUT_ONE,
      appearance: { icon: "sparkles", color: "rose" },
      breakoutOf: {
        workstreamId: CHANNEL_A,
        substreamId: BREAKOUT_ONE,
        title: "Channel A",
        appearance: { icon: "rocket", color: "blue" },
      },
    });
    expect(full.items[0]).toMatchObject({ kind: "channel", breakoutOf: null });

    // Four conversations fit in one page, so there is nothing to continue
    // from: `nextCursor` is null exactly when the answer is complete, which is
    // what stops a client asking for a page that does not exist.
    expect(full.nextCursor).toBeNull();
  });

  it("keeps Space and Channel badge totals on the dashboard's attention predicate", async () => {
    const spaceId = await reserve("Hiring");
    await openChannelObject(CHANNEL_A);
    await publishChannel(CHANNEL_A, [
      channelCommonEffect("Roadmap", { state: "needs_input" }),
      viewerEffect(OWNER),
    ]);
    await place(spaceId, CHANNEL_A);
    await publishBreakout(CHANNEL_A, BREAKOUT_ONE, [
      breakoutCommonEffect("Pricing", { state: "needs_input" }),
      viewerEffect(OWNER) as ConversationEffect,
    ]);

    const owner = await connectViewer(OWNER);
    expect(owner.initialSpaceCounts).toContain(2);
    expect(owner.initialChannelCounts).toContain(1);

    await publishBreakout(CHANNEL_A, BREAKOUT_ONE, [
      breakoutCommonEffect("Pricing", { state: "idle" }),
    ], 2);

    await vi.waitFor(() => {
      expect(owner.nudgeCounts.at(-1)).toEqual([1]);
      expect(owner.channelUpdates.at(-1)).toBe(0);
    }, { timeout: 5_000 });
  });

  it("sends a guest's workspace socket nothing of an Organization-wide Channel they are not in", async () => {
    await openChannelObject(CHANNEL_A);
    await publishChannel(CHANNEL_A, [channelCommonEffect("Org-wide roadmap"), viewerEffect(OWNER)]);
    // A pin outlives a change of relationship: somebody who pinned this
    // Channel as a member and is a guest now keeps the row.
    const spaceId = await reserve("Roadmap");
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO workspace_workstream_pins (user_id, space_id, workstream_id, position, created_at, updated_at)
         VALUES (?, ?, ?, 0, 0, 0)`,
        GUEST, spaceId, CHANNEL_A,
      );
    });

    // The member sees the Organization-public Channel; the guest, never shared
    // into it, must not, by any of the socket's three paths.
    const member = await connectRaw(MEMBER);
    const memberSync = member.frames.map((frame) => WorkspaceSocketSyncEventSchema.safeParse(frame))
      .find((parsed) => parsed.success);
    const guest = await connectRaw(GUEST);
    const guestSync = guest.frames.map((frame) => WorkspaceSocketSyncEventSchema.safeParse(frame))
      .find((parsed) => parsed.success);
    expect(memberSync?.data?.sidebar?.workstreams.items.map((item) => item.id) ?? []).toContain(CHANNEL_A);
    expect(guestSync?.data?.sidebar?.workstreams.items ?? []).toEqual([]);
    expect(guestSync?.data?.sidebar?.automations.items ?? []).toEqual([]);

    guest.socket.send(JSON.stringify({ type: "list_workstreams", requestId: "00000000-0000-7000-8000-00000000d1ff", limit: 50, includeSystem: false }));
    await vi.waitFor(() => {
      expect(guest.frames.some((frame) => (frame as { type?: string }).type === "workspace_workstream_page")).toBe(true);
    }, { timeout: 5_000 });
    const page = guest.frames.find((frame) => (frame as { type?: string }).type === "workspace_workstream_page") as { items: unknown[] };
    expect(page.items).toEqual([]);

    await publishChannel(CHANNEL_A, [channelCommonEffect("Renamed roadmap")], 2);
    await vi.waitFor(() => {
      expect(member.frames.some((frame) => {
        const state = WorkspaceWorkstreamStateEventSchema.safeParse(frame);
        return state.success && state.data.workstream?.title === "Renamed roadmap";
      })).toBe(true);
    }, { timeout: 5_000 });
    // Not a row, and not a tombstone either: its id alone names the Channel.
    expect(guest.frames.filter((frame) => WorkspaceWorkstreamStateEventSchema.safeParse(frame).success)).toEqual([]);

    // Its rail is not theirs either.
    const railRequestId = "00000000-0000-7000-8000-00000000d1fe";
    guest.socket.send(JSON.stringify({ type: "channel_rails", requestId: railRequestId, workstreamIds: [CHANNEL_A] }));
    await vi.waitFor(() => {
      expect(guest.frames.some((frame) => (frame as { requestId?: string }).requestId === railRequestId)).toBe(true);
    }, { timeout: 5_000 });
    const rails = guest.frames.find((frame) => (frame as { requestId?: string }).requestId === railRequestId) as { rails: unknown[]; unavailable: string[] };
    expect(rails.rails).toEqual([]);
    expect(rails.unavailable).toEqual([CHANNEL_A]);

    // Foregrounding it is treated as a member's would be: it is not a Channel
    // this guest may list, so it records no recency, and the socket stays open.
    const closes: number[] = [];
    guest.socket.addEventListener("close", (event) => { closes.push(event.code); });
    guest.socket.send(JSON.stringify({ type: "set_presence", revision: 1, applicationState: "foreground", foregroundWorkstreamId: CHANNEL_A }));
    // Frames are handled in order, so an answer to a later frame proves the
    // socket outlived the presence frame.
    const barrierId = "00000000-0000-7000-8000-00000000d1fd";
    guest.socket.send(JSON.stringify({ type: "list_workstreams", requestId: barrierId, limit: 50, includeSystem: false }));
    await vi.waitFor(() => {
      expect(closes).toEqual([]);
      expect(guest.frames.some((frame) => (frame as { requestId?: string }).requestId === barrierId)).toBe(true);
    }, { timeout: 5_000 });
    expect(guest.frames.some((frame) => (frame as { type?: string }).type === "workspace_workstream_recency")).toBe(false);
  });

  it("keeps Channel badge totals inside the parent Channel and guest visibility boundaries", async () => {
    await publishChannel(CHANNEL_A, [channelCommonEffect("Shared Channel")]);
    await publishBreakout(CHANNEL_A, BREAKOUT_ONE, [
      breakoutCommonEffect("Shared Breakout", { scope: "workspace" }),
    ]);
    await publishChannel(PRIVATE_CHANNEL, [
      channelCommonEffect("Private Channel", { scope: "personal" }),
      viewerEffect(OWNER),
    ]);
    await publishBreakout(PRIVATE_CHANNEL, BREAKOUT_TWO, [
      breakoutCommonEffect("Breakout under a hidden Channel", { scope: "workspace" }),
      viewerEffect(MEMBER) as ConversationEffect,
    ]);

    const counts = await runInDurableObject(workspace(), (_instance, state) => {
      const spaces = new WorkspaceSpaceStorage(state.storage);
      return {
        guestWithoutGrant: spaces.breakoutAttentionCounts({ userId: GUEST, accessClass: "guest" }, [CHANNEL_A]),
        memberThroughBreakout: spaces.breakoutAttentionCounts({ userId: MEMBER, accessClass: "member" }, [PRIVATE_CHANNEL]),
      };
    });
    expect(counts.guestWithoutGrant.get(CHANNEL_A)).toBeUndefined();
    // A Breakout the member opens lists its Channel for them, so it is counted.
    expect(counts.memberThroughBreakout.get(PRIVATE_CHANNEL)).toBe(1);

    await publishBreakout(CHANNEL_A, BREAKOUT_ONE, [
      viewerEffect(GUEST) as ConversationEffect,
    ], 2);
    const guestWithGrant = await runInDurableObject(workspace(), (_instance, state) => (
      new WorkspaceSpaceStorage(state.storage)
        .breakoutAttentionCounts({ userId: GUEST, accessClass: "guest" }, [CHANNEL_A])
        .get(CHANNEL_A)
    ));
    expect(guestWithGrant).toBe(1);
  });

  it("given more conversations than one page holds, when the cursor is followed, then the walk is complete and repeats nothing", async () => {
    const spaceId = await reserve("Hiring");
    // Seeded as rows rather than as projections. What is under test is the
    // keyset walk over `SPACE_CHANNEL_PAGE_SIZE`, and reaching that through
    // the effect pipeline would be hundreds of Queue round trips to set up a
    // property about SQL — these are the same rows the pipeline writes, in the
    // same real storage, written in one transaction.
    //
    // **The fixture is built around one tie that is both cross-kind and
    // across the page boundary**, because that is the only shape the cursor's
    // three parts all matter in. Four conversations — two breakouts and two
    // Channels — share one activity instant, and the page ends inside them. A
    // cursor carrying only the timestamp would repeat or skip the whole tie; a
    // cursor without `kind` could not tell the second breakout from the first
    // Channel, which is the pair the boundary falls between.
    const channelCount = 260;
    const tieAt = 248;
    const tieActivity = 8_750_000;
    const activityFor = (index: number): number => (
      index >= tieAt && index < tieAt + 2 ? tieActivity : 9_000_000 - index * 1_000
    );
    const channelId = (index: number): string =>
      `00000000-0000-7000-8000-${String(index).padStart(10, "0")}e1`;
    const breakoutId = (index: number): string =>
      `00000000-0000-7000-8000-${String(index).padStart(10, "0")}e2`;
    // Two breakouts under the first member Channel, at the tie's instant.
    // Their ids sort *after* the tied Channels' on purpose: `kind` is what
    // orders a tie, not the id, so a cursor that dropped `kind` would look for
    // an id above the last breakout's and skip both Channels beneath it.
    const tieBreakouts = [900, 901];
    const seeded = [
      ...Array.from({ length: channelCount }, (_unused, index) => ({
        kind: "channel" as const,
        conversationId: channelId(index),
        activity: activityFor(index),
        title: `Channel ${String(index).padStart(3, "0")}`,
      })),
      ...tieBreakouts.map((index) => ({
        kind: "breakout" as const,
        conversationId: breakoutId(index),
        activity: tieActivity,
        title: `Breakout ${String(index).padStart(3, "0")}`,
      })),
    ];
    await runInDurableObject(workspace(), (_instance, state) => {
      for (let index = 0; index < channelCount; index += 1) {
        state.storage.sql.exec(
          `INSERT INTO channels
             (workstream_id, authority_generation, waterline, source_event_id, payload_hash,
              title, description, preview, scope, exact_state, system_kind,
              last_activity_at, completed_at, archived_at, email_address,
              origin_type, origin_label, created_by_user_id,
              automation_subscription_id, automation_run_id, planned_for,
              title_status, latest_attention_ordinal, unread_tracking_start_ordinal,
              next_wakeup_due_at, next_wakeup_prompt, next_terminal_action_at,
              source_created_at, source_updated_at, projected_at)
           VALUES (?, 1, 1, ?, 'fnv1a64:0000000000000000', ?, '', '', 'workspace',
                   'needs_input', NULL, ?, NULL, NULL, NULL, 'ad_hoc', NULL, NULL,
                   NULL, NULL, NULL, 'settled', 0, 0, NULL, NULL, NULL, 1, 1, 1)`,
          channelId(index), `event-${index}`, `Channel ${String(index).padStart(3, "0")}`,
          activityFor(index),
        );
        state.storage.sql.exec(
          `INSERT INTO space_channel_memberships
             (space_id, workstream_id, state, generation, joined_at, updated_at, removed_at)
           VALUES (?, ?, 'active', 1, 1, 1, NULL)`,
          spaceId, channelId(index),
        );
      }
      for (const index of tieBreakouts) {
        state.storage.sql.exec(
          `INSERT INTO breakouts
             (workstream_id, substream_id, authority_generation, waterline, source_event_id,
              payload_hash, title, description, scope, exact_state, title_status,
              created_by_user_id, last_activity_at, completed_at, archived_at,
              latest_attention_ordinal, unread_tracking_start_ordinal,
              source_created_at, source_updated_at, projected_at)
           VALUES (?, ?, 1, 1, ?, 'fnv1a64:0000000000000000', ?, '', 'personal',
                   'needs_input', 'settled', NULL, ?, NULL, NULL, 0, 0, 1, 1, 1)`,
          channelId(0), breakoutId(index), `breakout-event-${index}`,
          `Breakout ${String(index).padStart(3, "0")}`, tieActivity,
        );
        state.storage.sql.exec(
          `INSERT INTO breakout_viewers
             (workstream_id, substream_id, user_id, authority_generation, waterline,
              source_event_id, payload_hash, is_participant, unread_count,
              you_are_mentioned, unseen, listable, seen_attention_ordinal,
              manual_unread_from_ordinal, manual_unread_generation,
              latest_mention_attention_ordinal, projected_at)
           VALUES (?, ?, ?, 1, 1, ?, 'fnv1a64:0000000000000000', 1, 0, 0, 0, 1, 0, NULL, 0, 0, 1)`,
          channelId(0), breakoutId(index), OWNER, `breakout-viewer-${index}`,
        );
      }
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let request = 0; request < 4; request += 1) {
      const chunk = await page(spaceId, OWNER, cursor);
      seen.push(...chunk.items.map((item) => item.title));
      cursor = chunk.nextCursor;
      if (cursor === null) break;
      // The first page is full; a short page means the walk has ended and
      // should have said so with a null cursor rather than another request.
      expect(chunk.items).toHaveLength(SPACE_CHANNEL_PAGE_SIZE);
    }
    expect(cursor).toBeNull();
    expect(seen).toHaveLength(seeded.length);
    expect(new Set(seen).size).toBe(seeded.length);
    // Activity descending, then the cursor's own tie-break: kind, then id.
    // `breakout` sorts before `channel`, so the tie reads as two breakouts and
    // then two Channels — and the page boundary falls inside it.
    const expected = [...seeded]
      .sort((left, right) => (
        right.activity - left.activity
        || left.kind.localeCompare(right.kind)
        || left.conversationId.localeCompare(right.conversationId)
      ))
      .map((conversation) => conversation.title);
    expect(seen).toEqual(expected);
    for (const kind of ["channel", "breakout"] as const) {
      const titles: string[] = [];
      let kindCursor: string | null = null;
      do {
        const chunk = await page(spaceId, OWNER, kindCursor, { kind, needsViewerOnly: false });
        titles.push(...chunk.items.map((item) => item.title));
        kindCursor = chunk.nextCursor;
      } while (kindCursor !== null);
      expect(titles.sort()).toEqual(seeded.filter((item) => item.kind === kind).map((item) => item.title).sort());
    }
    expect(expected.slice(SPACE_CHANNEL_PAGE_SIZE - 1, SPACE_CHANNEL_PAGE_SIZE + 1))
      .toEqual(["Breakout 901", `Channel ${String(tieAt).padStart(3, "0")}`]);
  });

  /**
   * The wire status a stored `exact_state` produces, one state per status, so
   * a walk covers the whole `HarnessStatus` union rather than the states that
   * happen to be easy to reach.
   */
  const stateForStatus: Record<HarnessStatus, string> = {
    scheduled: "scheduled",
    running: "running",
    needs_input: "needs_input",
    completed: "completed",
    failed: "failed",
    stopped: "cancelled",
    idle: "idle",
  };

  /**
   * How a conversation comes to be unread, which is not one thing.
   *
   * `conversationNeedsViewer` takes one boolean, and the SQL derives it from
   * two independent columns: an attention ordinal past what this person has
   * seen, and a manual "mark as unread" from an ordinal. They are separate
   * arms of `liveForViewerSql`, so an unread axis with only two values leaves
   * one of them never true in any test — and a typo in it would list nothing
   * and break nothing.
   */
  const UNREAD_SOURCES = ["read", "activity", "manual"] as const;
  type UnreadSource = (typeof UNREAD_SOURCES)[number];

  interface WalkCase {
    harnessStatus: HarnessStatus;
    unread: UnreadSource;
    unseen: boolean;
    youAreMentioned: boolean;
  }

  function walkCases(): WalkCase[] {
    const cases: WalkCase[] = [];
    for (const harnessStatus of HarnessStatusSchema.options) {
      for (const unread of UNREAD_SOURCES) {
        for (const unseen of [false, true]) {
          for (const youAreMentioned of [false, true]) {
            cases.push({ harnessStatus, unread, unseen, youAreMentioned });
          }
        }
      }
    }
    return cases;
  }

  /**
   * Walk every combination against one rendering of the predicate.
   *
   * `liveForViewerSql` is one text rendered twice, against the Channel aliases
   * and against the breakout ones, and "rendered from one text" is not the
   * same as "asked the same question": the aliases are what varies, and an
   * alias naming the wrong table is exactly the mistake the single text exists
   * to make impossible and cannot itself catch. So both renderings are walked,
   * and `publish` is how a case is written into whichever one is under test.
   */
  async function walkPredicate(
    spaceId: SpaceId,
    publish: (testCase: WalkCase, version: number) => Promise<void>,
  ): Promise<void> {
    const cases = walkCases();
    let version = 1;
    for (const testCase of cases) {
      version += 1;
      await publish(testCase, version);
      const listed = (await page(spaceId, OWNER)).items;
      const input = {
        harnessStatus: testCase.harnessStatus,
        hasUnread: testCase.unread !== "read",
        unseen: testCase.unseen,
        youAreMentioned: testCase.youAreMentioned,
      };
      expect({ ...testCase, listed: listed.length === 1 })
        .toEqual({ ...testCase, listed: conversationNeedsViewer(input) });
      // When it is listed, the row the page built has to satisfy the predicate
      // too — otherwise the two could agree on the count while disagreeing
      // about what the row says, which is the drift the desktop would draw.
      if (listed[0]) expect(conversationNeedsViewer(listed[0])).toBe(true);
    }
    expect(cases).toHaveLength(HarnessStatusSchema.options.length * UNREAD_SOURCES.length * 4);
  }

  it("given every combination of run state and reader state on a Channel, then the page and the contracts predicate agree", async () => {
    const spaceId = await reserve("Hiring");
    await openChannelObject(CHANNEL_A);
    await publishChannel(CHANNEL_A, [channelCommonEffect("Roadmap"), viewerEffect(OWNER)]);
    await place(spaceId, CHANNEL_A);

    await walkPredicate(spaceId, async (testCase, version) => {
      // Written as the columns the mapper reads, so that what is compared is
      // the two implementations rather than two spellings of one input.
      await publishChannel(
        CHANNEL_A,
        [
          channelCommonEffect("Roadmap", {
            state: stateForStatus[testCase.harnessStatus],
            latestAttentionOrdinal: testCase.unread === "activity" ? 5 : 0,
          }),
          viewerEffect(OWNER, {
            unseen: testCase.unseen,
            youAreMentioned: testCase.youAreMentioned,
            latestMentionAttentionOrdinal: testCase.youAreMentioned ? 9 : 0,
            seenAttentionOrdinal: 0,
            manualUnreadFromOrdinal: testCase.unread === "manual" ? 3 : null,
          }),
        ],
        version,
      );
    });
  });

  it("given every combination of run state and reader state on a breakout, then the page and the contracts predicate agree", async () => {
    const spaceId = await reserve("Hiring");
    await openChannelObject(CHANNEL_A);
    // The parent Channel is idle and fully read for the whole walk, so the one
    // row the page can ever hold is the breakout under test.
    await publishChannel(CHANNEL_A, [channelCommonEffect("Roadmap"), viewerEffect(OWNER)]);
    await place(spaceId, CHANNEL_A);
    await publishBreakoutProjection(CHANNEL_A, BREAKOUT_ONE, [
      breakoutCommonEffect("Pricing", { state: "idle" }),
      viewerEffect(OWNER) as ConversationEffect,
    ]);

    await walkPredicate(spaceId, async (testCase, version) => {
      await publishBreakoutProjection(
        CHANNEL_A,
        BREAKOUT_ONE,
        [
          breakoutCommonEffect("Pricing", {
            state: stateForStatus[testCase.harnessStatus],
            latestAttentionOrdinal: testCase.unread === "activity" ? 5 : 0,
          }),
          viewerEffect(OWNER, {
            unseen: testCase.unseen,
            youAreMentioned: testCase.youAreMentioned,
            latestMentionAttentionOrdinal: testCase.youAreMentioned ? 9 : 0,
            seenAttentionOrdinal: 0,
            manualUnreadFromOrdinal: testCase.unread === "manual" ? 3 : null,
          }) as ConversationEffect,
        ],
        version,
      );
    });
  });

  /**
   * The dashboard nudge, on the only path it exists on.
   *
   * There is no counter to read back and no row to inspect: the whole signal
   * is one message on one socket, sent to the people who can see the
   * conversation that moved. Every assertion below is therefore on what a
   * subscribed socket was handed.
   *
   * "Did not arrive" is fenced rather than waited out. Each such case makes a
   * change that *must* be nudged after the one that must not, and asserts the
   * recorder holds only the second — so the test fails on a nudge that is late
   * as well as on one that should never have been sent, and never on a timer.
   */
  describe("the dashboard nudge", () => {
    it("given a message in a member Channel, when it is projected, then its readers are told which Space to read again", async () => {
      const spaceId = await reserve("Hiring");
      await openChannelObject(CHANNEL_A);
      await publishChannel(CHANNEL_A, [channelCommonEffect("Roadmap"), viewerEffect(OWNER)]);
      await place(spaceId, CHANNEL_A);
      const owner = await connectViewer(OWNER);

      await publishChannel(
        CHANNEL_A,
        [channelCommonEffect("Roadmap", { lastActivityAt: "2026-09-19T13:00:00.000Z" })],
        2,
      );

      await vi.waitFor(() => expect(owner.nudges).toEqual([[spaceId]]));
    });

    it("given a breakout's own activity, when it is forwarded, then the nudge still arrives", async () => {
      const spaceId = await reserve("Hiring");
      await openChannelObject(CHANNEL_A);
      await publishChannel(CHANNEL_A, [channelCommonEffect("Roadmap"), viewerEffect(OWNER)]);
      await place(spaceId, CHANNEL_A);
      const owner = await connectViewer(OWNER);

      // The case the Channel's own state push cannot cover: a breakout does
      // not change its Channel's directory row, so nothing else on this socket
      // moves. Without a signal of its own the row would sit stale until the
      // reader navigated away and back.
      await publishBreakout(CHANNEL_A, BREAKOUT_ONE, [breakoutCommonEffect("Pricing")]);

      await vi.waitFor(() => expect(owner.nudges).toEqual([[spaceId]]));
    });

    it("given one person's read state moving, when it is projected, then only that person is told", async () => {
      const spaceId = await reserve("Hiring");
      await openChannelObject(CHANNEL_A);
      await publishChannel(CHANNEL_A, [
        channelCommonEffect("Roadmap"), viewerEffect(OWNER), viewerEffect(MEMBER),
      ]);
      await place(spaceId, CHANNEL_A);
      const owner = await connectViewer(OWNER);
      const member = await connectViewer(MEMBER);

      // One person opening a conversation takes the row off their list and
      // nobody else's, so a shared signal here would refetch every member's
      // dashboard on every read anybody made.
      await publishChannel(CHANNEL_A, [viewerEffect(MEMBER, { seenAttentionOrdinal: 4 })], 2);
      // The fence: a shared change everybody is owed, made second.
      await publishChannel(
        CHANNEL_A,
        [channelCommonEffect("Roadmap", { lastActivityAt: "2026-09-19T13:00:00.000Z" })],
        3,
      );

      await vi.waitFor(() => expect(owner.nudges).toEqual([[spaceId]]));
      expect(member.nudges).toEqual([[spaceId], [spaceId]]);
    });

    it("given a Channel this viewer cannot see, when it moves, then they are told nothing about its Space", async () => {
      const spaceId = await reserve("Hiring");
      await openChannelObject(PRIVATE_CHANNEL);
      await openChannelObject(CHANNEL_A);
      await publishChannel(PRIVATE_CHANNEL, [
        channelCommonEffect("Private Channel", { scope: "personal" }), viewerEffect(OWNER),
      ]);
      await publishChannel(CHANNEL_A, [channelCommonEffect("Roadmap"), viewerEffect(OWNER)]);
      await place(spaceId, PRIVATE_CHANNEL);
      await place(spaceId, CHANNEL_A);
      const member = await connectViewer(MEMBER);

      // The member can read the Space and is in none of the private Channel's
      // audience. Naming the Space here is harmless on its own — but the
      // refetch it would cause is one per message in a Channel they cannot
      // read, on every member of an Organization-wide Space.
      await publishChannel(
        PRIVATE_CHANNEL,
        [channelCommonEffect("Private Channel", {
          scope: "personal", lastActivityAt: "2026-09-19T13:00:00.000Z",
        })],
        2,
      );
      await publishChannel(
        CHANNEL_A,
        [channelCommonEffect("Roadmap", { lastActivityAt: "2026-09-19T14:00:00.000Z" })],
        2,
      );

      await vi.waitFor(() => expect(member.nudges).toEqual([[spaceId]]));
    });

    it("given a membership settling, when it is finalized, then the Space's readers are told", async () => {
      const spaceId = await reserve("Hiring");
      await openChannelObject(CHANNEL_A);
      await publishChannel(CHANNEL_A, [channelCommonEffect("Roadmap"), viewerEffect(OWNER)]);
      const owner = await connectViewer(OWNER);

      // A membership change is the one dashboard change that is not a
      // projection, and it used to have a mechanism of its own (`channelCount`
      // moving on the Space snapshot). One nudge covers both.
      await place(spaceId, CHANNEL_A);

      await vi.waitFor(() => expect(owner.nudges.at(-1)).toEqual([spaceId]));
    });

    it("given a Channel in another Space, when it moves, then this Space is not named", async () => {
      const spaceId = await reserve("Hiring");
      const otherSpaceId = await reserve("Marketing");
      await openChannelObject(CHANNEL_A);
      await openChannelObject(CHANNEL_B);
      await publishChannel(CHANNEL_A, [channelCommonEffect("Roadmap"), viewerEffect(OWNER)]);
      await publishChannel(CHANNEL_B, [channelCommonEffect("Outside"), viewerEffect(OWNER)]);
      await place(spaceId, CHANNEL_A);
      await place(otherSpaceId, CHANNEL_B);
      const owner = await connectViewer(OWNER);

      await publishChannel(
        CHANNEL_B,
        [channelCommonEffect("Outside", { lastActivityAt: "2026-09-19T13:00:00.000Z" })],
        2,
      );

      // The nudge is addressed per Space as well as per person: a busy Channel
      // in Marketing must not refetch Hiring's dashboard.
      await vi.waitFor(() => expect(owner.nudges).toEqual([[otherSpaceId]]));
    });
  });

  it("given a background-agent conversation, when it projects, then nothing is forwarded for it", async () => {
    await openChannelObject(CHANNEL_A);
    await workspace().receiveChildEffects({
      substreamId: BREAKOUT_TWO,
      envelopes: [ConversationEffectEnvelopeSchema.parse({
        kind: "conversation_effect",
        contractVersion: 1,
        region: "global",
        workspaceId: WORKSPACE_ID,
        parentKind: "workstream",
        parentId: CHANNEL_A,
        substreamId: BREAKOUT_TWO,
        generation: 1,
        messageId: crypto.randomUUID(),
        partitionKey: `directory_common:${BREAKOUT_TWO}`,
        sourceVersion: 1,
        requiredProjectionVersion: null,
        payloadHash: conversationEffectHash({
          kind: "directory_common",
          backgroundAgent: true,
          title: "Worker",
          description: "",
          preview: "",
          scope: "personal",
          state: "running",
          systemKind: null,
          lastActivityAt: "2026-09-19T10:00:00.000Z",
          completedAt: null,
          archivedAt: null,
        }),
        effect: {
          kind: "directory_common",
          backgroundAgent: true,
          title: "Worker",
          description: "",
          preview: "",
          scope: "personal",
          state: "running",
          systemKind: null,
          lastActivityAt: "2026-09-19T10:00:00.000Z",
          completedAt: null,
          archivedAt: null,
        },
      })],
    });

    // A background agent is a worker this Channel started, not a conversation
    // anybody opens. Forwarding one would put a Queue message and a workspace
    // row on every step it takes, and a row on a dashboard for something with
    // no destination. A forward would now be a breakout row applied in place
    // and a projection key behind it, so both are checked alongside the
    // outbox.
    expect(await pendingParentEffects(workspace())).toEqual([]);
    await expect(inspect("SELECT substream_id FROM breakouts")).resolves.toMatchObject({ rows: [] });
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT projection_key FROM parent_projection_keys WHERE parent_id = ? AND projection_key LIKE 'substream:%'",
        CHANNEL_A,
      ).toArray()).toEqual([]);
    });
  });

  it("given a background agent forwarded as a breakout before it was marked, when it projects marked, then the Organization stops counting it", async () => {
    await openChannelObject(CHANNEL_A);
    await publishChannel(CHANNEL_A, [channelCommonEffect("Roadmap"), viewerEffect(OWNER)]);
    // The first projection an agent sent before it marked itself: no flag, so
    // its Channel forwarded it as a breakout nobody had opened.
    await publishBreakout(CHANNEL_A, BREAKOUT_TWO, [
      breakoutCommonEffect("Worker", { state: "idle" }),
      viewerEffect(OWNER, { unseen: true }) as ConversationEffect,
    ]);
    expect((await connectViewer(OWNER)).initialChannelCounts).toEqual([1]);

    await publishBreakout(CHANNEL_A, BREAKOUT_TWO, [
      { ...breakoutCommonEffect("Worker", { state: "completed" }), backgroundAgent: true },
      viewerEffect(OWNER, { unseen: true }) as ConversationEffect,
    ], 2);

    await expect(inspect(`SELECT substream_id FROM breakouts WHERE archived_at IS NULL`))
      .resolves.toMatchObject({ rows: [] });
    await expect(inspect("SELECT user_id FROM breakout_viewers"))
      .resolves.toMatchObject({ rows: [] });
    expect((await connectViewer(OWNER)).initialChannelCounts).toEqual([0]);
  });

  it("given a stale unmarked projection after the marked one, when the Channel receives it, then it is not forwarded", async () => {
    await openChannelObject(CHANNEL_A);
    await publishBreakout(CHANNEL_A, BREAKOUT_TWO, [breakoutCommonEffect("Worker", { state: "idle" })]);
    await publishBreakout(CHANNEL_A, BREAKOUT_TWO, [
      { ...breakoutCommonEffect("Worker", { state: "completed" }), backgroundAgent: true },
    ], 3);
    const forwardedVersion = () => runInDurableObject(workspace(), (_instance, state) => (
      state.storage.sql.exec<{ next_version: number }>(
        "SELECT next_version FROM parent_projection_keys WHERE parent_id = ? AND projection_key = ?",
        CHANNEL_A,
        `substream:${BREAKOUT_TWO}:common`,
      ).one().next_version
    ));
    const before = await forwardedVersion();

    // Forwarded, it would reach the Organization under a newer parent version
    // and put back the row the marked projection withdrew.
    await publishBreakout(CHANNEL_A, BREAKOUT_TWO, [breakoutCommonEffect("Worker", { state: "idle" })], 2);

    expect(await forwardedVersion()).toBe(before);
  });

  it("given the withdrawal applied before the leaked row, when the Queue reorders them, then the agent still does not count", async () => {
    await openChannelObject(CHANNEL_A);
    await publishChannel(CHANNEL_A, [channelCommonEffect("Roadmap"), viewerEffect(OWNER)]);

    // The Queue promises no order, so the Channel's withdrawal (its version 2)
    // can land before the leaked row it withdraws (its version 1).
    await publishBreakoutProjection(CHANNEL_A, BREAKOUT_TWO, [
      { ...breakoutCommonEffect("Worker", { state: "completed" }), backgroundAgent: true },
    ], 2);
    await publishBreakoutProjection(CHANNEL_A, BREAKOUT_TWO, [
      breakoutCommonEffect("Worker", { state: "idle" }),
      viewerEffect(OWNER, { unseen: true }) as ConversationEffect,
    ], 1);

    await expect(inspect(`SELECT substream_id FROM breakouts WHERE archived_at IS NULL`))
      .resolves.toMatchObject({ rows: [] });
    expect((await connectViewer(OWNER)).initialChannelCounts).toEqual([0]);
  });
});
