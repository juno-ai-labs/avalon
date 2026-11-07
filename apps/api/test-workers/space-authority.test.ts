/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The Organization's Space authority on real workerd.
 *
 * Everything here needs the runtime: a migration ledger the object applies in
 * its constructor, D1 membership read across a real binding, a socket that
 * receives the snapshot every write republishes, and the generation and
 * revision fences that only mean anything against real storage.
 *
 * The three negative controls the PRD names are `it` cases of their own rather
 * than assertions tacked onto a happy path, because each is a thing that would
 * still pass if the fence it covers were deleted: a staged membership that is
 * never finalized must stay invisible, a finalize whose Space moved must be
 * refused, and a Space's feed effects must not reach the workspace even though
 * its directory effects do.
 */
import { seedParticipantGrants } from "./helpers/hosted-parent";
import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asSpaceId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  conversationEffectHash,
  WorkspaceSocketSyncEventSchema,
  WorkspaceSpaceConversationsEventSchema,
  WorkspaceSpaceSnapshotEventSchema,
  WorkspaceWorkstreamStateEventSchema,
  type ParentEffect,
  type SpaceId,
  type SpaceSummary,
  type UserId,
  type PersonalOrder,
  type WorkspaceSidebar,
  type WorkspaceSpaceSnapshotEvent,
  type WorkspaceWorkstreamStateEvent,
  type WorkstreamId,
} from "@rally/contracts";
import { ParentEffectEnvelopeSchema } from "@rally/contracts/conversation-effects";

import { workspaceDOName } from "../src/durable-objects/names";
import { WORKSPACE_BREAKOUT_SCHEMA_STATEMENTS } from "../src/durable-objects/workspace-breakout-storage";
import { placeMembership, removeMembership, withSpaceStorage } from "./helpers/space-membership";

/** Its own workspace id: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000cf00");
const OWNER = asUserId("00000000-0000-7000-8000-00000000cf01");
const MEMBER = asUserId("00000000-0000-7000-8000-00000000cf02");
const GUEST = asUserId("00000000-0000-7000-8000-00000000cf03");
const INACTIVE = asUserId("00000000-0000-7000-8000-00000000cf04");
const CHANNEL_A = asWorkstreamId("00000000-0000-7000-8000-00000000cf05");
const CHANNEL_B = asWorkstreamId("00000000-0000-7000-8000-00000000cf06");
const CHANNEL_C = asWorkstreamId("00000000-0000-7000-8000-00000000cf07");
const RESOURCE_ID = "00000000-0000-7000-8000-00000000cf0c";
/**
 * Two Breakout ids, which WorkspaceDO has never seen and never will.
 *
 * A Channel's Breakouts are its own object's children; the Organization stores
 * the arrangement this person dragged and nothing about what is in it, which is
 * exactly what these two literals stand for.
 */
const BREAKOUT_A = "00000000-0000-7000-8000-00000000cf0d";
const BREAKOUT_B = "00000000-0000-7000-8000-00000000cf0e";
const BREAKOUT_C = "00000000-0000-7000-8000-00000000cf0f";

function workspace() {
  return env.WORKSPACE_DOS.getByName(workspaceDOName("global", WORKSPACE_ID));
}

async function establishWorkspace(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT, abandoned_at TEXT
    )`),
    // `access_class` is load-bearing here rather than incidental: every Space
    // RPC refuses a guest, and a fixture without the column would prove the
    // membership check and not the guest one.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      incarnation TEXT DEFAULT 'existing-member', revision INTEGER NOT NULL DEFAULT 1,
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT, access_class TEXT NOT NULL DEFAULT 'member',
      last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id)
    )`),
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
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role, access_class) VALUES (?, ?, 'suspended', 'member', 'member')`)
      .bind(WORKSPACE_ID, INACTIVE),
    env.DB.prepare(`INSERT OR REPLACE INTO sessions
      (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(`space-session-${OWNER}`, OWNER, WORKSPACE_ID),
    // A guest and an ordinary member both hold a socket in these tests: the
    // guest is what the Space payload has to be empty for, and the member is
    // what makes that emptiness a decision rather than an empty Organization.
    env.DB.prepare(`INSERT OR REPLACE INTO sessions
      (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(`space-session-${GUEST}`, GUEST, WORKSPACE_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO sessions
      (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(`space-session-${MEMBER}`, MEMBER, WORKSPACE_ID),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
}

let effectSequence = 0;

function messageId(): string {
  effectSequence += 1;
  return `00000000-0000-7000-8000-${String(effectSequence).padStart(10, "0")}cf`;
}

/**
 * One Channel published into the Organization's Channel directory.
 *
 * `needs_input` rather than `idle`, because the Space dashboard's page answers
 * only the conversations that currently need the reader. An idle Channel
 * nobody has unread is correctly absent from it, so a fixture built that way
 * would make every page assertion below pass for the wrong reason.
 */
async function publishChannel(workstreamId: WorkstreamId, archivedAt: string | null): Promise<void> {
  const effect: ParentEffect = {
    kind: "directory_common",
    title: "Member Channel",
    description: "",
    preview: "",
    scope: "workspace",
    state: "needs_input",
    systemKind: null,
    lastActivityAt: "2026-09-19T00:00:00.000Z",
    completedAt: null,
    archivedAt,
    createdByUserId: OWNER,
    latestAttentionOrdinal: 0,
    unreadTrackingStartOrdinal: 0,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    resourceLinks: [],
  };
  await workspace().applyWorkstreamDirectoryEffects({
    workspaceId: WORKSPACE_ID,
    envelopes: [ParentEffectEnvelopeSchema.parse({
      kind: "parent_effect",
      contractVersion: 1,
      region: "global",
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: workstreamId,
      generation: 1,
      messageId: messageId(),
      partitionKey: "common",
      sourceVersion: archivedAt === null ? 1 : 2,
      requiredProjectionVersion: null,
      payloadHash: conversationEffectHash(effect),
      effect,
    })],
  });
}

/** One effect a Space's own object publishes, addressed at the workspace. */
function spaceEnvelope(spaceId: SpaceId, effect: ParentEffect, sourceVersion: number) {
  return ParentEffectEnvelopeSchema.parse({
    kind: "parent_effect",
    contractVersion: 1,
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: "space",
    parentId: spaceId,
    generation: 1,
    messageId: messageId(),
    partitionKey: "common",
    sourceVersion,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(effect),
    effect,
  });
}

function spaceDirectoryEffect(title: string, scope: "personal" | "workspace"): ParentEffect {
  return {
    kind: "directory_common",
    title,
    description: "",
    preview: "",
    scope,
    state: "idle",
    systemKind: null,
    lastActivityAt: "2026-09-19T00:00:00.000Z",
    completedAt: null,
    archivedAt: null,
    createdByUserId: OWNER,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
  };
}

/** General, created with its hosted parent the way `SpaceService.ensureGeneral` creates it. */
async function openGeneral(): Promise<{ created: boolean; space: SpaceSummary }> {
  const general = await workspace().openGeneralSpace({
    workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: asSpaceId("00000000-0000-7000-8000-00000000cf1a"),
  });
  if (!general.ok || "absent" in general) throw new Error("openGeneralSpace refused");
  return general;
}

/**
 * One Space, reserved as every Space now is: Organization-wide.
 *
 * `personal` writes a *legacy* row instead — a Space made private before
 * WorkspaceDO migration 94, which nothing can create any more — for the
 * listing rules that still read the scope a stored row carries.
 */
async function reserve(
  name: string,
  scope: "personal" | "workspace" = "workspace",
  userId = OWNER,
): Promise<SpaceId> {
  const result = await workspace().reserveSpace({
    workspaceId: WORKSPACE_ID,
    userId,
    space: { name, iconKey: "briefcase", colorKey: "blue", scope: "workspace" },
  });
  if (!result.ok) throw new Error(`reserveSpace refused: ${result.code}`);
  const spaceId = asSpaceId(result.space.id);
  if (scope === "personal") {
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE spaces SET scope = 'personal' WHERE space_id = ?", spaceId);
    });
  }
  return spaceId;
}

/**
 * One Channel that only its own participant may see.
 *
 * `directory_common` makes it personal; the `directory_user` row beside it is
 * what says who its participant is. Both halves are needed, because the page
 * decides visibility from exactly that pair.
 */
async function publishPersonalChannel(
  workstreamId: WorkstreamId,
  participantUserId: UserId,
): Promise<void> {
  const common: ParentEffect = {
    kind: "directory_common",
    title: "Private Channel",
    description: "",
    preview: "",
    scope: "personal",
    state: "needs_input",
    systemKind: null,
    lastActivityAt: "2026-09-19T00:00:00.000Z",
    completedAt: null,
    archivedAt: null,
    createdByUserId: participantUserId,
    latestAttentionOrdinal: 0,
    unreadTrackingStartOrdinal: 0,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    resourceLinks: [],
  };
  const viewer: ParentEffect = {
    kind: "directory_user",
    userId: participantUserId,
    isParticipant: true,
    participantAddedAt: "2026-09-19T00:00:00.000Z",
    unreadCount: 0,
    youAreMentioned: false,
    unseen: false,
    listable: true,
    seenAttentionOrdinal: 0,
    manualUnreadFromOrdinal: null,
    manualUnreadGeneration: 0,
    latestMentionAttentionOrdinal: 0,
  };
  await workspace().applyWorkstreamDirectoryEffects({
    workspaceId: WORKSPACE_ID,
    envelopes: [common, viewer].map((effect) => ParentEffectEnvelopeSchema.parse({
      kind: "parent_effect",
      contractVersion: 1,
      region: "global",
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: workstreamId,
      generation: 1,
      messageId: messageId(),
      partitionKey: effect.kind === "directory_common" ? "common" : `user:${participantUserId}`,
      sourceVersion: 1,
      requiredProjectionVersion: null,
      payloadHash: conversationEffectHash(effect),
      effect,
    })),
  });
}

/** Put a Channel in a Space's membership (`helpers/space-membership.ts` says why not through `addSpaceChannel`). */
async function place(spaceId: SpaceId, workstreamId: WorkstreamId): Promise<void> {
  await placeMembership(workspace(), { workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, workstreamId });
}

/**
 * One member Channel's own parent, hosted by the Organization object.
 *
 * Written directly: these cases are about what a Space write does in place to
 * a Channel whose parent this object hosts (a Sidekick default applied in the
 * same write), not about how a Channel comes to be.
 */
async function openMemberChannel(workstreamId: WorkstreamId): Promise<void> {
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO parent_metadata
         (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
       VALUES (?, 'workstream', ?, 'global', 1, 1, 1)`,
      workstreamId,
      WORKSPACE_ID,
    );
    state.storage.sql.exec(
      `INSERT INTO parent_children (parent_id, substream_id, kind, created_by_user_id, created_at, status, updated_at)
       VALUES (?, '0', 'main', ?, 1, 'ready', 1)`,
      workstreamId,
      OWNER,
    );
  });
  await seedParticipantGrants(env, WORKSPACE_ID, workstreamId, [OWNER]);
}

function nextMessage(socket: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve) => socket.addEventListener("message", resolve, { once: true }));
}

/** The first Channel row push that satisfies `matches`, skipping the rest. */
function nextWorkstreamStateWhere(
  socket: WebSocket,
  matches: (event: WorkspaceWorkstreamStateEvent) => boolean,
): Promise<WorkspaceWorkstreamStateEvent> {
  return new Promise((resolve) => {
    const listen = (event: MessageEvent): void => {
      const decoded = WorkspaceWorkstreamStateEventSchema.safeParse(JSON.parse(String(event.data)));
      if (!decoded.success || !matches(decoded.data)) return;
      socket.removeEventListener("message", listen);
      resolve(decoded.data);
    };
    socket.addEventListener("message", listen);
  });
}

/** The next Space snapshot, skipping whatever else the socket is carrying. */
function nextSpaceSnapshot(socket: WebSocket): Promise<WorkspaceSpaceSnapshotEvent> {
  return new Promise((resolve) => {
    const listen = (event: MessageEvent): void => {
      const decoded = WorkspaceSpaceSnapshotEventSchema.safeParse(JSON.parse(String(event.data)));
      if (!decoded.success) return;
      socket.removeEventListener("message", listen);
      resolve(decoded.data);
    };
    socket.addEventListener("message", listen);
  });
}

/**
 * Every `space_conversations_changed` this socket is pushed, in arrival order.
 *
 * An array rather than a promise for the next one, because what most of these
 * cases assert is a nudge that must *not* be sent, and "the next one" cannot
 * tell a nudge that never came from one that has not arrived yet. A socket
 * delivers in order, so an assertion made once a later event has landed is an
 * assertion about everything before it.
 */
function collectSpaceNudges(socket: WebSocket): readonly (readonly string[])[] {
  const seen: string[][] = [];
  socket.addEventListener("message", (event: MessageEvent) => {
    const decoded = WorkspaceSpaceConversationsEventSchema.safeParse(JSON.parse(String(event.data)));
    if (decoded.success) seen.push(decoded.data.spaceIds);
  });
  return seen;
}

/** The next row this socket is pushed for one named Channel. */
function nextWorkstreamStateFor(
  socket: WebSocket,
  workstreamId: WorkstreamId,
): Promise<WorkspaceWorkstreamStateEvent> {
  return new Promise((resolve) => {
    const listen = (event: MessageEvent): void => {
      const decoded = WorkspaceWorkstreamStateEventSchema.safeParse(JSON.parse(String(event.data)));
      if (!decoded.success || decoded.data.workstreamId !== workstreamId) return;
      socket.removeEventListener("message", listen);
      resolve(decoded.data);
    };
    socket.addEventListener("message", listen);
  });
}

/**
 * One viewer row published on a Channel, for a batch that changes exactly it.
 *
 * `sourceVersion` is the projection's own ordering, so each of these has to
 * advance or the row is refused as superseded. The generation stays 1 because
 * the Channel visibility predicate joins the viewer row on it: a mismatch
 * hides the Channel for a reason that is not the one under test.
 */
async function publishViewerRow(
  workstreamId: WorkstreamId,
  userId: UserId,
  sourceVersion: number,
  viewer: { isParticipant: boolean; unreadCount?: number },
): Promise<void> {
  const effect: ParentEffect = {
    kind: "directory_user",
    userId,
    isParticipant: viewer.isParticipant,
    participantAddedAt: "2026-09-19T00:00:00.000Z",
    unreadCount: viewer.unreadCount ?? 0,
    youAreMentioned: false,
    unseen: false,
    listable: true,
    seenAttentionOrdinal: 0,
    manualUnreadFromOrdinal: null,
    manualUnreadGeneration: 0,
    latestMentionAttentionOrdinal: 0,
  };
  await workspace().applyWorkstreamDirectoryEffects({
    workspaceId: WORKSPACE_ID,
    envelopes: [ParentEffectEnvelopeSchema.parse({
      kind: "parent_effect",
      contractVersion: 1,
      region: "global",
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: workstreamId,
      generation: 1,
      messageId: messageId(),
      partitionKey: `user:${userId}`,
      sourceVersion,
      requiredProjectionVersion: null,
      payloadHash: conversationEffectHash(effect),
      effect,
    })],
  });
}

/** Every Space snapshot this socket is pushed, as the ids each one carries. */
function collectSpaceSnapshots(socket: WebSocket): readonly (readonly string[])[] {
  const seen: string[][] = [];
  socket.addEventListener("message", (event: MessageEvent) => {
    const decoded = WorkspaceSpaceSnapshotEventSchema.safeParse(JSON.parse(String(event.data)));
    if (decoded.success) seen.push(decoded.data.spaces.active.items.map((item) => item.id));
  });
  return seen;
}

/** Every directory invalidation this connected client receives. */
function collectDirectorySyncs(socket: WebSocket): { readonly raw: string[]; readonly topics: string[][] } {
  const raw: string[] = [];
  const seen: string[][] = [];
  socket.addEventListener("message", (event: MessageEvent) => {
    const payload = String(event.data);
    raw.push(payload);
    const decoded = WorkspaceSocketSyncEventSchema.safeParse(JSON.parse(payload));
    if (decoded.success && decoded.data.topics.includes("workstream_directory")) {
      seen.push([...decoded.data.topics]);
    }
  });
  return { raw, topics: seen };
}

/** Give a socket that should already hold `count` nudges the chance to. */
async function settleNudges(seen: readonly (readonly string[])[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 200 && seen.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Take a Channel out of a Space's membership, the way `place` puts it in. */
async function displace(
  spaceId: SpaceId,
  workstreamId: WorkstreamId,
): Promise<SpaceSummary> {
  return removeMembership(workspace(), { workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, workstreamId });
}

/**
 * A subscribed workspace socket, and the connect payload it was answered with.
 *
 * The sidebar rides the `subscribe` answer, so it has to be read from that
 * first message rather than asked for afterwards.
 */
async function connectViewer(userId: string, suffix: string): Promise<{
  socket: WebSocket;
  sidebar: WorkspaceSidebar;
}> {
  const response = await workspace().fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": WORKSPACE_ID,
      "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": userId,
      "x-rally-session-id": `space-session-${userId}`,
      "x-rally-socket-ticket-id": `00000000-0000-7000-8000-${suffix.padStart(12, "0")}`,
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`workspace socket rejected: ${response.status} ${await response.text()}`);
  }
  response.webSocket.accept();
  const initial = nextMessage(response.webSocket);
  response.webSocket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  const answer = WorkspaceSocketSyncEventSchema.parse(JSON.parse(String((await initial).data)));
  if (!answer.sidebar) throw new Error("workspace subscribe answered without a sidebar");
  return { socket: response.webSocket, sidebar: answer.sidebar };
}

let ticketSequence = 0;

/**
 * The Space directories as a client actually reads them.
 *
 * There is deliberately no `GET /spaces`: Space state comes down the workspace
 * socket's connect payload and nowhere else, so this is the production read
 * path and asserting through it is asserting on what a person is shown. It is
 * also the path that appends a viewer's missing order rows, which is why the
 * ordering cases go through here rather than through a read of their own.
 */
async function spaceDirectories(userId: string): Promise<NonNullable<WorkspaceSidebar["spaces"]>> {
  ticketSequence += 1;
  const { socket, sidebar } = await connectViewer(userId, `d${ticketSequence.toString(16)}`);
  socket.close();
  // Optional on the wire so a client talking to a server without the cutover is
  // not permanently opening; a server that has it always sends it, and a
  // missing pair here is a regression rather than a case to tolerate.
  if (!sidebar.spaces) throw new Error("workspace sidebar answered without Space directories");
  return sidebar.spaces;
}

/** Every list this person has arranged, as their own client reads it. */
async function personalOrder(userId: string): Promise<PersonalOrder> {
  ticketSequence += 1;
  const { socket, sidebar } = await connectViewer(userId, `e${ticketSequence.toString(16)}`);
  socket.close();
  // Optional on the wire so a client can talk to a server without the ordering;
  // a server that has it always sends it, so a missing field is a regression.
  if (!sidebar.ordering) throw new Error("workspace sidebar answered without an ordering");
  return sidebar.ordering;
}

/** All's Pinned order as this person's sidebar payload carries it. */
async function pinnedOrder(userId: string): Promise<string[]> {
  ticketSequence += 1;
  const { socket, sidebar } = await connectViewer(userId, `e${ticketSequence.toString(16)}`);
  socket.close();
  if (!sidebar.pinnedOrder) throw new Error("workspace sidebar answered without a pinned order");
  return sidebar.pinnedOrder;
}

/** One container's stored item ids, or `null` when this person has no row for it. */
function storedItemIds(
  ordering: PersonalOrder,
  kind: "organization" | "space" | "channel",
  containerId?: string,
): string[] | null {
  // The Organization's entry carries no id, because a request is addressed to
  // one Organization already; the other two are a pair.
  return ordering.find((entry) => (entry.container.kind === "organization"
    ? entry.container.kind === kind
    : entry.container.kind === kind && entry.container.id === containerId))?.itemIds ?? null;
}

beforeEach(async () => {
  await reset();
  effectSequence = 0;
  ticketSequence = 0;
  await establishWorkspace();
}, 30_000);

describe("WorkspaceDO space authority", () => {
  it("given a reserved Space, when members read their sidebar, then scope decides who sees it", async () => {
    await reserve("Hiring", "personal");
    await reserve("Company", "workspace");

    expect((await spaceDirectories(OWNER)).active.items)
      .toMatchObject([{ name: "Hiring" }, { name: "Company" }]);
    // The personal Space is the creator's: another member's sidebar has to be
    // shaped for the relationship, not just filtered on the way out.
    expect((await spaceDirectories(MEMBER)).active.items).toMatchObject([{ name: "Company" }]);
  });

  it("given a guest relationship, when it reads a Space holding no Channel of theirs, then it is told nothing", async () => {
    const spaceId = await reserve("Company");

    // Organization-wide scope admits members only, and the guest lists no
    // Channel placed here, so the Space is not theirs to be told about.
    await expect(workspace().spaceSummary({ workspaceId: WORKSPACE_ID, userId: GUEST, spaceId }))
      .resolves.toMatchObject({ ok: false, code: "space_not_found" });
    await expect(workspace().listSpaceChannels({
      workspaceId: WORKSPACE_ID, userId: GUEST, spaceId, cursor: null,
    })).resolves.toMatchObject({ ok: false, code: "space_not_found" });
    // A removed member is refused by the same gate. It is one recheck of
    // active membership and access class, so a relationship that has ended and
    // one that was never a member's read alike here.
    await expect(workspace().spaceSummary({ workspaceId: WORKSPACE_ID, userId: INACTIVE, spaceId }))
      .resolves.toMatchObject({ ok: false, code: "space_access_denied" });
  });

  it("given a reservation, when the Space's own directory effect lands, then it supersedes it", async () => {
    const spaceId = await reserve("Hiring");

    await workspace().applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [spaceEnvelope(spaceId, spaceDirectoryEffect("Hiring team", "personal"), 2)],
    });

    // The reservation commits its hosted parent's provisional projection at
    // version one, so the Space's next projection applies over it under the
    // ordinary fence instead of colliding with it at the same version under a
    // different hash. It takes the title and never the scope, which is
    // WorkspaceDO's own: a stale `personal` does not make the Space private.
    await expect(workspace().spaceSummary({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId }))
      .resolves.toMatchObject({ ok: true, space: { name: "Hiring team", scope: "workspace" } });
  });

  it("given a Space's activity event, when it reaches the workspace, then only its directory effect applies", async () => {
    const spaceId = await reserve("Hiring");
    const activity: ParentEffect = {
      kind: "activity_event",
      eventId: "00000000-0000-7000-8000-00000000cf08",
      eventType: "message_created",
      subjectSequenceNumber: null,
      actorType: "user",
      actorUserId: OWNER,
      actorLabel: "Someone",
      title: "Said something",
      body: "",
      canonicalUrl: null,
      digestible: true,
      occurredAt: "2026-09-19T00:00:00.000Z",
      sourceKind: "conversation",
      sourceId: null,
      dedupeKey: "space-activity-control",
      metadata: {},
      targets: [],
    };

    // Asserted inside the object rather than across the RPC boundary: a
    // rejection returned over a stub is also reported to the harness as an
    // unhandled error in the object, which is noise rather than a finding.
    await expect(runInDurableObject(workspace(), (instance) =>
      instance.applyWorkstreamDirectoryEffects({
        workspaceId: WORKSPACE_ID,
        envelopes: [spaceEnvelope(spaceId, activity, 1)],
      }))).rejects.toThrow(/effect/u);
    // The same address's directory effect does apply, so what is refused is the
    // feed reaching the Organization rather than the Space being unknown to it.
    await workspace().applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [spaceEnvelope(spaceId, spaceDirectoryEffect("Hiring", "workspace"), 2)],
    });
    expect(await workspace().runInspectionSql({
      sql: "SELECT COUNT(*) AS count FROM workspace_activity_events",
      bindings: [],
    })).toMatchObject({ rows: [{ count: 0 }] });
    expect(await workspace().runInspectionSql({
      sql: "SELECT space_id FROM spaces",
      bindings: [],
    })).toMatchObject({ rows: [{ space_id: spaceId }] });
  });

  it("given a staged membership, when finalization is skipped, then the Channel is not in the Space", async () => {
    const spaceId = await reserve("Company");
    await publishChannel(CHANNEL_A, null);

    const plan = await withSpaceStorage(workspace(), (storage) => storage.prepareMembership({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, workstreamId: CHANNEL_A,
    }));

    expect(plan).toMatchObject({ ok: true, membershipGeneration: 1 });
    // The membership exists and is deliberately invisible: a placement whose
    // audience has not been applied must not reach a client, because the people
    // it would show it to have not been granted anything.
    expect(await workspace().runInspectionSql({
      sql: "SELECT state FROM space_channel_memberships WHERE space_id = ? AND workstream_id = ?",
      bindings: [spaceId, CHANNEL_A],
    })).toMatchObject({ rows: [{ state: "joining" }] });
    await expect(workspace().spaceSummary({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId }))
      .resolves.toMatchObject({ ok: true, space: { channelCount: 0 } });
    await expect(workspace().listSpaceChannels({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, cursor: null,
    })).resolves.toMatchObject({ ok: true, page: { items: [], nextCursor: null } });
  });

  it("given a personal member Channel, when somebody outside it reads the Space, then it is not listed", async () => {
    const spaceId = await reserve("Company");
    await publishChannel(CHANNEL_A, null);
    await publishPersonalChannel(CHANNEL_C, MEMBER);
    await place(spaceId, CHANNEL_A);
    await place(spaceId, CHANNEL_C);

    // The page is a read of the Channel directory, so it answers the reader
    // rather than the Space. A personal Channel inside a Space somebody else
    // can see is still a Channel they may not open, and a page that named it
    // would be a way to enumerate them — the membership row says where the
    // Channel lives, never who may see it.
    await expect(workspace().listSpaceChannels({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, cursor: null,
    })).resolves.toMatchObject({
      ok: true,
      page: { items: [{ id: CHANNEL_A }], nextCursor: null },
    });
    await expect(workspace().listSpaceChannels({
      workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId, cursor: null,
    })).resolves.toMatchObject({
      ok: true,
      page: { items: [{ id: CHANNEL_A }, { id: CHANNEL_C }], nextCursor: null },
    });
  });

  it("given a staged membership, when the Space moved before finalization, then it is refused", async () => {
    const spaceId = await reserve("Company");
    await publishChannel(CHANNEL_A, null);
    const plan = await withSpaceStorage(workspace(), (storage) => storage.prepareMembership({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, workstreamId: CHANNEL_A,
    }));
    if (!plan.ok) throw new Error(plan.code);

    // The Space's participants change underneath the staged membership,
    // which advances the revision the membership was staged against, so
    // settling now would publish a placement fenced on a Space that no longer
    // exists in that form.
    await workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId,
      audience: { scope: "workspace", participantUserIds: [OWNER] },
    });

    expect(await withSpaceStorage(workspace(), (storage) => storage.finalizeMembership({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId,
      workstreamId: CHANNEL_A,
      spaceRevision: plan.space.revision,
      membershipGeneration: plan.membershipGeneration,
    }))).toBe("conflict");
  });

  it("given a settled membership, when the Space is read, then the Channel is listed and counted", async () => {
    const spaceId = await reserve("Company");
    await publishChannel(CHANNEL_A, null);
    await publishChannel(CHANNEL_B, "2026-09-19T00:00:00.000Z");
    await place(spaceId, CHANNEL_A);
    await place(spaceId, CHANNEL_B);

    // An archived Channel keeps its membership — that row is what returns it to
    // the Space if it is unarchived — while no list renders it, so the count a
    // screen reads and the membership rows deliberately differ.
    await expect(workspace().spaceSummary({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId }))
      .resolves.toMatchObject({ ok: true, space: { channelCount: 1 } });
    // Channels rather than ids: the page is projected through the same
    // directory select and mapper the sidebar's own list uses, so a Space page
    // and a sidebar row cannot drift. The placement travels on the row, which
    // is what lets a client draw the Channel under its Space on first paint.
    // `kind` is what lets one row type carry a breakout beside it; the
    // dashboard list and its breakouts are proved in
    // `space-conversation-page.test.ts`.
    await expect(workspace().listSpaceChannels({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, cursor: null,
    })).resolves.toMatchObject({
      ok: true,
      page: {
        items: [{ id: CHANNEL_A, spaceIds: [spaceId], kind: "channel", breakoutOf: null }],
        nextCursor: null,
      },
    });
    // Both memberships are active, the archived Channel's included.
    await expect(workspace().runInspectionSql({
      sql: `SELECT workstream_id, state, generation FROM space_channel_memberships
              WHERE space_id = ? ORDER BY workstream_id`,
      bindings: [spaceId],
    })).resolves.toMatchObject({
      rows: [
        { workstream_id: CHANNEL_A, state: "active", generation: 1 },
        { workstream_id: CHANNEL_B, state: "active", generation: 1 },
      ],
    });
    await expect(workspace().channelSpaces({
      workspaceId: WORKSPACE_ID, userId: OWNER, workstreamId: CHANNEL_A,
    })).resolves.toEqual({ spaceIds: [spaceId] });
  });

  it("chooses one active Space placement for a Channel", async () => {
    const first = await reserve("First");
    const second = await reserve("Second");
    await publishChannel(CHANNEL_A, null);
    await place(second, CHANNEL_A);
    await place(first, CHANNEL_A);
    await expect(workspace().canonicalChannelSpace({ workspaceId: WORKSPACE_ID, workstreamId: CHANNEL_A }))
      .resolves.toEqual({ spaceId: [first, second].sort()[0] });
    await expect(workspace().canonicalChannelSpace({ workspaceId: WORKSPACE_ID, workstreamId: CHANNEL_B }))
      .resolves.toEqual({ spaceId: null });
  });

  it("prefers an Organization-wide placement over a personal Space for a shared Channel link", async () => {
    const personal = await reserve("Personal", "personal");
    const shared = await reserve("Shared", "workspace");
    await publishChannel(CHANNEL_A, null);
    await place(personal, CHANNEL_A);
    await place(shared, CHANNEL_A);
    await expect(workspace().canonicalChannelSpace({ workspaceId: WORKSPACE_ID, workstreamId: CHANNEL_A }))
      .resolves.toEqual({ spaceId: shared });
  });

  it("given a Channel in a personal Space, when another member can read it, then that Space is not named to them", async () => {
    const personal = await reserve("Side work", "personal");
    const organization = await reserve("Company", "workspace");
    await publishChannel(CHANNEL_A, null);
    await place(personal, CHANNEL_A);
    await place(organization, CHANNEL_A);

    // A personal Space is the product's private Channel, listed to its
    // participants alone. The ids ride a *Channel*, which several people read,
    // and this member can read this one — but naming the private Space it is
    // placed in to somebody its owners did not add is the one thing making it
    // private is for. Its own participant still sees both placements.
    await expect(workspace().channelSpaces({
      workspaceId: WORKSPACE_ID, userId: OWNER, workstreamId: CHANNEL_A,
    })).resolves.toEqual({ spaceIds: [organization, personal] });
    await expect(workspace().channelSpaces({
      workspaceId: WORKSPACE_ID, userId: MEMBER, workstreamId: CHANNEL_A,
    })).resolves.toEqual({ spaceIds: [organization] });

    // And on the directory row itself, which is where a client reads them.
    const { socket, sidebar } = await connectViewer(MEMBER, "cf14");
    expect(sidebar.workstreams.items).toMatchObject([
      { id: CHANNEL_A, spaceIds: [organization] },
    ]);
    socket.close();
  });

  it("given a personal Space or a Channel a guest cannot read, when they list Spaces, then only a shared Space holding their Channel is named", async () => {
    const personal = await reserve("Side work", "personal");
    const reachable = await reserve("Company", "workspace");
    const hidden = await reserve("Private plans", "workspace");
    await publishChannel(CHANNEL_A, null);
    await publishViewerRow(CHANNEL_A, GUEST, 1, { isParticipant: true });
    await publishPersonalChannel(CHANNEL_B, OWNER);
    await place(personal, CHANNEL_A);
    await place(reachable, CHANNEL_A);
    await place(hidden, CHANNEL_B);

    // A personal Space is named to its participants alone, however readable
    // the Channel placed in it is: the member and the guest can both read
    // `CHANNEL_A`, and neither is told the private Space it sits in.
    for (const viewer of [MEMBER, GUEST]) {
      await expect(workspace().spaceSummary({
        workspaceId: WORKSPACE_ID, userId: viewer, spaceId: personal,
      })).resolves.toMatchObject({ ok: false, code: "space_not_found" });
    }
    expect((await spaceDirectories(MEMBER)).active.items.map((item) => item.id))
      .toEqual([reachable, hidden]);

    // A guest is never admitted by Organization-wide scope, so a shared Space
    // reaches them only through a Channel in it — and the Channel predicate is
    // the Channel directory's own. Without that half every shared Space in the
    // Organization would be named to every guest.
    const directory = (await spaceDirectories(GUEST)).active.items;
    expect(directory.map((item) => item.id)).toEqual([reachable]);
    expect(directory[0]).toMatchObject({ reach: "through_channel" });
    await expect(workspace().spaceSummary({
      workspaceId: WORKSPACE_ID, userId: GUEST, spaceId: hidden,
    })).resolves.toMatchObject({ ok: false, code: "space_not_found" });
  });

  it("given a Space reached through a Channel, when its summary is read, then it carries the mark and nothing else", async () => {
    // Only a guest reaches a Space through a Channel now: a member is admitted
    // to every shared Space by its scope, and a personal one by participation.
    const shared = await reserve("Side work", "workspace");
    await publishChannel(CHANNEL_A, null);
    await publishViewerRow(CHANNEL_A, GUEST, 1, { isParticipant: true });
    await publishPersonalChannel(CHANNEL_B, OWNER);
    await place(shared, CHANNEL_A);
    await place(shared, CHANNEL_B);
    await workspace().addSpaceDefault({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: shared, kind: "resource", targetId: RESOURCE_ID,
    });

    const owner = await workspace().spaceSummary({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: shared,
    });
    expect(owner).toMatchObject({
      ok: true,
      space: {
        reach: "participant",
        name: "Side work",
        participants: [{ userId: OWNER }],
        defaultResourceIds: [RESOURCE_ID],
        channelCount: 2,
      },
    });

    // The disclosure is the mark, the name and the lifecycle. Who is in the
    // Space and what it hands down are not, and the count is this viewer's:
    // the Organization's would count Channels this guest was never added to.
    const other = await workspace().spaceSummary({
      workspaceId: WORKSPACE_ID, userId: GUEST, spaceId: shared,
    });
    expect(other).toMatchObject({
      ok: true,
      space: {
        reach: "through_channel",
        name: "Side work",
        iconKey: "briefcase",
        colorKey: "blue",
        scope: "workspace",
        status: "active",
        participants: [],
        defaultResourceIds: [],
        defaultSidekickIds: [],
        channelCount: 1,
      },
    });
  });

  it("given a Space reached through a Channel, when the viewer's socket connects, then the snapshot names its reach", async () => {
    const shared = await reserve("Side work", "workspace");
    const organization = await reserve("Company", "workspace");
    await publishChannel(CHANNEL_A, null);
    await publishViewerRow(CHANNEL_A, GUEST, 1, { isParticipant: true });
    await place(shared, CHANNEL_A);

    // Space state rides the socket and nowhere else, so this is the read every
    // surface actually decides from — the reach has to be on it, per Space,
    // or the sidebar cannot tell the row it may write on from the one it may
    // not. The same Space reads three ways to three relationships.
    expect((await spaceDirectories(GUEST)).active.items).toMatchObject([
      { id: shared, reach: "through_channel" },
    ]);
    expect((await spaceDirectories(MEMBER)).active.items).toMatchObject([
      { id: shared, reach: "organization" },
      { id: organization, reach: "organization" },
    ]);
    expect((await spaceDirectories(OWNER)).active.items).toMatchObject([
      { id: shared, reach: "participant" },
      { id: organization, reach: "participant" },
    ]);
  });

  it("given a Space reached through a Channel, when that viewer writes on it, then every write is refused by name", async () => {
    const shared = await reserve("Side work", "workspace");
    const elsewhere = await reserve("Company", "workspace");
    await publishChannel(CHANNEL_A, null);
    await publishChannel(CHANNEL_B, null);
    await publishViewerRow(CHANNEL_A, GUEST, 1, { isParticipant: true });
    await publishViewerRow(CHANNEL_B, GUEST, 1, { isParticipant: true });
    await place(shared, CHANNEL_A);
    await place(elsewhere, CHANNEL_A);
    expect((await spaceDirectories(GUEST)).active.items)
      .toMatchObject([{ id: shared, reach: "through_channel" }, { id: elsewhere, reach: "through_channel" }]);

    const asGuest = { workspaceId: WORKSPACE_ID, userId: GUEST, spaceId: shared };
    // `space_access_denied` rather than `space_not_found`: they are looking at
    // the row. Every operation kind, because each of these used to be gated on
    // "may I see this Space" alone, and that question answers yes here.
    //
    // Only a guest reaches a Space through a Channel now, and the Space write
    // gate refuses every guest before it asks about reach. So this proves the
    // refusal's name for the one viewer who can hold this reach, not the
    // reach check itself, which no member can arrive at any more.
    const refusals = await Promise.all([
      workspace().noteSpacePresentation({
        ...asGuest, presentation: { name: "Theirs now", iconKey: "star", colorKey: "red" },
      }),
      workspace().noteSpaceAudience({
        ...asGuest,
        audience: { scope: "workspace", participantUserIds: [GUEST] },
      }),
      workspace().archiveSpace(asGuest),
      workspace().restoreSpace(asGuest),
      workspace().addSpaceDefault({ ...asGuest, kind: "resource", targetId: RESOURCE_ID }),
      workspace().removeSpaceDefault({ ...asGuest, kind: "resource", targetId: RESOURCE_ID }),
    ]);
    for (const refusal of refusals) {
      expect(refusal).toMatchObject({ ok: false, code: "space_access_denied" });
    }
    // A Channel's membership, which is refused before the Channel is asked
    // anything, so neither of these has a conversation behind it.
    const guestActor = {
      sessionId: `space-session-${GUEST}`, userId: GUEST, workspaceId: WORKSPACE_ID,
      region: "global" as const, role: null,
    };
    const channelChanges = await Promise.all([
      workspace().addSpaceChannel({ auth: guestActor, spaceId: shared, workstreamId: CHANNEL_B }),
      workspace().removeSpaceChannel({ auth: guestActor, spaceId: shared, workstreamId: CHANNEL_A }),
    ]);
    for (const refusal of channelChanges) {
      expect(refusal).toMatchObject({ ok: false, refusal: { about: "space", code: "space_access_denied" } });
    }

    // Nothing moved: the Space is as its own participant left it.
    await expect(workspace().spaceSummary({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: shared,
    })).resolves.toMatchObject({
      ok: true,
      space: { name: "Side work", scope: "workspace", status: "active", revision: 1 },
    });
  });

  it("given the only Channel reaching a viewer into a Space, when their participation moves, then the Space leaves and returns without a reconnect", async () => {
    const shared = await reserve("Side work", "workspace");
    // `CHANNEL_C` is this guest's whole reach into the Space: Organization-wide
    // scope never admits a guest, so only their participation lists it.
    await publishChannel(CHANNEL_C, null);
    await publishViewerRow(CHANNEL_C, GUEST, 1, { isParticipant: true });
    await place(shared, CHANNEL_C);
    expect((await spaceDirectories(GUEST)).active.items.map((item) => item.id))
      .toEqual([shared]);

    const guest = await connectViewer(GUEST, "f3");
    const snapshots = collectSpaceSnapshots(guest.socket);

    // The Space's own predicate is live on every read, so nothing here was
    // ever *readable* — what outlived the reach is the name, on the sidebar
    // and, mirrored into the desktop's local cache, across a restart.
    await publishViewerRow(CHANNEL_C, GUEST, 2, { isParticipant: false });
    await publishViewerRow(CHANNEL_C, GUEST, 3, { isParticipant: true });
    // An unread count arrives on every message in every Channel this person is
    // in and moves no Space at all. Republishing on it would rebuild both
    // directories for them on the hottest path this object has.
    await publishViewerRow(CHANNEL_C, GUEST, 4, { isParticipant: true, unreadCount: 3 });
    await publishViewerRow(CHANNEL_C, GUEST, 5, { isParticipant: false });

    await settleNudges(snapshots, 3);
    expect(snapshots).toEqual([[], [shared], []]);
    guest.socket.close();
  });

  it("given a guest added to a Channel and then taken out, when they hold a socket, then its public thread arrives and then leaves their sidebar", async () => {
    const shared = await reserve("Side work", "workspace");
    await publishChannel(CHANNEL_A, null);
    await place(shared, CHANNEL_A);
    const guest = await connectViewer(GUEST, "f4");
    const audience = (participantUserIds: UserId[]) => workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: shared,
      audience: { scope: "workspace", participantUserIds },
    });

    const gained = nextWorkstreamStateFor(guest.socket, CHANNEL_A);
    await audience([OWNER, GUEST]);
    const row = (await gained).workstream;
    expect(row?.id).toBe(CHANNEL_A);
    expect(row?.mainWithheld ?? false).toBe(false);

    const lost = nextWorkstreamStateFor(guest.socket, CHANNEL_A);
    await audience([OWNER]);
    expect((await lost).workstream).toBeNull();
    guest.socket.close();
  });

  it("given a Space this viewer has no reach into, when its summary is read, then the row is not rendered at all", async () => {
    const personal = await reserve("Side work", "personal");
    const organization = await reserve("Company", "workspace");
    await publishPersonalChannel(CHANNEL_B, OWNER);
    await place(personal, CHANNEL_B);

    // The one read that renders a single Space row goes through the same
    // visibility predicate the directory does, rather than through a second
    // gate beside it. Without the filter on that read the row still comes back
    // — labelled `through_channel`, which is what the reach column says about
    // any row that reaches it, whether or not it is reachable at all.
    await expect(workspace().spaceSummary({
      workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId: personal,
    })).resolves.toMatchObject({ ok: false, code: "space_not_found" });
    // And the Organization-wide one beside it is answered, so the refusal is
    // about this viewer's reach rather than about the read being broken.
    await expect(workspace().spaceSummary({
      workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId: organization,
    })).resolves.toMatchObject({ ok: true, space: { reach: "organization" } });
  });

  it("given a Space reached through a Channel, when a Channel they cannot see moves in it, then no nudge names it", async () => {
    const shared = await reserve("Side work", "workspace");
    const holding = await reserve("Company", "workspace");
    await publishChannel(CHANNEL_A, null);
    await publishChannel(CHANNEL_C, null);
    await publishViewerRow(CHANNEL_A, GUEST, 1, { isParticipant: true });
    await publishViewerRow(CHANNEL_C, GUEST, 1, { isParticipant: true });
    await publishPersonalChannel(CHANNEL_B, OWNER);
    // `CHANNEL_A` is the whole of GUEST's reach into the shared Space and
    // never moves. `holding` is where the other two live, so taking either of
    // them out of the shared Space leaves it discoverable and the removals
    // below are about the nudge rather than about a stranded Channel.
    await place(shared, CHANNEL_A);
    await place(holding, CHANNEL_A);
    await place(holding, CHANNEL_B);
    await place(holding, CHANNEL_C);

    const guest = await connectViewer(GUEST, "f1");
    const owner = await connectViewer(OWNER, "f2");
    const guestNudges = collectSpaceNudges(guest.socket);
    const ownerNudges = collectSpaceNudges(owner.socket);

    // The nudge is addressed through the Channel that moved. A viewer who
    // reaches this Space through a *different* Channel sees the same page
    // before and after, so a nudge would be the whole of the signal —
    // something was just put into or taken out of this Space — and repeated
    // it is a live feed of Channels they were never added to, sent to
    // somebody who is told only the Space's name.
    const placed = nextWorkstreamStateFor(guest.socket, CHANNEL_C);
    await place(shared, CHANNEL_B);
    await place(shared, CHANNEL_C);
    await placed;

    // A removal has to name the Space alongside the Channel: by the time this
    // publishes, the membership is `removed`, so the Channel no longer
    // resolves to the Space it just left and a dashboard still holding its row
    // would never hear.
    const displaced = nextWorkstreamStateFor(guest.socket, CHANNEL_C);
    await displace(shared, CHANNEL_B);
    await displace(shared, CHANNEL_C);
    await displaced;

    // Both `CHANNEL_C` moves, and neither `CHANNEL_B` move: the row this
    // person's page holds changed exactly twice. The socket delivers in order,
    // so a nudge from either `CHANNEL_B` step would already be in this array.
    expect(guestNudges).toEqual([[shared], [shared]]);

    // And the Space's own participant, who can see all three Channels, was
    // nudged by every one of the four — so the silence above is about what
    // this viewer can see rather than about a nudge that stopped working.
    await settleNudges(ownerNudges, 4);
    expect(ownerNudges).toEqual([[shared], [shared], [shared], [shared]]);
    guest.socket.close();
    owner.socket.close();
  });

  it("given a Space reached through a Channel, when that viewer arranges it, then it is refused as every guest write is", async () => {
    const shared = await reserve("Side work", "workspace");
    const elsewhere = await reserve("Company", "workspace");
    await publishChannel(CHANNEL_A, null);
    await publishChannel(CHANNEL_B, null);
    await publishViewerRow(CHANNEL_A, GUEST, 1, { isParticipant: true });
    await publishViewerRow(CHANNEL_B, GUEST, 1, { isParticipant: true });
    await place(shared, CHANNEL_A);
    await place(shared, CHANNEL_B);
    await place(elsewhere, CHANNEL_A);
    expect((await spaceDirectories(GUEST)).active.items.map((item) => item.id))
      .toEqual([shared, elsewhere]);

    // An arrangement is this person's own view preference, read by nobody
    // else, so a `through_channel` reach is no reason to refuse it. But only
    // a guest holds that reach now, and `reorderContainer` passes the same
    // gate as every Space write, which admits members only — so what used to
    // be written for a member reaching a personal Space is refused here, by
    // the relationship rather than by the reach.
    await expect(workspace().reorderContainer({
      workspaceId: WORKSPACE_ID,
      userId: GUEST,
      order: { container: { kind: "organization" }, itemIds: [elsewhere, shared] },
    })).resolves.toMatchObject({ ok: false, code: "space_access_denied" });
    await expect(workspace().reorderContainer({
      workspaceId: WORKSPACE_ID,
      userId: GUEST,
      order: { container: { kind: "space", id: shared }, itemIds: [CHANNEL_B, CHANNEL_A] },
    })).resolves.toMatchObject({ ok: false, code: "space_access_denied" });

    // Nothing was written: the guest's sidebar keeps the order it had.
    expect((await spaceDirectories(GUEST)).active.items.map((item) => item.id))
      .toEqual([shared, elsewhere]);
  });

  it("given a Space reached through a Channel, when it is archived, then that viewer is handed neither list", async () => {
    const shared = await reserve("Side work", "workspace");
    const elsewhere = await reserve("Company", "workspace");
    await publishChannel(CHANNEL_A, null);
    await publishViewerRow(CHANNEL_A, GUEST, 1, { isParticipant: true });
    await place(shared, CHANNEL_A);
    await place(elsewhere, CHANNEL_A);
    expect((await spaceDirectories(GUEST)).active.items.map((item) => item.id))
      .toEqual([shared, elsewhere]);

    await workspace().archiveSpace({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: shared });

    // An archive takes every membership out of `active` before it commits, so
    // nobody reaches an archived Space through a Channel in it — and no
    // surface draws a Channel under an archived Space, so there would be
    // nothing for its mark and name to explain. Its own participant keeps it
    // in the inactive list, which is what the restore control is drawn from.
    const forGuest = await spaceDirectories(GUEST);
    expect(forGuest.active.items.map((item) => item.id)).toEqual([elsewhere]);
    expect(forGuest.inactive.items).toEqual([]);
    expect((await spaceDirectories(OWNER)).inactive.items)
      .toMatchObject([{ id: shared, reach: "participant" }]);
  });

  it("given an open socket, when a Channel is placed, then its row is pushed with the placement", async () => {
    const spaceId = await reserve("Company", "workspace");
    await publishChannel(CHANNEL_A, null);
    const { socket } = await connectViewer(MEMBER, "cf15");

    // The placement has to reach an *open* client. Everything else here reads
    // the connect payload, which a reload produces — and a placement that only
    // appears after one is a placement the person who made it does not see.
    // The first write to this Channel also closes its import ledger, which
    // republishes the row as it stood before the placement; wait past that one.
    const pushed = nextWorkstreamStateWhere(socket, (event) => (event.workstream?.spaceIds.length ?? 0) > 0);
    await place(spaceId, CHANNEL_A);
    const event = await pushed;

    expect(event.workstreamId).toBe(CHANNEL_A);
    expect(event.workstream?.spaceIds).toEqual([spaceId]);
    socket.close();
  });

  it("given a Channel already in a Space, when it is added again, then the add succeeds", async () => {
    const spaceId = await reserve("Company");
    await publishChannel(CHANNEL_A, null);
    await place(spaceId, CHANNEL_A);

    // Adding a Channel a Space already holds is the ordinary shape of a retry,
    // and of two people dragging the same Channel onto the same Space.
    // `prepareMembership` answers it with the generation the membership
    // already has rather than staging a new one, so the settlement has nothing
    // to activate — and answering that as "not found" turned an idempotent add
    // into a 404.
    await place(spaceId, CHANNEL_A);

    await expect(workspace().spaceSummary({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId }))
      .resolves.toMatchObject({ ok: true, space: { channelCount: 1 } });
    expect(await workspace().runInspectionSql({
      sql: `SELECT state, generation FROM space_channel_memberships
             WHERE space_id = ? AND workstream_id = ?`,
      bindings: [spaceId, CHANNEL_A],
    })).toMatchObject({ rows: [{ state: "active", generation: 1 }] });
  });

  it("given a Channel in one Space, when that membership is removed, then it is refused as final", async () => {
    const spaceId = await reserve("Company");
    await publishChannel(CHANNEL_A, null);
    await place(spaceId, CHANNEL_A);

    await expect(withSpaceStorage(workspace(), (storage) => storage.prepareMembershipRemoval({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId,
      workstreamId: CHANNEL_A,
    }))).resolves.toMatchObject({ ok: false, code: "space_membership_final" });
  });

  it("given a direct Channel reader, when a membership is removed, then the remaining Space is associatively discoverable", async () => {
    const organization = await reserve("Company", "workspace");
    const shared = await reserve("Side work", "workspace");
    await publishChannel(CHANNEL_A, null);
    await publishViewerRow(CHANNEL_A, GUEST, 1, { isParticipant: true });
    await place(organization, CHANNEL_A);
    await place(shared, CHANNEL_A);

    // A guest reading `CHANNEL_A` directly still finds the Space it remains in
    // once the other placement is gone. A personal Space would not be found
    // this way: only its participants are told it exists.
    await displace(organization, CHANNEL_A);
    await expect(workspace().spaceSummary({
      workspaceId: WORKSPACE_ID, userId: GUEST, spaceId: shared,
    })).resolves.toMatchObject({ ok: true, space: {
      id: shared,
      name: "Side work",
      scope: "workspace",
      reach: "through_channel",
      participants: [],
    } });
  });

  it("given a Channel in two Spaces, when one membership is removed, then the other keeps it", async () => {
    const organization = await reserve("Company", "workspace");
    const second = await reserve("Recruiting", "workspace");
    await publishChannel(CHANNEL_A, null);
    await place(organization, CHANNEL_A);
    await place(second, CHANNEL_A);

    await displace(organization, CHANNEL_A);

    await expect(workspace().channelSpaces({
      workspaceId: WORKSPACE_ID, userId: OWNER, workstreamId: CHANNEL_A,
    })).resolves.toEqual({ spaceIds: [second] });
  });

  it("given a pinned placement, when it is removed, then connected directories lose only that Space's pin", async () => {
    const removedSpace = await reserve("Company", "workspace");
    const retainedSpace = await reserve("Recruiting", "workspace");
    await publishChannel(CHANNEL_A, null);
    await place(removedSpace, CHANNEL_A);
    await place(retainedSpace, CHANNEL_A);
    for (const spaceId of [removedSpace, retainedSpace]) {
      await workspace().pinWorkstream({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        spaceId,
        workstreamId: CHANNEL_A,
      });
    }

    const { socket } = await connectViewer(OWNER, "f001");
    const directorySyncs = collectDirectorySyncs(socket);
    try {
      await displace(removedSpace, CHANNEL_A);
      await settleNudges(directorySyncs.topics, 1);

      expect(directorySyncs.topics, directorySyncs.raw.join("\n")).toHaveLength(1);
      await expect(workspace().listWorkstreams({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        limit: 20,
        includeSystem: false,
      })).resolves.toMatchObject({
        items: [{
          id: CHANNEL_A,
          spaceIds: [retainedSpace],
          spacePins: [{ spaceId: retainedSpace, position: 0 }],
        }],
      });
    } finally {
      socket.close();
    }
  });

  /**
   * The order row is about the placement, so it leaves with the placement — and
   * for everybody, because the placement was the Organization's fact rather
   * than the remover's. Otherwise it outlives the thing it describes for
   * everybody who does not happen to arrange that Space again.
   */
  it("given an arranged Space, when a Channel is removed from it, then nobody's order still names it", async () => {
    const spaceId = await reserve("Company", "workspace");
    const second = await reserve("Recruiting", "workspace");
    await publishChannel(CHANNEL_A, null);
    await publishChannel(CHANNEL_B, null);
    for (const channelId of [CHANNEL_A, CHANNEL_B]) {
      await place(spaceId, channelId);
      await place(second, channelId);
    }
    for (const userId of [OWNER, MEMBER]) {
      await workspace().reorderContainer({
        workspaceId: WORKSPACE_ID,
        userId,
        order: { container: { kind: "space", id: spaceId }, itemIds: [CHANNEL_B, CHANNEL_A] },
      });
    }

    await displace(spaceId, CHANNEL_B);

    // The remover's, and the member's who never touched it.
    expect(storedItemIds(await personalOrder(OWNER), "space", spaceId)).toEqual([CHANNEL_A]);
    expect(storedItemIds(await personalOrder(MEMBER), "space", spaceId)).toEqual([CHANNEL_A]);
    // And only that Space's. The Channel is still in the other one, where the
    // same person's arrangement of it is untouched.
    expect(storedItemIds(await personalOrder(OWNER), "space", second)).toBeNull();
  });

  it("refuses archiving a Channel when an exclusive private thread is unreadable by the requester", async () => {
    const spaceId = await reserve("Company");
    const second = await reserve("Recruiting");
    await publishPersonalChannel(CHANNEL_A, MEMBER);
    await place(spaceId, CHANNEL_A);

    await expect(workspace().archiveSpace({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId }))
      .resolves.toMatchObject({ ok: false, code: "space_membership_final" });

    await place(second, CHANNEL_A);
    await expect(workspace().archiveSpace({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId }))
      .resolves.toMatchObject({ ok: true, space: { status: "archived" } });
    // The archived Space leaves the active directory for the inactive one,
    // which is what the sidebar's restore control is drawn from.
    const directories = await spaceDirectories(OWNER);
    expect(directories.inactive.items).toMatchObject([{ id: spaceId }]);
    expect(directories.active.items.map((item) => item.id)).not.toContain(spaceId);
  });

  it("given a Space whose only Channel has no directory row, when it is archived, then it is refused", async () => {
    const spaceId = await reserve("Company");
    await place(spaceId, CHANNEL_A);

    // The Channel is live; its directory projection has not landed. Inner-joining
    // `channels` would drop it from the guard and archive the Space out from
    // under it. Fail closed: unknown is not the same as archived.
    await expect(workspace().archiveSpace({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId }))
      .resolves.toMatchObject({ ok: false, code: "space_membership_final" });
  });

  it("given a Space whose only Channel is archived, when it is archived, then it is accepted", async () => {
    const spaceId = await reserve("Company");
    await publishChannel(CHANNEL_A, "2026-09-19T00:00:00.000Z");
    await place(spaceId, CHANNEL_A);

    await expect(workspace().spaceSummary({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId,
    })).resolves.toMatchObject({ ok: true, space: { channelCount: 0 } });

    await expect(workspace().archiveSpace({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId }))
      .resolves.toMatchObject({ ok: true, space: { status: "archived" } });

    // The archived Channel's membership is held `removing` by the archive,
    // which is what a restore puts back.
    expect(await workspace().runInspectionSql({
      sql: `SELECT state FROM space_channel_memberships
             WHERE space_id = ? AND workstream_id = ?`,
      bindings: [spaceId, CHANNEL_A],
    })).toMatchObject({ rows: [{ state: "removing" }] });
  });

  it("records an archive intent only for the live exclusive thread", async () => {
    const spaceId = await reserve("Company");
    await publishChannel(CHANNEL_A, null);
    await publishChannel(CHANNEL_B, "2026-09-19T00:00:00.000Z");
    await place(spaceId, CHANNEL_A);
    await place(spaceId, CHANNEL_B);

    await expect(workspace().archiveSpace({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId })).resolves.toMatchObject({
      ok: true, space: { status: "archived" },
    });
    // This authority-only fixture has directory rows but no canonical thread:
    // the requested archive must remain durable until that authority responds.
    expect(await workspace().runInspectionSql({
      sql: "SELECT workstream_id, state FROM space_intents WHERE kind = 'archive'", bindings: [],
    })).toMatchObject({ rows: [{ workstream_id: CHANNEL_A, state: "pending" }] });
  });

  it("given an archived Space, when it is restored, then its memberships come back", async () => {
    const spaceId = await reserve("Company");
    const second = await reserve("Recruiting");
    await publishChannel(CHANNEL_A, null);
    await place(spaceId, CHANNEL_A);
    await place(second, CHANNEL_A);
    await expect(workspace().archiveSpace({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId }))
      .resolves.toMatchObject({ ok: true });
    expect(await workspace().runInspectionSql({
      sql: "SELECT state FROM space_channel_memberships WHERE space_id = ? AND workstream_id = ?",
      bindings: [spaceId, CHANNEL_A],
    })).toMatchObject({ rows: [{ state: "removing" }] });

    await expect(workspace().restoreSpace({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId,
    })).resolves.toMatchObject({ ok: true, space: { status: "active", channelCount: 1 } });
    await expect(workspace().channelSpaces({
      workspaceId: WORKSPACE_ID, userId: OWNER, workstreamId: CHANNEL_A,
    })).resolves.toEqual({ spaceIds: [spaceId, second].sort() });
    // One transaction, so nothing is left for an alarm to finish: neither the
    // archive nor the restore stages an intent.
    expect(await workspace().runInspectionSql({
      sql: "SELECT state FROM space_channel_memberships WHERE space_id = ? AND workstream_id = ?",
      bindings: [spaceId, CHANNEL_A],
    })).toMatchObject({ rows: [{ state: "active" }] });
    expect(await workspace().runInspectionSql({ sql: "SELECT operation_id FROM space_intents", bindings: [] }))
      .toMatchObject({ rows: [] });
  });

  it("given General, when it is archived, then it is refused", async () => {
    const general = await openGeneral();
    expect(general).toMatchObject({ created: true, space: { name: "General", systemRole: "general" } });

    await expect(workspace().archiveSpace({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: general.space.id,
    })).resolves.toMatchObject({ ok: false, code: "space_protected" });

    // Idempotent: a second caller gets the same General rather than a second
    // one, which is what the unique partial index on the role is for.
    const again = await workspace().openGeneralSpace({
      workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId: asSpaceId("00000000-0000-7000-8000-00000000cf1b"),
    });
    expect(again).toMatchObject({ created: false, space: { id: general.space.id } });
  });

  it("given two callers racing for General, when both run, then the Organization has one", async () => {
    // Both reserve; the index refuses the loser, and the answer it owes is the
    // Space the winner made. There is no read in front of the insert to lose
    // the race in, which is the point — a check-then-write here is how an
    // Organization ends up with two fallbacks.
    const [first, second] = await Promise.all([
      workspace().openGeneralSpace({
        workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: asSpaceId("00000000-0000-7000-8000-00000000cf1c"),
      }),
      workspace().openGeneralSpace({
        workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId: asSpaceId("00000000-0000-7000-8000-00000000cf1d"),
      }),
    ]);
    if (!first.ok || !second.ok || "absent" in first || "absent" in second) throw new Error("openGeneralSpace refused");

    expect(second.space.id).toBe(first.space.id);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(await workspace().runInspectionSql({
      sql: "SELECT space_id FROM spaces WHERE system_role = 'general'",
      bindings: [],
    })).toMatchObject({ rows: [{ space_id: first.space.id }] });
    // And the loser left nothing behind: a reservation writes a viewer row and
    // an order row beside the directory row, and the refused one rolls all
    // three back rather than orphaning them under an id nothing names.
    expect(await workspace().runInspectionSql({
      sql: "SELECT COUNT(*) AS count FROM spaces",
      bindings: [],
    })).toMatchObject({ rows: [{ count: 1 }] });
  });

  it("given a default, when a Channel joins after it, then it is staged for that Channel too", async () => {
    const spaceId = await reserve("Company");
    await publishChannel(CHANNEL_A, null);
    await place(spaceId, CHANNEL_A);

    const added = await workspace().addSpaceDefault({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, kind: "resource", targetId: RESOURCE_ID,
    });
    expect(added).toMatchObject({
      ok: true,
      targets: [{ workstreamId: CHANNEL_A, kind: "resource", defaultGeneration: 1 }],
    });

    await publishChannel(CHANNEL_B, null);
    await place(spaceId, CHANNEL_B);
    expect(await workspace().runInspectionSql({
      sql: `SELECT workstream_id FROM space_default_targets
             WHERE space_id = ? AND state = 'pending' ORDER BY workstream_id`,
      bindings: [spaceId],
    })).toMatchObject({ rows: [{ workstream_id: CHANNEL_A }, { workstream_id: CHANNEL_B }] });
  });

  it("given a Space with a default, when a Channel is added through addSpaceChannel, then one call activates the membership and stages the default with no intent left", async () => {
    const spaceId = await reserve("Company");
    await publishChannel(CHANNEL_A, null);
    await expect(workspace().addSpaceDefault({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, kind: "resource", targetId: RESOURCE_ID,
    })).resolves.toMatchObject({ ok: true, targets: [] });

    // The product path, as one RPC: no plan to settle, no Channel asked for
    // an audience, and nothing staged for an alarm or a Queue resume to finish.
    const owner = {
      sessionId: `space-session-${OWNER}`, userId: OWNER, workspaceId: WORKSPACE_ID,
      region: "global" as const, role: "owner" as const,
    };
    await expect(workspace().addSpaceChannel({ auth: owner, spaceId, workstreamId: CHANNEL_A }))
      .resolves.toMatchObject({ ok: true, space: { id: spaceId, channelCount: 1 } });

    expect(await workspace().runInspectionSql({
      sql: "SELECT state, generation FROM space_channel_memberships WHERE space_id = ? AND workstream_id = ?",
      bindings: [spaceId, CHANNEL_A],
    })).toMatchObject({ rows: [{ state: "active", generation: 1 }] });
    expect(await workspace().runInspectionSql({
      sql: `SELECT kind, target_id, workstream_id, membership_generation, state FROM space_default_targets
             WHERE space_id = ?`,
      bindings: [spaceId],
    })).toMatchObject({
      rows: [{
        kind: "resource", target_id: RESOURCE_ID, workstream_id: CHANNEL_A, membership_generation: 1, state: "pending",
      }],
    });
    expect(await workspace().runInspectionSql({ sql: "SELECT operation_id FROM space_intents", bindings: [] }))
      .toMatchObject({ rows: [] });
  });

  it("given a Sidekick default, when hosted Channels are or become members, then each gets it in the same write", async () => {
    const sidekickId = "00000000-0000-7000-8000-00000000cf1a";
    const spaceId = await reserve("Company");
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO automation_directory
           (automation_id, workspace_id, author_user_id, source_version, payload_hash, lifecycle, scope,
            owning_workstream_id, title, description, next_run_at, projected_at)
         VALUES (?, ?, ?, 1, 'test', 'active', 'workspace', NULL, 'Shared', '', NULL, 0)`,
        sidekickId, WORKSPACE_ID, OWNER,
      );
    });
    // Parent rows first: a directory row for a Channel with none notes it as
    // a legacy parent still to import, which Channel C below is.
    for (const channel of [CHANNEL_A, CHANNEL_B]) {
      await openMemberChannel(channel);
      await publishChannel(channel, null);
    }
    await place(spaceId, CHANNEL_A);

    const added = await workspace().addSpaceDefault({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, kind: "sidekick", targetId: sidekickId,
    });
    expect(added).toMatchObject({ ok: true, targets: [{ workstreamId: CHANNEL_A, kind: "sidekick" }] });
    // Channel B joins after the default exists: settling its membership
    // stages it, and the same in-place write applies. Channel C's parent is
    // not imported here yet, so its target keeps the Queue.
    await place(spaceId, CHANNEL_B);
    await publishChannel(CHANNEL_C, null);
    await place(spaceId, CHANNEL_C);

    const rows = async (sql: string) => (await workspace().runInspectionSql({ sql, bindings: [] })).rows;
    expect(await rows("SELECT parent_id, sidekick_id FROM parent_sidekicks ORDER BY parent_id")).toEqual([
      { parent_id: CHANNEL_A, sidekick_id: sidekickId },
      { parent_id: CHANNEL_B, sidekick_id: sidekickId },
      // The Space's own recommendation, which a Channel born in it reads.
      { parent_id: spaceId, sidekick_id: sidekickId },
    ].sort((left, right) => left.parent_id.localeCompare(right.parent_id)));
    expect(await rows("SELECT workstream_id, state FROM space_default_targets ORDER BY workstream_id")).toEqual([
      { workstream_id: CHANNEL_A, state: "applied" },
      { workstream_id: CHANNEL_B, state: "applied" },
      { workstream_id: CHANNEL_C, state: "pending" },
    ]);
    expect(await rows("SELECT workstream_id FROM space_default_publications ORDER BY workstream_id"))
      .toEqual([{ workstream_id: CHANNEL_C }]);
  });

  it("given a Space archived in WorkspaceDO, then its hosted parent reads it archived too", async () => {
    const spaceId = await reserve("Hiring");
    const access = () => workspace().readManagementAccess({ workspaceId: WORKSPACE_ID, parentId: spaceId, userId: OWNER });
    expect(await access()).toMatchObject({ allowed: true, writable: true });
    // Only the Space row, as `finalizeArchive` writes it: the parent's own
    // copy of `archived_at` never learns of a Space's archive.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE spaces SET archived_at = ? WHERE space_id = ?", Date.now(), spaceId);
    });
    expect(await access()).toMatchObject({ allowed: true, writable: false });
  });

  it("given a member Channel archived on its directory row, when a Sidekick default is added, then its target takes the Queue", async () => {
    const sidekickId = "00000000-0000-7000-8000-00000000cf1e";
    const spaceId = await reserve("Company");
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO automation_directory
           (automation_id, workspace_id, author_user_id, source_version, payload_hash, lifecycle, scope,
            owning_workstream_id, title, description, next_run_at, projected_at)
         VALUES (?, ?, ?, 1, 'test', 'active', 'workspace', NULL, 'Shared', '', NULL, 0)`,
        sidekickId, WORKSPACE_ID, OWNER,
      );
    });
    await openMemberChannel(CHANNEL_A);
    await publishChannel(CHANNEL_A, null);
    await place(spaceId, CHANNEL_A);
    // Archived where every reader looks; the parent's own copy still says
    // active, which is the stale copy the in-place check must not trust.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE channels SET archived_at = ? WHERE workstream_id = ?", Date.now(), CHANNEL_A);
    });

    await expect(workspace().addSpaceDefault({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, kind: "sidekick", targetId: sidekickId,
    })).resolves.toMatchObject({ ok: true });

    const rows = async (sql: string) => (await workspace().runInspectionSql({ sql, bindings: [CHANNEL_A] })).rows;
    expect(await rows("SELECT sidekick_id FROM parent_sidekicks WHERE parent_id = ?")).toEqual([]);
    expect(await rows("SELECT state FROM space_default_targets WHERE workstream_id = ?")).toEqual([{ state: "pending" }]);
  });

  it("given a Sidekick default from a member who cannot manage a member Channel, then that Channel's target takes the Queue", async () => {
    const sidekickId = "00000000-0000-7000-8000-00000000cf1b";
    // An Organization-wide Space admits any active member, so the Space's own
    // check lets MEMBER add a default; OWNER created both Channels and MEMBER
    // holds no grant on either, so MEMBER manages neither.
    const spaceId = await reserve("Company");
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO automation_directory
           (automation_id, workspace_id, author_user_id, source_version, payload_hash, lifecycle, scope,
            owning_workstream_id, title, description, next_run_at, projected_at)
         VALUES (?, ?, ?, 1, 'test', 'active', 'workspace', NULL, 'Shared', '', NULL, 0)`,
        sidekickId, WORKSPACE_ID, MEMBER,
      );
    });
    for (const channel of [CHANNEL_A, CHANNEL_B]) {
      await openMemberChannel(channel);
      await publishChannel(channel, null);
      await place(spaceId, channel);
    }
    // Known to the Organization's table, so the in-place check runs rather
    // than the unknown-person fallback taking the Queue for another reason.
    await workspace().applyMemberStatus({
      workspaceId: WORKSPACE_ID, sequence: 1, removed: false,
      relationship: { workspaceId: WORKSPACE_ID, userId: MEMBER, accessClass: "member", role: "member",
        status: "active", incarnation: "existing-member", revision: 1 },
    });

    const added = await workspace().addSpaceDefault({
      workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId, kind: "sidekick", targetId: sidekickId,
    });
    expect(added).toMatchObject({ ok: true });

    const rows = async (sql: string) => (await workspace().runInspectionSql({ sql, bindings: [] })).rows;
    // Only the Space's own recommendation: neither Channel was written in place.
    expect(await rows("SELECT parent_id FROM parent_sidekicks")).toEqual([{ parent_id: spaceId }]);
    expect(await rows("SELECT workstream_id, state FROM space_default_targets ORDER BY workstream_id")).toEqual([
      { workstream_id: CHANNEL_A, state: "pending" },
      { workstream_id: CHANNEL_B, state: "pending" },
    ]);
    expect(await rows("SELECT workstream_id FROM space_default_publications ORDER BY workstream_id"))
      .toEqual([{ workstream_id: CHANNEL_A }, { workstream_id: CHANNEL_B }]);
  });

  it("given a participant added after creation, when they add and remove a Sidekick default, then the Space's recommendation follows", async () => {
    const sidekickId = "00000000-0000-7000-8000-00000000cf1c";
    const spaceId = await reserve("Hiring");
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO automation_directory
           (automation_id, workspace_id, author_user_id, source_version, payload_hash, lifecycle, scope,
            owning_workstream_id, title, description, next_run_at, projected_at)
         VALUES (?, ?, ?, 1, 'test', 'active', 'workspace', NULL, 'Shared', '', NULL, 0)`,
        sidekickId, WORKSPACE_ID, OWNER,
      );
    });
    await workspace().applyMemberStatus({
      workspaceId: WORKSPACE_ID, sequence: 1, removed: false,
      relationship: { workspaceId: WORKSPACE_ID, userId: MEMBER, accessClass: "member", role: "member",
        status: "active", incarnation: "existing-member", revision: 1 },
    });
    // The audience lives in the Space rows alone; the Space's hosted parent
    // still knows only its creator, so authorizing there would refuse MEMBER.
    await workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId,
      audience: { scope: "workspace", participantUserIds: [OWNER, MEMBER] },
    });
    const rows = async () => (await workspace().runInspectionSql({
      sql: "SELECT sidekick_id FROM parent_sidekicks WHERE parent_id = ?", bindings: [spaceId],
    })).rows;

    await expect(workspace().addSpaceDefault({
      workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId, kind: "sidekick", targetId: sidekickId,
    })).resolves.toMatchObject({ ok: true });
    expect(await rows()).toEqual([{ sidekick_id: sidekickId }]);

    await expect(workspace().removeSpaceDefault({
      workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId, kind: "sidekick", targetId: sidekickId,
    })).resolves.toMatchObject({ ok: true });
    expect(await rows()).toEqual([]);
  });

  it("given a Space id, when a Channel-only grant or invitation method is asked, then it is refused and writes nothing", async () => {
    // The sharing routes take any parent id, and a Space resolves to the
    // Space role, which does not refuse these writes on its own.
    const spaceId = await reserve("Company");
    const target = { kind: "workstream" as const, workspaceId: WORKSPACE_ID, parentId: spaceId };
    const grant = await workspace().mutateScopeGrant({
      operationId: "00000000-0000-7000-8000-00000000cf1c", actorUserId: OWNER, userId: MEMBER,
      target, active: true, expectedRevision: 0,
    }).then(() => null, (error: unknown) => error);
    expect(String(grant)).toContain("channel_parent_required");
    const invitations = await workspace().listScopeInvitations({ target, actorUserId: OWNER })
      .then(() => null, (error: unknown) => error);
    expect(String(invitations)).toContain("channel_parent_required");
    expect((await workspace().runInspectionSql({
      sql: "SELECT user_id FROM parent_grants WHERE parent_id = ?", bindings: [spaceId],
    })).rows).toEqual([]);
  });

  it("given a staged default target, when the default is removed, then delivery is no longer current", async () => {
    const spaceId = await reserve("Company");
    await publishChannel(CHANNEL_A, null);
    await place(spaceId, CHANNEL_A);
    const added = await workspace().addSpaceDefault({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, kind: "resource", targetId: RESOURCE_ID,
    });
    if (!added.ok) throw new Error(added.code);
    const target = {
      type: "space_default" as const,
      region: "global" as const,
      workspaceId: WORKSPACE_ID,
      requestedByUserId: OWNER,
      ...added.targets[0]!,
    };

    await expect(workspace().spaceDefaultTargetCurrent(target)).resolves.toBe(true);

    await workspace().removeSpaceDefault({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, kind: "resource", targetId: RESOURCE_ID,
    });

    // The generation is the fence: removal advances it, so a message already on
    // the Queue rechecks and settles as stale rather than attaching state the
    // Space no longer hands down.
    await expect(workspace().spaceDefaultTargetCurrent(target)).resolves.toBe(false);
    await expect(workspace().completeSpaceDefaultTarget(target)).resolves.toBe(false);
  });

  it("given a subscribed socket, when a Space is written, then it receives the whole snapshot", async () => {
    const { socket } = await connectViewer(OWNER, "cf10");
    const snapshot = nextSpaceSnapshot(socket);

    const general = await openGeneral();

    const event = await snapshot;
    expect(event.spaces.active.items).toMatchObject([{ id: general.space.id, name: "General" }]);
    expect(event.spaces.active.waterline).toBe(event.spaces.inactive.waterline);
    // False until the cutover has finished; the client shows the
    // Organization-opening state rather than a half-built hierarchy.
    expect(event.spacesReady).toBe(false);
    socket.close();
  });

  it("given an Organization held at schema 57, when it connects, then the sidebar still answers", async () => {
    // The meeting-notes retirement holds an object at 57 until its external
    // cleanup finishes, so an Organization mid-cleanup has no Space tables at
    // all. Every Space read has to answer empty there rather than abort with
    // `no such table`, because the reads are on the connect payload: an
    // unguarded one does not hide the Spaces, it stops the sidebar opening.
    await publishChannel(CHANNEL_A, null);
    await runInDurableObject(workspace(), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DELETE FROM _sql_schema_migrations WHERE version > 57");
      // The row the finalization migration's guard refuses to advance past.
      sql.exec(
        `INSERT OR REPLACE INTO retired_meeting_resources
           (resource_id, note_id, content_ref, model_content_ref, objects_deleted)
         VALUES (?, NULL, NULL, NULL, 0)`,
        RESOURCE_ID,
      );
      for (const table of [
        "space_default_publications", "space_default_targets", "space_defaults",
        "space_channel_memberships", "space_intents",
        "space_bootstrap", "workspace_container_order", "space_viewers",
        "workspace_space_state", "spaces",
        "breakout_viewers", "breakouts",
      ]) sql.exec(`DROP TABLE ${table}`);
    });
    await evictDurableObject(workspace());

    // Rebuilt from storage, and held: the guard sees unfinished cleanup and
    // stops at 57, so 61 does not run and the Space tables stay absent.
    expect(await workspace().runInspectionSql({
      sql: "SELECT MAX(version) AS version FROM _sql_schema_migrations",
      bindings: [],
    })).toMatchObject({ rows: [{ version: 57 }] });
    expect(await workspace().runInspectionSql({
      sql: "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'spaces'",
      bindings: [],
    })).toMatchObject({ rows: [] });

    // Each read the connect payload makes answers empty rather than aborting.
    // The two server-to-server ones are asserted first, because the socket's
    // own failure mode is a subscribe that never answers — true, and slower to
    // read than this; the directories themselves come off the payload below,
    // which is the only way a client reads them.
    await expect(workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID }))
      .resolves.toMatchObject({ phase: "pending", generalSpaceId: null, ready: false });
    await expect(workspace().channelSpaces({
      workspaceId: WORKSPACE_ID, userId: OWNER, workstreamId: CHANNEL_A,
    })).resolves.toEqual({ spaceIds: [] });

    const breakout: ParentEffect = {
      kind: "directory_common",
      title: "Quiet breakout",
      description: "",
      preview: "",
      scope: "personal",
      state: "needs_input",
      systemKind: null,
      lastActivityAt: "2026-09-19T00:00:00.000Z",
      completedAt: null,
      archivedAt: null,
      createdByUserId: OWNER,
      latestAttentionOrdinal: 0,
      unreadTrackingStartOrdinal: 0,
      createdAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:00:00.000Z",
      resourceLinks: [],
    };
    const breakoutEnvelope = ParentEffectEnvelopeSchema.parse({
      kind: "parent_effect",
      contractVersion: 1,
      region: "global",
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: CHANNEL_A,
      substreamId: BREAKOUT_A,
      generation: 1,
      messageId: messageId(),
      partitionKey: `substream:${BREAKOUT_A}:common`,
      sourceVersion: 1,
      requiredProjectionVersion: null,
      payloadHash: conversationEffectHash(breakout),
      effect: breakout,
    });
    await expect(workspace().applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [breakoutEnvelope],
    })).resolves.toMatchObject({ accepted: [] });
    await expect(workspace().runInspectionSql({
      sql: "SELECT COUNT(*) AS count FROM workspace_workstream_effect_receipts WHERE message_id = ?",
      bindings: [breakoutEnvelope.messageId],
    })).resolves.toMatchObject({ rows: [{ count: 0 }] });

    // Install the exact breakout tables from migration 63, under the names
    // migration 72 gives them, without exercising the unrelated
    // meeting-retirement chain this fixture deliberately holds. The same
    // delivery is then accepted: this is the Queue retry the empty acceptance
    // preserves rather than a second publication from the Channel.
    await runInDurableObject(workspace(), (_instance, state) => {
      for (const statement of WORKSPACE_BREAKOUT_SCHEMA_STATEMENTS) {
        state.storage.sql.exec(statement);
      }
      state.storage.sql.exec("ALTER TABLE workspace_breakout_directory RENAME TO breakouts");
      state.storage.sql.exec("ALTER TABLE workspace_breakout_viewers RENAME TO breakout_viewers");
    });
    await expect(workspace().applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [breakoutEnvelope],
    })).resolves.toMatchObject({
      accepted: [{ messageId: breakoutEnvelope.messageId, payloadHash: breakoutEnvelope.payloadHash }],
    });
    await expect(workspace().runInspectionSql({
      sql: "SELECT title FROM breakouts WHERE workstream_id = ? AND substream_id = ?",
      bindings: [CHANNEL_A, BREAKOUT_A],
    })).resolves.toMatchObject({ rows: [{ title: "Quiet breakout" }] });

    const { socket, sidebar } = await connectViewer(OWNER, "cf11");
    expect(sidebar.spaces).toEqual({
      active: { waterline: 0, items: [] },
      inactive: { waterline: 0, items: [] },
    });
    expect(sidebar.workstreams.items).toMatchObject([
      { id: CHANNEL_A, breakoutAttentionCount: 0 },
    ]);
    expect(sidebar.spacesReady).toBe(false);
    socket.close();

    // And a Space *write* is refused by name rather than aborting on a missing
    // table, so the route renders a sentence instead of a 500.
    await expect(workspace().reserveSpace({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      space: { name: "Company", iconKey: "briefcase", colorKey: "blue", scope: "workspace" },
    })).resolves.toMatchObject({ ok: false, code: "space_bootstrap_pending" });
  });

  it("given a guest's socket, when Spaces exist that hold no Channel of theirs, then its payload carries none of them", async () => {
    const companyId = await reserve("Company", "workspace");
    const { socket, sidebar } = await connectViewer(GUEST, "cf12");

    // The connect payload is the listing rules' answer, as every Space read is:
    // an Organization-wide Space reaches a guest only through a Channel in it.
    expect(sidebar.spaces).toMatchObject({ active: { items: [] }, inactive: { items: [] } });

    // And on the republication an Organization-wide Space write sends, which is
    // the path a guest holds open rather than asks for. A reorder is not one of
    // those any more: it reaches the person who made it and nobody else.
    const snapshot = nextSpaceSnapshot(socket);
    await workspace().noteSpacePresentation({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId: companyId,
      presentation: { name: "Company", iconKey: "briefcase", colorKey: "red" },
    });
    const event = await snapshot;
    expect(event.spaces.active.items).toEqual([]);
    expect(event.spaces.inactive.items).toEqual([]);

    // A member on the same Organization sees it, so the emptiness above is the
    // relationship rather than an Organization with no Spaces.
    const member = await connectViewer(MEMBER, "cf13");
    expect(member.sidebar).toMatchObject({
      spaces: { active: { items: [{ name: "Company" }] } },
      spacesReady: false,
    });
    socket.close();
    member.socket.close();
  });

  it("given the bootstrap row, when it is read, then it reports the phase and General", async () => {
    await expect(workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID }))
      .resolves.toMatchObject({ phase: "pending", generalSpaceId: null, ready: false });

    const general = await openGeneral();

    await expect(workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID }))
      .resolves.toMatchObject({ phase: "general", generalSpaceId: general.space.id, ready: false });
  });

  it("given each kind of container, when one person arranges it, then only their own sidebar carries it", async () => {
    const first = await reserve("Company");
    const second = await reserve("Recruiting");
    await publishChannel(CHANNEL_A, null);
    await publishChannel(CHANNEL_B, null);
    await place(first, CHANNEL_A);
    await place(first, CHANNEL_B);
    // The read is what gives a viewer their Organization rows, and it is the
    // read the other member's untouched order has to survive.
    expect(storedItemIds(await personalOrder(MEMBER), "organization"))
      .toEqual([first, second]);

    for (const order of [
      { container: { kind: "organization" as const }, itemIds: [second, first] },
      { container: { kind: "space" as const, id: first }, itemIds: [CHANNEL_B, CHANNEL_A] },
      { container: { kind: "channel" as const, id: CHANNEL_A }, itemIds: [BREAKOUT_B, BREAKOUT_A] },
    ]) {
      await expect(workspace().reorderContainer({ workspaceId: WORKSPACE_ID, userId: OWNER, order }))
        .resolves.toMatchObject({ ok: true, order });
    }

    // All three come back on the one field, so a session paints every list it
    // orders from the same answer rather than from three.
    const owner = await personalOrder(OWNER);
    expect(storedItemIds(owner, "organization")).toEqual([second, first]);
    expect(storedItemIds(owner, "space", first)).toEqual([CHANNEL_B, CHANNEL_A]);
    // Stored as given: a Breakout is the Channel's own object's child and this
    // authority cannot see one, so there is nothing here to validate against.
    expect(storedItemIds(owner, "channel", CHANNEL_A)).toEqual([BREAKOUT_B, BREAKOUT_A]);

    // The order is the person's, so the member beside them is untouched — in
    // the list they earned by reading and in the two they never arranged.
    const member = await personalOrder(MEMBER);
    expect(storedItemIds(member, "organization")).toEqual([first, second]);
    expect(storedItemIds(member, "space", first)).toBeNull();
    expect(storedItemIds(member, "channel", CHANNEL_A)).toBeNull();
  });

  it("given pins across Spaces, when one person orders All's Pinned section, then it is theirs and names only what they can read", async () => {
    await publishChannel(CHANNEL_A, null);
    await publishChannel(CHANNEL_B, null);
    // A member's personal Channel: the owner cannot read it, so it is not a
    // row on their sidebar and not theirs to place.
    await publishPersonalChannel(CHANNEL_C, MEMBER);

    await expect(workspace().reorderAllPinned({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      itemIds: [CHANNEL_B, CHANNEL_C, CHANNEL_A],
    })).resolves.toEqual({ ok: true, itemIds: [CHANNEL_B, CHANNEL_A] });

    // Delivered on its own field, beside `ordering` and never inside it: a
    // shipped client drops a whole ordering that holds a kind it does not know.
    expect(await pinnedOrder(OWNER)).toEqual([CHANNEL_B, CHANNEL_A]);
    expect(await pinnedOrder(MEMBER)).toEqual([]);
    expect((await personalOrder(OWNER)).map((entry) => entry.container.kind)).not.toContain("pinned");

    // A later drag names only what it moved; the rest keep their places.
    await expect(workspace().reorderAllPinned({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      itemIds: [CHANNEL_A],
    })).resolves.toEqual({ ok: true, itemIds: [CHANNEL_A, CHANNEL_B] });
  });

  it("given a stored Pinned order, when its reader stops being a participant in one Channel, then the read drops only that Channel", async () => {
    await publishChannel(CHANNEL_A, null);
    await publishChannel(CHANNEL_B, null);
    // Personal, so the owner reads it only while they are its participant.
    await publishPersonalChannel(CHANNEL_C, OWNER);

    await expect(workspace().reorderAllPinned({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      itemIds: [CHANNEL_B, CHANNEL_C, CHANNEL_A],
    })).resolves.toEqual({ ok: true, itemIds: [CHANNEL_B, CHANNEL_C, CHANNEL_A] });

    // The stored row outlives the access: nothing rewrites the order when a
    // participant leaves, so the read is the only place it can be withheld.
    await publishViewerRow(CHANNEL_C, OWNER, 2, { isParticipant: false });

    expect(await pinnedOrder(OWNER)).toEqual([CHANNEL_B, CHANNEL_A]);
  });

  it("given a Space's Channels, when the order names one it does not hold or the viewer cannot read, then it is dropped", async () => {
    const spaceId = await reserve("Company");
    await publishChannel(CHANNEL_A, null);
    // Published into the directory and deliberately left in no Space of its
    // own: a Channel somebody can read is still not a row in *this* Space's
    // list.
    await publishChannel(CHANNEL_B, null);
    // A member's personal Channel, placed in the Space. The membership is the
    // Organization's fact and the visibility is the reader's, so this one is
    // in the list and still not the owner's to arrange.
    await publishPersonalChannel(CHANNEL_C, MEMBER);
    await place(spaceId, CHANNEL_A);
    await place(spaceId, CHANNEL_C);

    await expect(workspace().reorderContainer({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      order: { container: { kind: "space", id: spaceId }, itemIds: [CHANNEL_C, CHANNEL_B, CHANNEL_A] },
    })).resolves.toMatchObject({ ok: true, order: { itemIds: [CHANNEL_A] } });

    expect(storedItemIds(await personalOrder(OWNER), "space", spaceId)).toEqual([CHANNEL_A]);
    // And the member, who can read theirs, may arrange it.
    await expect(workspace().reorderContainer({
      workspaceId: WORKSPACE_ID,
      userId: MEMBER,
      order: { container: { kind: "space", id: spaceId }, itemIds: [CHANNEL_C, CHANNEL_A] },
    })).resolves.toMatchObject({ ok: true, order: { itemIds: [CHANNEL_C, CHANNEL_A] } });
  });

  /**
   * A drag says where the rows it moved go. It does not say that the rows it
   * never mentioned should be forgotten — and the only client there is can only
   * ever mention what it is drawing, which is what is left after an archived
   * Channel, an unfetched page or a search has taken the rest off the screen.
   */
  it("given a list the client can only half see, when part of it is arranged, then the rest keeps its places", async () => {
    const spaceId = await reserve("Company");
    for (const channelId of [CHANNEL_A, CHANNEL_B, CHANNEL_C]) {
      await publishChannel(channelId, null);
      await place(spaceId, channelId);
    }
    // The whole list, from a session that has every row on screen.
    await workspace().reorderContainer({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      order: { container: { kind: "space", id: spaceId }, itemIds: [CHANNEL_C, CHANNEL_B, CHANNEL_A] },
    });

    // And then one nudge from a session drawing two of the three.
    await expect(workspace().reorderContainer({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      order: { container: { kind: "space", id: spaceId }, itemIds: [CHANNEL_B, CHANNEL_A] },
    })).resolves.toMatchObject({ ok: true, order: { itemIds: [CHANNEL_B, CHANNEL_A, CHANNEL_C] } });
    expect(storedItemIds(await personalOrder(OWNER), "space", spaceId))
      .toEqual([CHANNEL_B, CHANNEL_A, CHANNEL_C]);

    // The same for a Channel's Breakouts, where it matters most: this
    // authority has never seen one, so the rule is the only thing standing
    // between an id it was not sent and its deletion.
    await workspace().reorderContainer({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      order: { container: { kind: "channel", id: CHANNEL_A }, itemIds: [BREAKOUT_A, BREAKOUT_B, BREAKOUT_C] },
    });
    await workspace().reorderContainer({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      order: { container: { kind: "channel", id: CHANNEL_A }, itemIds: [BREAKOUT_B, BREAKOUT_A] },
    });
    expect(storedItemIds(await personalOrder(OWNER), "channel", CHANNEL_A))
      .toEqual([BREAKOUT_B, BREAKOUT_A, BREAKOUT_C]);
  });

  it("given a fabricated Channel container, when a member writes an order, then no rows are accepted", async () => {
    await expect(workspace().reorderContainer({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      order: {
        container: { kind: "channel", id: "00000000-0000-7000-8000-00000000ffff" },
        itemIds: [BREAKOUT_A, BREAKOUT_B],
      },
    })).resolves.toMatchObject({ ok: false, code: "space_not_found" });
  });

  /**
   * Archive takes nothing, and that is the decision rather than an omission.
   *
   * `directory()` filters `archived_at IS NULL`, so an archived Space is
   * already out of every sidebar; deleting the rows would mean a restore put
   * the Channels back in recency order under somebody who had arranged them by
   * hand. The `space` filter is what makes the same true of an archived
   * Channel: neither read it goes through looks at `archived_at`.
   */
  it("given an arranged Space, when it is archived and restored, then the arrangement comes back with it", async () => {
    const first = await reserve("Company");
    const second = await reserve("Recruiting");
    await publishChannel(CHANNEL_A, null);
    await publishChannel(CHANNEL_B, null);
    for (const channelId of [CHANNEL_A, CHANNEL_B]) {
      await place(second, channelId);
      await place(first, channelId);
    }
    await workspace().reorderContainer({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      order: { container: { kind: "organization" }, itemIds: [second, first] },
    });
    await workspace().reorderContainer({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      order: { container: { kind: "space", id: second }, itemIds: [CHANNEL_B, CHANNEL_A] },
    });

    await workspace().archiveSpace({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: second });

    // Hidden while it is archived: personal ordering is part of the viewer's
    // socket state and must not name a container or item they cannot see. The
    // underlying rows remain, which the restore assertions below prove.
    const archived = await personalOrder(OWNER);
    expect(storedItemIds(archived, "organization")).toEqual([first]);
    expect(storedItemIds(archived, "space", second)).toEqual([]);

    await expect(workspace().restoreSpace({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: second,
    })).resolves.toMatchObject({ ok: true });

    // And the directory comes back in the order this person put it in, rather
    // than in whatever order the restore happened to write.
    expect((await spaceDirectories(OWNER)).active.items.map((item) => item.id))
      .toEqual([second, first]);
    expect(storedItemIds(await personalOrder(OWNER), "space", second))
      .toEqual([CHANNEL_B, CHANNEL_A]);
  });

  it("given two sessions of one person, when one arranges a list, then the other is told without asking", async () => {
    const spaceId = await reserve("Company");
    await publishChannel(CHANNEL_A, null);
    await publishChannel(CHANNEL_B, null);
    await place(spaceId, CHANNEL_A);
    await place(spaceId, CHANNEL_B);
    const desk = await connectViewer(OWNER, "cf20");
    const laptop = await connectViewer(OWNER, "cf21");
    const onLaptop = nextSpaceSnapshot(laptop.socket);

    await workspace().reorderContainer({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      order: { container: { kind: "space", id: spaceId }, itemIds: [CHANNEL_B, CHANNEL_A] },
    });

    // The whole ordering rather than the container that moved: this is the one
    // message a viewer's other windows get, and a delta would make each of them
    // keep a copy to apply it to.
    expect(storedItemIds((await onLaptop).ordering, "space", spaceId))
      .toEqual([CHANNEL_B, CHANNEL_A]);
    desk.socket.close();
    laptop.socket.close();
  });

  /**
   * The other half of the same audience.
   *
   * A snapshot is per viewer and costs a `list()` transaction plus a full
   * directory serialization for each one, so publishing one person's view
   * preference to the Organization charges every member for a payload that did
   * not change for them — once per step of a held Alt+Arrow.
   *
   * Proved without a timeout: an Organization-wide write follows the reorder,
   * and what this member's socket is asked for is the *first* snapshot it
   * receives. A reorder that reached them would be that first snapshot, and it
   * would still carry the old name.
   */
  it("given another member's session, when somebody arranges a list, then nothing is republished to them", async () => {
    const spaceId = await reserve("Company");
    const other = await connectViewer(MEMBER, "cf22");
    const onOther = nextSpaceSnapshot(other.socket);

    await workspace().reorderContainer({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      order: { container: { kind: "organization" }, itemIds: [spaceId] },
    });
    await workspace().noteSpacePresentation({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId,
      presentation: { name: "Recruiting", iconKey: "briefcase", colorKey: "red" },
    });

    expect((await onOther).spaces.active.items).toMatchObject([{ name: "Recruiting" }]);
    other.socket.close();
  });

  it("given a viewer's order, when they reorder Spaces, then only their own order moves", async () => {
    const first = await reserve("Company");
    const second = await reserve("Recruiting");
    // Reading the sidebar is what gives a viewer their order rows, so this is
    // what makes the member's order exist to be left alone.
    expect((await spaceDirectories(MEMBER)).active.items.map((item) => item.id))
      .toEqual([first, second]);

    await expect(workspace().reorderContainer({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      order: { container: { kind: "organization" }, itemIds: [second, first] },
    })).resolves.toMatchObject({ ok: true, order: { itemIds: [second, first] } });
    expect((await spaceDirectories(OWNER)).active.items.map((item) => item.id))
      .toEqual([second, first]);
    expect((await spaceDirectories(MEMBER)).active.items.map((item) => item.id))
      .toEqual([first, second]);
  });

  it("given a Space's presentation change, when it is recorded, then the summary answers immediately", async () => {
    const spaceId = await reserve("Company");

    await expect(workspace().noteSpacePresentation({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId,
      presentation: { name: "Go to market", iconKey: "rocket", colorKey: "violet" },
    })).resolves.toMatchObject({
      ok: true,
      space: { name: "Go to market", iconKey: "rocket", colorKey: "violet" },
    });
  });

  it("given a participant change, when it is recorded, then it stages no intent and the Space stays Organization-wide", async () => {
    const spaceId = await reserve("Company");

    await expect(workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId,
      audience: { scope: "workspace", participantUserIds: [OWNER, MEMBER] },
    })).resolves.toMatchObject({
      ok: true,
      space: { scope: "workspace", participants: [{ userId: OWNER }, { userId: MEMBER }] },
    });
    // A Space grants no reader, so there is nothing to carry to its Channels
    // and nothing for the alarm to resume.
    expect(await workspace().runInspectionSql({
      sql: "SELECT kind FROM space_intents WHERE space_id = ?",
      bindings: [spaceId],
    })).toMatchObject({ rows: [] });
  });
});

describe("WorkspaceDO opening a new Organization", () => {
  const GENERAL = asSpaceId("00000000-0000-7000-8000-00000000cf1b");

  it("given General's anchor, when the Organization is initialized, then General exists and its Spaces are ready in that one call", async () => {
    await expect(workspace().initializeWorkspace(WORKSPACE_ID, "wnam", {
      creatorUserId: OWNER, spaceId: GENERAL, authorityGeneration: 1,
    })).resolves.toEqual({ spacesReady: true });

    await expect(workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID }))
      .resolves.toMatchObject({ phase: "complete", generalSpaceId: GENERAL, ready: true });
    expect((await spaceDirectories(OWNER)).active.items).toMatchObject([{ id: GENERAL, name: "General" }]);
  });

  it("given no anchor, when a new Organization is initialized, then it is answered not ready and nothing is created", async () => {
    await expect(workspace().initializeWorkspace(WORKSPACE_ID, "wnam"))
      .resolves.toEqual({ spacesReady: false });
    await expect(workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID }))
      .resolves.toMatchObject({ phase: "pending", generalSpaceId: null, ready: false });
  });

  it("given a guest as the creator, when the Organization is initialized, then General is not opened for them", async () => {
    await expect(workspace().initializeWorkspace(WORKSPACE_ID, "wnam", {
      creatorUserId: GUEST, spaceId: GENERAL, authorityGeneration: 1,
    })).resolves.toEqual({ spacesReady: false });
    await expect(workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID }))
      .resolves.toMatchObject({ generalSpaceId: null, ready: false });
  });

  it("given a creator lookup that fails, when the Organization is initialized, then it answers not ready rather than failing", async () => {
    // The creator's relationship is read from D1 on a fresh object; with the
    // table gone that read throws, as a D1 outage would.
    await env.DB.exec("DROP TABLE workspace_members");

    await expect(workspace().initializeWorkspace(WORKSPACE_ID, "wnam", {
      creatorUserId: OWNER, spaceId: GENERAL, authorityGeneration: 1,
    })).resolves.toEqual({ spacesReady: false });
    await expect(workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID }))
      .resolves.toMatchObject({ generalSpaceId: null, ready: false });
  });

  it("given an Organization already open, when it is initialized again, then it is answered ready without an anchor", async () => {
    await workspace().initializeWorkspace(WORKSPACE_ID, "wnam", {
      creatorUserId: OWNER, spaceId: GENERAL, authorityGeneration: 1,
    });
    await expect(workspace().initializeWorkspace(WORKSPACE_ID, "wnam"))
      .resolves.toEqual({ spacesReady: true });
  });
});
