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
  WorkspaceSpaceSnapshotEventSchema,
  type ParentEffect,
  type SpaceId,
  type UserId,
  type WorkspaceSidebar,
  type WorkspaceSpaceSnapshotEvent,
  type WorkstreamId,
} from "@rally/contracts";
import { ParentEffectEnvelopeSchema } from "@rally/contracts/conversation-effects";

import { workspaceDOName, workstreamDOName } from "../src/durable-objects/names";

/** Its own workspace id: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000cf00");
const OWNER = asUserId("00000000-0000-7000-8000-00000000cf01");
const MEMBER = asUserId("00000000-0000-7000-8000-00000000cf02");
const GUEST = asUserId("00000000-0000-7000-8000-00000000cf03");
const INACTIVE = asUserId("00000000-0000-7000-8000-00000000cf04");
const CHANNEL_A = asWorkstreamId("00000000-0000-7000-8000-00000000cf05");
const CHANNEL_B = asWorkstreamId("00000000-0000-7000-8000-00000000cf06");
const CHANNEL_C = asWorkstreamId("00000000-0000-7000-8000-00000000cf07");
const RESOURCE_ID = "00000000-0000-7000-8000-00000000cf07";

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
      incarnation TEXT DEFAULT 'existing-member',
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT, access_class TEXT NOT NULL DEFAULT 'member',
      last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      workspace_incarnation TEXT DEFAULT 'existing-member',
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, revoked_at TEXT, expires_at TEXT NOT NULL
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
      (workspace_id, user_id, status, role, access_class) VALUES (?, ?, 'removed', 'member', 'member')`)
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

/** One Channel published into the Organization's Channel directory. */
async function publishChannel(workstreamId: WorkstreamId, archivedAt: string | null): Promise<void> {
  const effect: ParentEffect = {
    kind: "directory_common",
    title: "Member Channel",
    description: "",
    preview: "",
    scope: "workspace",
    state: "idle",
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

async function reserve(
  name: string,
  scope: "personal" | "workspace" = "workspace",
  userId = OWNER,
): Promise<SpaceId> {
  const result = await workspace().reserveSpace({
    workspaceId: WORKSPACE_ID,
    userId,
    space: { name, iconKey: "briefcase", colorKey: "blue", scope },
  });
  if (!result.ok) throw new Error(`reserveSpace refused: ${result.code}`);
  return asSpaceId(result.space.id);
}

/** Put a Channel in a Space the way the service does: stage, then settle. */
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
    state: "idle",
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

async function place(spaceId: SpaceId, workstreamId: WorkstreamId): Promise<void> {
  const plan = await workspace().prepareSpaceMembership({
    workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, workstreamId,
  });
  if (!plan.ok) throw new Error(`prepareSpaceMembership refused: ${plan.code}`);
  const settled = await workspace().finalizeSpaceMembership({
    workspaceId: WORKSPACE_ID,
    userId: OWNER,
    spaceId,
    workstreamId,
    spaceRevision: plan.space.revision,
    membershipGeneration: plan.membershipGeneration,
  });
  if (!settled.ok) throw new Error(`finalizeSpaceMembership refused: ${settled.code}`);
}

/**
 * One member Channel's own authority, opened the way
 * `channel-access-sources.test.ts` opens one.
 *
 * The archive fan-out is two objects: WorkspaceDO says which Channels this
 * Space still reaches, and each of those Channels withdraws the source itself.
 * Proving the source is gone therefore needs the real Channel authority, not a
 * count of membership rows.
 */
function memberChannel(workstreamId: WorkstreamId) {
  return env.WORKSTREAM_DOS.getByName(workstreamDOName("global", WORKSPACE_ID, workstreamId));
}

const observedChannel = {
  readers: { scope: "workspace" as const },
  participantUserIds: [OWNER],
};

async function openMemberChannel(workstreamId: WorkstreamId): Promise<void> {
  await runInDurableObject(memberChannel(workstreamId), (_instance, state) => {
    // Written directly, for the reason the access-sources suite writes it: this
    // case is about the provenance rows, not about how a Channel comes to be.
    state.storage.sql.exec(
      `INSERT INTO workstream_metadata
         (id, workspace_id, workstream_id, region, authority_generation, title, description,
          preview, scope, exact_state, last_activity_at, created_at, updated_at)
       VALUES (1, ?, ?, 'global', 1, 'Member Channel', '', '', 'workspace', 'idle', 1, 1, 1)`,
      WORKSPACE_ID,
      workstreamId,
    );
    state.storage.sql.exec(
      `INSERT INTO conversation_children (substream_id, kind, created_by_user_id, created_at, status, updated_at)
       VALUES ('0', 'main', ?, 1, 'ready', 1)`,
      OWNER,
    );
  });
}

/** Apply and confirm one Space's source, the two calls the service makes. */
async function seatSpaceSource(workstreamId: WorkstreamId, spaceId: SpaceId): Promise<void> {
  const address = { workspaceId: WORKSPACE_ID, parentId: workstreamId };
  const source = {
    scope: "workspace" as const,
    participantUserIds: [OWNER],
    spaceRevision: 1,
    membershipGeneration: 1,
    channel: observedChannel,
  };
  const applied = await memberChannel(workstreamId).applySpaceAccessSource({
    ...address, spaceId, ...source, operationId: crypto.randomUUID(),
  });
  if (!applied.ok) throw new Error(`applySpaceAccessSource refused: ${applied.code}`);
  const confirmed = await memberChannel(workstreamId).confirmSpaceAccessSource({
    ...address, spaceId, operationId: crypto.randomUUID(), seatedUserIds: [], source,
  });
  if (!confirmed.ok) throw new Error(`confirmSpaceAccessSource refused: ${confirmed.code}`);
}

function nextMessage(socket: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve) => socket.addEventListener("message", resolve, { once: true }));
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

beforeEach(async () => {
  await reset();
  effectSequence = 0;
  await establishWorkspace();
}, 30_000);

describe("WorkspaceDO space authority", () => {
  it("given a reserved Space, when members list Spaces, then scope decides who sees it", async () => {
    await reserve("Hiring", "personal");
    await reserve("Company", "workspace");

    await expect(workspace().listSpaces({ workspaceId: WORKSPACE_ID, userId: OWNER }))
      .resolves.toMatchObject({ ok: true, directory: { items: [{ name: "Hiring" }, { name: "Company" }] } });
    await expect(workspace().listSpaces({ workspaceId: WORKSPACE_ID, userId: MEMBER }))
      .resolves.toMatchObject({ ok: true, directory: { items: [{ name: "Company" }] } });
  });

  it("given a guest relationship, when it reaches any Space RPC, then it is refused", async () => {
    const spaceId = await reserve("Company");

    // Guest access to Spaces is deferred: a guest holds explicit Channel grants
    // and no Organization-wide discovery, so admitting one here would put every
    // Organization-wide Space in their sidebar.
    await expect(workspace().listSpaces({ workspaceId: WORKSPACE_ID, userId: GUEST }))
      .resolves.toEqual({ ok: false, code: "space_access_denied" });
    await expect(workspace().spaceSummary({ workspaceId: WORKSPACE_ID, userId: GUEST, spaceId }))
      .resolves.toMatchObject({ ok: false, code: "space_access_denied" });
    await expect(workspace().listSpaces({ workspaceId: WORKSPACE_ID, userId: INACTIVE }))
      .resolves.toEqual({ ok: false, code: "space_access_denied" });
  });

  it("given a reservation, when the Space's own directory effect lands, then it supersedes it", async () => {
    const spaceId = await reserve("Hiring", "personal");

    await workspace().applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [spaceEnvelope(spaceId, spaceDirectoryEffect("Hiring team", "workspace"), 1)],
    });

    // The reservation is written at source version zero precisely so the first
    // real projection applies over it under the ordinary fence instead of
    // colliding with it at the same version under a different hash.
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
      envelopes: [spaceEnvelope(spaceId, spaceDirectoryEffect("Hiring", "workspace"), 1)],
    });
    expect(await workspace().runInspectionSql({
      sql: "SELECT COUNT(*) AS count FROM workspace_activity_events",
      bindings: [],
    })).toMatchObject({ rows: [{ count: 0 }] });
    expect(await workspace().runInspectionSql({
      sql: "SELECT space_id FROM workspace_space_directory",
      bindings: [],
    })).toMatchObject({ rows: [{ space_id: spaceId }] });
  });

  it("given a staged membership, when finalization is skipped, then the Channel is not in the Space", async () => {
    const spaceId = await reserve("Company");
    await publishChannel(CHANNEL_A, null);

    const plan = await workspace().prepareSpaceMembership({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, workstreamId: CHANNEL_A,
    });

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
    const plan = await workspace().prepareSpaceMembership({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, workstreamId: CHANNEL_A,
    });
    if (!plan.ok) throw new Error(plan.code);

    // The Space's audience changes underneath the staged membership. The
    // audience that was applied to the Channel came from the Space as it was,
    // so settling now would publish a placement granted from an audience that
    // no longer exists.
    await workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId,
      operationId: "00000000-0000-7000-8000-00000000cf09",
      audience: { scope: "personal", participantUserIds: [OWNER] },
    });

    await expect(workspace().finalizeSpaceMembership({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId,
      workstreamId: CHANNEL_A,
      spaceRevision: plan.space.revision,
      membershipGeneration: plan.membershipGeneration,
    })).resolves.toMatchObject({ ok: false, code: "space_revision_conflict" });
  });

  it("given a settled membership, when the Space is read, then the Channel is listed and counted", async () => {
    const spaceId = await reserve("Company");
    await publishChannel(CHANNEL_A, null);
    await publishChannel(CHANNEL_B, "2026-09-19T00:00:00.000Z");
    await place(spaceId, CHANNEL_A);
    await place(spaceId, CHANNEL_B);

    // An archived Channel keeps its membership — that row is what returns it to
    // the Space if it is unarchived — while no list renders it, so the count a
    // screen reads and the membership a fan-out reads deliberately differ.
    await expect(workspace().spaceSummary({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId }))
      .resolves.toMatchObject({ ok: true, space: { channelCount: 1 } });
    // Channels rather than ids: the page is projected through the same
    // directory select and mapper the sidebar's own list uses, so a Space page
    // and a sidebar row cannot drift. The placement travels on the row, which
    // is what lets a client draw the Channel under its Space on first paint.
    await expect(workspace().listSpaceChannels({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, cursor: null,
    })).resolves.toMatchObject({
      ok: true,
      page: { items: [{ id: CHANNEL_A, spaceIds: [spaceId] }], nextCursor: null },
    });
    await expect(workspace().listSpaceMembers({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId }))
      .resolves.toMatchObject({
        ok: true,
        members: [
          { workstreamId: CHANNEL_A, membershipGeneration: 1 },
          { workstreamId: CHANNEL_B, membershipGeneration: 1 },
        ],
      });
    await expect(workspace().channelSpaces({
      workspaceId: WORKSPACE_ID, userId: OWNER, workstreamId: CHANNEL_A,
    })).resolves.toEqual({ spaceIds: [spaceId] });
  });

  it("given a Channel in a personal Space, when another member reads it, then that Space is not named", async () => {
    const personal = await reserve("Side work", "personal");
    const organization = await reserve("Company", "workspace");
    await publishChannel(CHANNEL_A, null);
    await place(personal, CHANNEL_A);
    await place(organization, CHANNEL_A);

    // The ids ride a *Channel*, which several people read. A personal Space's
    // id on somebody else's row is the existence of a private Space — and,
    // through `channelCount`, how much is in it — leaking to a reader who
    // cannot see it.
    await expect(workspace().channelSpaces({
      workspaceId: WORKSPACE_ID, userId: OWNER, workstreamId: CHANNEL_A,
    })).resolves.toEqual({ spaceIds: [personal, organization].sort() });
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

  it("given a Channel already in a Space, when it is added again, then the add succeeds", async () => {
    const spaceId = await reserve("Company");
    await publishChannel(CHANNEL_A, null);
    await place(spaceId, CHANNEL_A);

    // Adding a Channel a Space already holds is the ordinary shape of a retry,
    // and of two people dragging the same Channel onto the same Space.
    // `prepareSpaceMembership` answers it with the generation the membership
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

    await expect(workspace().prepareSpaceMembershipRemoval({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId,
      workstreamId: CHANNEL_A,
      remainingAudience: { scope: "workspace", participantUserIds: [] },
    })).resolves.toMatchObject({ ok: false, code: "space_membership_final" });
  });

  it("given two Spaces, when a reader could discover neither remaining one, then removal names them", async () => {
    const organization = await reserve("Company", "workspace");
    const personal = await reserve("Side work", "personal");
    await publishChannel(CHANNEL_A, null);
    await place(organization, CHANNEL_A);
    await place(personal, CHANNEL_A);

    // `MEMBER` keeps access to the Channel from somewhere else, but the only
    // Space that would remain is one they do not participate in — so the
    // Channel would be readable and unreachable for them.
    const refused = await workspace().prepareSpaceMembershipRemoval({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId: organization,
      workstreamId: CHANNEL_A,
      remainingAudience: { scope: "personal", participantUserIds: [OWNER, MEMBER] },
    });

    expect(refused).toMatchObject({
      ok: false,
      code: "space_audience_incompatible",
      unreachableUserIds: [MEMBER],
    });
  });

  it("given a Channel in two Spaces, when one membership is removed, then the other keeps it", async () => {
    const organization = await reserve("Company", "workspace");
    const second = await reserve("Recruiting", "workspace");
    await publishChannel(CHANNEL_A, null);
    await place(organization, CHANNEL_A);
    await place(second, CHANNEL_A);

    const plan = await workspace().prepareSpaceMembershipRemoval({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId: organization,
      workstreamId: CHANNEL_A,
      remainingAudience: { scope: "workspace", participantUserIds: [] },
    });
    if (!plan.ok) throw new Error(plan.code);
    await expect(workspace().finalizeSpaceMembershipRemoval({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId: organization,
      workstreamId: CHANNEL_A,
      spaceRevision: plan.space.revision,
      membershipGeneration: plan.membershipGeneration,
    })).resolves.toMatchObject({ ok: true });

    await expect(workspace().channelSpaces({
      workspaceId: WORKSPACE_ID, userId: OWNER, workstreamId: CHANNEL_A,
    })).resolves.toEqual({ spaceIds: [second] });
  });

  it("given a Space holding a sole-member Channel, when it is archived, then it is refused", async () => {
    const spaceId = await reserve("Company");
    const second = await reserve("Recruiting");
    await publishChannel(CHANNEL_A, null);
    await place(spaceId, CHANNEL_A);

    await expect(workspace().prepareSpaceArchive({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, operationId: crypto.randomUUID(),
    })).resolves.toMatchObject({ ok: false, code: "space_membership_final" });

    await place(second, CHANNEL_A);
    await expect(workspace().prepareSpaceArchive({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, operationId: crypto.randomUUID(),
    })).resolves.toMatchObject({ ok: true });
    await expect(workspace().finalizeSpaceArchive({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, operationId: crypto.randomUUID(),
    })).resolves.toMatchObject({ ok: true, space: { status: "archived" } });
    await expect(workspace().listInactiveSpaces({ workspaceId: WORKSPACE_ID, userId: OWNER }))
      .resolves.toMatchObject({ ok: true, directory: { items: [{ id: spaceId }] } });
  });

  it("given an archive, when the fan-out runs, then the Space's source is off every member Channel", async () => {
    const spaceId = await reserve("Company");
    const second = await reserve("Recruiting");
    await publishChannel(CHANNEL_A, null);
    await publishChannel(CHANNEL_B, null);
    for (const workstreamId of [CHANNEL_A, CHANNEL_B]) {
      await place(spaceId, workstreamId);
      await place(second, workstreamId);
      await openMemberChannel(workstreamId);
      await seatSpaceSource(workstreamId, spaceId);
      await seatSpaceSource(workstreamId, second);
    }

    // One operation id across both halves, which is what makes the settlement
    // name the intent the preflight staged rather than reconstruct it from a
    // revision the archive itself advances.
    const operationId = crypto.randomUUID();
    const staged = await workspace().prepareSpaceArchive({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, operationId,
    });
    if (!staged.ok) throw new Error(staged.code);
    expect(await workspace().runInspectionSql({
      sql: "SELECT kind, state FROM space_intents WHERE operation_id = ?",
      bindings: [operationId],
    })).toMatchObject({ rows: [{ kind: "archive", state: "pending" }] });
    // The prepare has already flipped every membership to `removing`, which is
    // why the fan-out asks which Channels this Space still *reaches*. Asking
    // for its active members answers nothing and leaves the retraction loop
    // below with no Channel to run over.
    const members = await workspace().listSpaceMembers({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, reach: "reaching",
    });
    if (!members.ok) throw new Error(members.code);
    for (const { workstreamId } of members.members) {
      const retracted = await memberChannel(workstreamId).retractSpaceAccessSource({
        workspaceId: WORKSPACE_ID,
        parentId: workstreamId,
        spaceId,
        operationId: crypto.randomUUID(),
        channel: observedChannel,
      });
      if (!retracted.ok) throw new Error(retracted.code);
    }
    await workspace().finalizeSpaceArchive({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, operationId,
    });

    // Settled, so the alarm stops republishing it. Nothing else in the tree
    // knows this id, which is the point of carrying it.
    expect(await workspace().runInspectionSql({
      sql: "SELECT state, receipts_json FROM space_intents WHERE operation_id = ?",
      bindings: [operationId],
    })).toMatchObject({ rows: [{ state: "settled", receipts_json: '["archived"]' }] });
    for (const workstreamId of [CHANNEL_A, CHANNEL_B]) {
      expect(await memberChannel(workstreamId).readAccessSources({
        workspaceId: WORKSPACE_ID, parentId: workstreamId, channel: observedChannel,
      })).toMatchObject({
        spaces: [{ spaceId: second, scope: "workspace", participantUserIds: [OWNER] }],
      });
    }
  });

  it("given an archived Space, when it is restored, then its memberships come back", async () => {
    const spaceId = await reserve("Company");
    const second = await reserve("Recruiting");
    await publishChannel(CHANNEL_A, null);
    await place(spaceId, CHANNEL_A);
    await place(second, CHANNEL_A);
    await workspace().prepareSpaceArchive({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, operationId: crypto.randomUUID(),
    });
    await workspace().finalizeSpaceArchive({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, operationId: crypto.randomUUID(),
    });

    await expect(workspace().restoreSpace({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId }))
      .resolves.toMatchObject({ ok: true, space: { status: "active", channelCount: 1 } });
    await expect(workspace().channelSpaces({
      workspaceId: WORKSPACE_ID, userId: OWNER, workstreamId: CHANNEL_A,
    })).resolves.toEqual({ spaceIds: [spaceId, second].sort() });
  });

  it("given General, when it is archived or made personal, then both are refused", async () => {
    const general = await workspace().ensureGeneralSpace({ workspaceId: WORKSPACE_ID, userId: OWNER });
    if (!general.ok) throw new Error(general.code);
    expect(general).toMatchObject({ created: true, space: { name: "General", systemRole: "general" } });

    await expect(workspace().prepareSpaceArchive({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: general.space.id,
      operationId: crypto.randomUUID(),
    })).resolves.toMatchObject({ ok: false, code: "space_protected" });
    await expect(workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId: general.space.id,
      operationId: "00000000-0000-7000-8000-00000000cf0a",
      audience: { scope: "personal", participantUserIds: [OWNER] },
    })).resolves.toMatchObject({ ok: false, code: "space_protected" });

    // Idempotent: a second caller gets the same General rather than a second
    // one, which is what the unique partial index on the role is for.
    const again = await workspace().ensureGeneralSpace({ workspaceId: WORKSPACE_ID, userId: MEMBER });
    expect(again).toMatchObject({ created: false, space: { id: general.space.id } });
  });

  it("given two callers racing for General, when both run, then the Organization has one", async () => {
    // Both reserve; the index refuses the loser, and the answer it owes is the
    // Space the winner made. There is no read in front of the insert to lose
    // the race in, which is the point — a check-then-write here is how an
    // Organization ends up with two fallbacks.
    const [first, second] = await Promise.all([
      workspace().ensureGeneralSpace({ workspaceId: WORKSPACE_ID, userId: OWNER }),
      workspace().ensureGeneralSpace({ workspaceId: WORKSPACE_ID, userId: MEMBER }),
    ]);
    if (!first.ok || !second.ok) throw new Error("ensureGeneralSpace refused");

    expect(second.space.id).toBe(first.space.id);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(await workspace().runInspectionSql({
      sql: "SELECT space_id FROM workspace_space_directory WHERE system_role = 'general'",
      bindings: [],
    })).toMatchObject({ rows: [{ space_id: first.space.id }] });
    // And the loser left nothing behind: a reservation writes a viewer row and
    // an order row beside the directory row, and the refused one rolls all
    // three back rather than orphaning them under an id nothing names.
    expect(await workspace().runInspectionSql({
      sql: "SELECT COUNT(*) AS count FROM workspace_space_directory",
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
    await expect(workspace().spaceDefaultTargetActors(target)).resolves.toEqual([OWNER]);

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

    const general = await workspace().ensureGeneralSpace({ workspaceId: WORKSPACE_ID, userId: OWNER });
    if (!general.ok) throw new Error(general.code);

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
        "space_channel_memberships", "space_intents", "space_bootstrap_receipts",
        "space_bootstrap", "workspace_space_order", "workspace_space_viewers",
        "workspace_space_state", "workspace_space_directory",
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
      sql: "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'workspace_space_directory'",
      bindings: [],
    })).toMatchObject({ rows: [] });

    // Each read the connect payload makes answers empty rather than aborting.
    // Asserted through the RPCs first, because the socket's own failure mode is
    // a subscribe that never answers — true, and slower to read than this.
    await expect(workspace().listSpaces({ workspaceId: WORKSPACE_ID, userId: OWNER }))
      .resolves.toMatchObject({ ok: true, directory: { waterline: 0, items: [] } });
    await expect(workspace().listInactiveSpaces({ workspaceId: WORKSPACE_ID, userId: OWNER }))
      .resolves.toMatchObject({ ok: true, directory: { waterline: 0, items: [] } });
    await expect(workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID }))
      .resolves.toMatchObject({ phase: "pending", generalSpaceId: null, ready: false });
    await expect(workspace().channelSpaces({
      workspaceId: WORKSPACE_ID, userId: OWNER, workstreamId: CHANNEL_A,
    })).resolves.toEqual({ spaceIds: [] });

    const { socket, sidebar } = await connectViewer(OWNER, "cf11");
    expect(sidebar.spaces).toEqual({
      active: { waterline: 0, items: [] },
      inactive: { waterline: 0, items: [] },
    });
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

  it("given a guest's socket, when Spaces exist, then its payload carries none of them", async () => {
    await reserve("Company", "workspace");
    const { socket, sidebar } = await connectViewer(GUEST, "cf12");

    // Every Space RPC refuses a guest, and this is the other door into the same
    // state: the connect payload is a push, so a guest who never calls an RPC
    // would still have been handed every Organization-wide Space.
    expect(sidebar.spaces).toEqual({
      active: { waterline: 0, items: [] },
      inactive: { waterline: 0, items: [] },
    });
    // True rather than the Organization's real answer: a guest is not waiting
    // on the cutover, and `false` would leave their client in the
    // Organization-opening state for good.
    expect(sidebar.spacesReady).toBe(true);

    // And on the republication every Space write sends, which is the path a
    // guest holds open rather than asks for.
    const snapshot = nextSpaceSnapshot(socket);
    await workspace().reorderSpaces({
      workspaceId: WORKSPACE_ID, userId: OWNER, order: { spaceIds: [] },
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

    const general = await workspace().ensureGeneralSpace({ workspaceId: WORKSPACE_ID, userId: OWNER });
    if (!general.ok) throw new Error(general.code);

    await expect(workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID }))
      .resolves.toMatchObject({ phase: "general", generalSpaceId: general.space.id, ready: false });
  });

  it("given a viewer's order, when they reorder Spaces, then only their own order moves", async () => {
    const first = await reserve("Company");
    const second = await reserve("Recruiting");
    await workspace().listSpaces({ workspaceId: WORKSPACE_ID, userId: MEMBER });

    await expect(workspace().reorderSpaces({
      workspaceId: WORKSPACE_ID, userId: OWNER, order: { spaceIds: [second, first] },
    })).resolves.toMatchObject({ ok: true, directory: { items: [{ id: second }, { id: first }] } });
    await expect(workspace().listSpaces({ workspaceId: WORKSPACE_ID, userId: MEMBER }))
      .resolves.toMatchObject({ ok: true, directory: { items: [{ id: first }, { id: second }] } });
  });

  it("given a reservation whose object never opened, when it is cancelled, then nothing remains", async () => {
    const spaceId = await reserve("Half-made");

    await expect(workspace().cancelSpaceReservation({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId,
    })).resolves.toEqual({ cancelled: true });
    await expect(workspace().listSpaces({ workspaceId: WORKSPACE_ID, userId: OWNER }))
      .resolves.toMatchObject({ ok: true, directory: { items: [] } });

    // And only the reservation this caller made. `source_version = 0` is a
    // window every Space passes through between being reserved and its first
    // projection, so a cancel that named only the id let any member delete
    // whatever anybody else was in the middle of creating.
    const mine = await reserve("Mine", "workspace", MEMBER);
    await expect(workspace().cancelSpaceReservation({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: mine,
    })).resolves.toEqual({ cancelled: false });
    await expect(workspace().cancelSpaceReservation({
      workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId: mine,
    })).resolves.toEqual({ cancelled: true });

    // Only a row nothing has projected onto: once the Space's own object has
    // published a version, cancelling would delete a Space that exists.
    const second = await reserve("Real");
    await workspace().applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [spaceEnvelope(second, spaceDirectoryEffect("Real", "workspace"), 1)],
    });
    await expect(workspace().cancelSpaceReservation({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: second,
    })).resolves.toEqual({ cancelled: false });
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

  it("given an audience change, when it is recorded, then it stages an intent the alarm can resume", async () => {
    const spaceId = await reserve("Company");
    const operationId = "00000000-0000-7000-8000-00000000cf0b";

    await expect(workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId,
      operationId,
      audience: { scope: "personal", participantUserIds: [OWNER, MEMBER] },
    })).resolves.toMatchObject({
      ok: true,
      space: { scope: "personal", participants: [{ userId: OWNER }, { userId: MEMBER }] },
    });
    expect(await workspace().runInspectionSql({
      sql: "SELECT kind, state FROM space_intents WHERE operation_id = ?",
      bindings: [operationId],
    })).toMatchObject({ rows: [{ kind: "audience", state: "pending" }] });

    await workspace().recordSpaceIntentReceipt({
      workspaceId: WORKSPACE_ID, userId: OWNER, operationId, receipt: "audience_settled", settled: true,
    });
    expect(await workspace().runInspectionSql({
      sql: "SELECT state, receipts_json FROM space_intents WHERE operation_id = ?",
      bindings: [operationId],
    })).toMatchObject({ rows: [{ state: "settled", receipts_json: '["audience_settled"]' }] });
  });
});
