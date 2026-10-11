/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The reads behind the Channels, Threads and Activity tabs, on real workerd.
 *
 * Storage words and product words differ here, and the tests use the product
 * ones: a **Channel** is a stored Space, a **thread** is a stored Channel
 * (`channels`), a **breakout** is a substream. See
 * `docs/PRDs/2026-10-10_channels-threads-navigation/prd.md`.
 *
 * Each case is about who may be told what: the feed's locked rows, a private
 * Channel's absence, the Threads tab's participation filter, the pin gate, and
 * the Activity tab's per-viewer filter. All of it is SQL over storage the
 * listing rules render into, so a double could only describe it back to
 * itself.
 */
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asSpaceId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type SpaceId,
  type UserId,
  type WorkstreamId,
} from "@rally/contracts";
import {
  conversationEffectHash,
  ParentEffectEnvelopeSchema,
  type ParentEffect,
} from "@rally/contracts/conversation-effects";

import { WORKSPACE_CHANNEL_READS_MIGRATION } from "../src/durable-objects/workspace-channel-read-storage";
import { WORKSPACE_PINS_MIGRATION } from "../src/durable-objects/workspace-pin-storage";
import { WorkspaceRegionalEffectApplyRequestSchema } from "../src/durable-objects/workspace-directory-protocol";
import { applyWorkstreamRegionalEnvelope } from "../src/durable-objects/workspace-regional-effect-storage";
import { hostedParentStub } from "./helpers/hosted-parent";
import { placeMembership, removeMembership } from "./helpers/space-membership";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000e100");
const OWNER = asUserId("00000000-0000-7000-8000-00000000e101");
const MEMBER = asUserId("00000000-0000-7000-8000-00000000e102");
const OPEN_THREAD = asWorkstreamId("00000000-0000-7000-8000-00000000e103");
const PRIVATE_THREAD = asWorkstreamId("00000000-0000-7000-8000-00000000e104");
const MEMBER_THREAD = asWorkstreamId("00000000-0000-7000-8000-00000000e105");
const BREAKOUT = asSubstreamId("00000000-0000-7000-8000-00000000e106");
const GUEST = asUserId("00000000-0000-7000-8000-00000000e107");
const LATE_THREAD = asWorkstreamId("00000000-0000-7000-8000-00000000e108");

const workspace = () => hostedParentStub(env, WORKSPACE_ID);

let effectSequence = 0;
function messageId(): string {
  effectSequence += 1;
  return `00000000-0000-7000-8000-${String(effectSequence).padStart(10, "0")}e1`;
}

async function establishWorkspace(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT, abandoned_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      incarnation TEXT DEFAULT 'existing-member',
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT, access_class TEXT NOT NULL DEFAULT 'member',
      last_seen_at TEXT, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_control (
      id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
      VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`INSERT OR REPLACE INTO workspaces(id, region) VALUES (?, 'global')`).bind(WORKSPACE_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role, access_class) VALUES (?, ?, 'active', 'owner', 'member')`)
      .bind(WORKSPACE_ID, OWNER),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role, access_class) VALUES (?, ?, 'active', 'member', 'member')`)
      .bind(WORKSPACE_ID, MEMBER),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role, access_class) VALUES (?, ?, 'active', NULL, 'guest')`)
      .bind(WORKSPACE_ID, GUEST),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
}

function threadEffect(title: string, overrides: {
  scope?: "personal" | "workspace";
  state?: string;
  completedAt?: string | null;
  lastActivityAt?: string;
} = {}): ParentEffect {
  return {
    kind: "directory_common",
    title,
    description: `${title} summary`,
    preview: "",
    scope: overrides.scope ?? "workspace",
    state: overrides.state ?? "idle",
    systemKind: null,
    lastActivityAt: overrides.lastActivityAt ?? "2026-10-01T00:00:00.000Z",
    completedAt: overrides.completedAt ?? null,
    archivedAt: null,
    createdByUserId: OWNER,
    latestAttentionOrdinal: 0,
    unreadTrackingStartOrdinal: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    resourceLinks: [],
  };
}

function viewerEffect(userId: UserId, overrides: { isParticipant?: boolean; listable?: boolean } = {}): ParentEffect {
  return {
    kind: "directory_user",
    userId,
    isParticipant: overrides.isParticipant ?? true,
    participantAddedAt: "2026-10-01T00:00:00.000Z",
    unreadCount: 0,
    youAreMentioned: false,
    unseen: false,
    listable: overrides.listable ?? true,
    seenAttentionOrdinal: 0,
    manualUnreadFromOrdinal: null,
    manualUnreadGeneration: 0,
    latestMentionAttentionOrdinal: 0,
  };
}

function breakoutEffect(title: string, overrides: { state?: string; completedAt?: string | null } = {}): ParentEffect {
  return {
    kind: "directory_common",
    title,
    description: "",
    preview: "",
    scope: "personal",
    state: overrides.state ?? "idle",
    systemKind: null,
    lastActivityAt: "2026-10-02T00:00:00.000Z",
    completedAt: overrides.completedAt ?? null,
    archivedAt: null,
    latestAttentionOrdinal: 0,
    unreadTrackingStartOrdinal: 0,
  } as ParentEffect;
}

async function publish(
  workstreamId: WorkstreamId,
  effects: readonly ParentEffect[],
  substreamId?: string,
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
      ...(substreamId ? { substreamId } : {}),
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

async function openThreadObject(workstreamId: WorkstreamId): Promise<void> {
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

async function reserveChannel(name: string): Promise<SpaceId> {
  const result = await workspace().reserveSpace({
    workspaceId: WORKSPACE_ID,
    userId: OWNER,
    space: { name, iconKey: "briefcase", colorKey: "blue", scope: "workspace" },
  });
  if (!result.ok) throw new Error(`reserveSpace refused: ${result.code}`);
  return asSpaceId(result.space.id);
}

async function place(channelId: SpaceId, workstreamId: WorkstreamId): Promise<void> {
  await placeMembership(workspace(), { workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: channelId, workstreamId });
}

/**
 * A Channel with three threads, oldest placement first: one the whole
 * Organization may open, one private to the owner, and one the member started.
 */
async function channelWithThreads(): Promise<SpaceId> {
  const channelId = await reserveChannel("Outbound");
  await openThreadObject(OPEN_THREAD);
  await publish(OPEN_THREAD, [threadEffect("Cold outreach"), viewerEffect(OWNER)]);
  await place(channelId, OPEN_THREAD);
  await openThreadObject(PRIVATE_THREAD);
  await publish(PRIVATE_THREAD, [threadEffect("Comp bands", { scope: "personal" }), viewerEffect(OWNER)]);
  await place(channelId, PRIVATE_THREAD);
  return channelId;
}

async function feed(channelId: SpaceId, userId: UserId) {
  const result = await workspace().listChannelFeed({ workspaceId: WORKSPACE_ID, userId, spaceId: channelId, cursor: null });
  if (!result.ok) throw new Error(`listChannelFeed refused: ${result.code}`);
  return result.page;
}

async function myThreads(userId: UserId) {
  const result = await workspace().listMyThreads({ workspaceId: WORKSPACE_ID, userId, cursor: null });
  if (!result.ok) throw new Error(`listMyThreads refused: ${result.code}`);
  return result.page;
}

async function activity(userId: UserId) {
  const result = await workspace().listActivity({ workspaceId: WORKSPACE_ID, userId, cursor: null });
  if (!result.ok) throw new Error(`listActivity refused: ${result.code}`);
  return result.page;
}

beforeEach(async () => {
  await reset();
  effectSequence = 0;
  await establishWorkspace();
});

describe("Channel feed", () => {
  it("given a private thread in a Channel, when a member who cannot open it reads the feed, then it is a locked row with nothing but its id", async () => {
    const channelId = await channelWithThreads();

    const page = await feed(channelId, MEMBER);

    expect(page.items).toEqual([
      { kind: "locked", placedAt: expect.any(String), attentionSequenceNumber: 2, threadId: PRIVATE_THREAD },
      expect.objectContaining({ kind: "thread", thread: expect.objectContaining({ id: OPEN_THREAD, title: "Cold outreach" }) }),
    ]);
    // The owner opens both, so neither is locked for them.
    expect((await feed(channelId, OWNER)).items.map((item) => item.kind)).toEqual(["thread", "thread"]);
  });
});

describe("Channel feed for a guest", () => {
  it("given a guest added to one thread in a Channel, when they read its feed, then they see that thread and no locked rows", async () => {
    const channelId = await channelWithThreads();
    await publish(OPEN_THREAD, [viewerEffect(GUEST)]);

    const page = await feed(channelId, GUEST);

    expect(page.items.map((item) => item.kind === "thread" ? ["thread", item.thread.id] : ["locked", item.threadId]))
      .toEqual([["thread", OPEN_THREAD]]);
  });
});

describe("private Channels", () => {
  it("given a Channel made private, when a member who is not in it reads it, then it does not exist for them even through a thread in it", async () => {
    const channelId = await channelWithThreads();
    // The member can open a thread in it, which lists an Organization-wide
    // Channel to anybody; a private one stays unnamed.
    await publish(OPEN_THREAD, [viewerEffect(MEMBER)]);

    const made = await workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId: channelId,
      audience: { scope: "personal", participantUserIds: [OWNER] },
    });
    expect(made).toMatchObject({ ok: true, space: { scope: "personal" } });

    await expect(workspace().spaceSummary({ workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId: channelId }))
      .resolves.toMatchObject({ ok: false, code: "space_not_found" });
    await expect(workspace().listChannelFeed({ workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId: channelId, cursor: null }))
      .resolves.toEqual({ ok: false, code: "space_not_found" });
    await expect(workspace().spaceSummary({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: channelId }))
      .resolves.toMatchObject({ ok: true });
  });

  it("given General, when somebody makes it private, then it is refused as protected", async () => {
    const general = await workspace().openGeneralSpace({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: asSpaceId("00000000-0000-7000-8000-00000000e1aa"),
    });
    if (!general.ok || "absent" in general) throw new Error("openGeneralSpace refused");

    await expect(workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId: asSpaceId(general.space.id),
      audience: { scope: "personal", participantUserIds: [OWNER] },
    })).resolves.toMatchObject({ ok: false, code: "space_protected" });
  });
});

describe("archiving a Channel", () => {
  async function openGeneral(): Promise<SpaceId> {
    const general = await workspace().openGeneralSpace({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: asSpaceId("00000000-0000-7000-8000-00000000e1aa"),
    });
    if (!general.ok || "absent" in general) throw new Error("openGeneralSpace refused");
    return asSpaceId(general.space.id);
  }
  const placedIn = async (channelId: SpaceId) => (await feed(channelId, OWNER)).items
    .map((item) => item.kind === "thread" ? item.thread.id : item.threadId);

  it("given an Organization-wide thread that lives only in a Channel, when the Channel is archived, then the thread moves to General and a restore puts it back", async () => {
    const generalId = await openGeneral();
    const channelId = await reserveChannel("Outbound");
    await openThreadObject(OPEN_THREAD);
    await publish(OPEN_THREAD, [threadEffect("Cold outreach"), viewerEffect(OWNER)]);
    await place(channelId, OPEN_THREAD);

    await expect(workspace().archiveSpace({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: channelId }))
      .resolves.toMatchObject({ ok: true, space: { status: "archived" } });
    expect(await placedIn(generalId)).toEqual([OPEN_THREAD]);

    await expect(workspace().restoreSpace({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: channelId }))
      .resolves.toMatchObject({ ok: true, space: { status: "active" } });
    expect(await placedIn(channelId)).toEqual([OPEN_THREAD]);
  });

  it("given a private thread that lives only in a Channel, when the Channel is archived, then the archive is refused and nothing moved to General", async () => {
    const generalId = await openGeneral();
    const channelId = await channelWithThreads();

    // General shows a row to every member, so a private thread never moves
    // there; it keeps the archive refused, and the Organization-wide thread
    // that would have moved rolls back with the refusal.
    await expect(workspace().archiveSpace({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: channelId }))
      .resolves.toMatchObject({ ok: false, code: "space_membership_final" });
    expect(await placedIn(generalId)).toEqual([]);
    expect(await placedIn(channelId)).toEqual(expect.arrayContaining([OPEN_THREAD, PRIVATE_THREAD]));
  });
});

describe("Channels tab", () => {
  it("given a Channel with an open and a private thread, when each person reads the stats, then each counts only the threads they may list", async () => {
    const channelId = await channelWithThreads();

    const count = async (userId: UserId) => {
      const result = await workspace().listChannelStats({ workspaceId: WORKSPACE_ID, userId });
      if (!result.ok) throw new Error(`listChannelStats refused: ${result.code}`);
      return result.stats.find((stats) => stats.channelId === channelId)?.threadCount;
    };

    expect(await count(MEMBER)).toBe(1);
    expect(await count(OWNER)).toBe(2);
  });
});

describe("Channel read state", () => {
  async function stats(userId: UserId, channelId: SpaceId) {
    const result = await workspace().listChannelStats({ workspaceId: WORKSPACE_ID, userId });
    if (!result.ok) throw new Error(`listChannelStats refused: ${result.code}`);
    const row = result.stats.find((entry) => entry.channelId === channelId);
    if (!row) throw new Error("Channel not listed");
    return row;
  }

  const readState = (row: Awaited<ReturnType<typeof stats>>) => ({
    latest: row.latestAttentionSequenceNumber,
    readThrough: row.readThroughSequenceNumber,
    firstUnread: row.firstUnreadSequenceNumber,
    hasUnread: row.hasUnread,
  });

  it("given the owner places two threads, when each person reads the stats, then the member is unread from the first and the owner has read their own placements", async () => {
    const channelId = await channelWithThreads();

    expect(readState(await stats(MEMBER, channelId))).toEqual({ latest: 2, readThrough: 0, firstUnread: 1, hasUnread: true });
    expect(readState(await stats(OWNER, channelId))).toEqual({ latest: 2, readThrough: 2, firstUnread: null, hasUnread: false });
  });

  it("given an unread Channel, when the member acknowledges it, then it is read, and a later placement makes it unread again", async () => {
    const channelId = await channelWithThreads();

    const acknowledged = await workspace().acknowledgeSpaceRead({
      workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId: channelId,
      readThroughSequenceNumber: 2,
    });
    expect(acknowledged).toMatchObject({ ok: true, stats: { channelId, readThroughSequenceNumber: 2, hasUnread: false } });
    expect(readState(await stats(MEMBER, channelId))).toEqual({ latest: 2, readThrough: 2, firstUnread: null, hasUnread: false });

    await openThreadObject(LATE_THREAD);
    await publish(LATE_THREAD, [threadEffect("Late addition"), viewerEffect(OWNER)]);
    await place(channelId, LATE_THREAD);

    expect(readState(await stats(MEMBER, channelId))).toEqual({ latest: 3, readThrough: 2, firstUnread: 3, hasUnread: true });
  });

  it("given placements that existed before migration 98, when its backfill runs, then each is numbered in placement order and nothing is unread", async () => {
    const channelId = await channelWithThreads();

    // Put the rows back the way an object held them before migration 98 (the
    // columns at their defaults), then run the migration's own backfill.
    await runInDurableObject(workspace(), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`UPDATE space_channel_memberships SET attention_ordinal = NULL`);
      sql.exec(`UPDATE spaces SET latest_attention_ordinal = 0, unread_tracking_start_ordinal = 0`);
      sql.exec(`DELETE FROM space_reads`);
      for (const statement of WORKSPACE_CHANNEL_READS_MIGRATION.slice(4)) sql.exec(statement);
    });

    expect(readState(await stats(MEMBER, channelId))).toEqual({ latest: 2, readThrough: 2, firstUnread: null, hasUnread: false });
    expect((await feed(channelId, OWNER)).items.map((item) => [
      item.kind === "thread" ? item.thread.id : item.threadId, item.attentionSequenceNumber,
    ])).toEqual([[PRIVATE_THREAD, 2], [OPEN_THREAD, 1]]);
  });

  it("given a thread removed from a Channel, when it is placed again, then it takes a fresh, higher ordinal and the waterline never went down", async () => {
    const channelId = await channelWithThreads();
    // A second home, so the removal is not the thread's last placement.
    const elsewhere = await reserveChannel("Elsewhere");
    await place(elsewhere, OPEN_THREAD);

    await removeMembership(workspace(), { workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: channelId, workstreamId: OPEN_THREAD });
    expect((await stats(MEMBER, channelId)).latestAttentionSequenceNumber).toBe(2);

    await place(channelId, OPEN_THREAD);

    const ordinals = (await feed(channelId, OWNER)).items.map((item) => [
      item.kind === "thread" ? item.thread.id : item.threadId, item.attentionSequenceNumber,
    ]);
    expect(ordinals).toEqual(expect.arrayContaining([[OPEN_THREAD, 3], [PRIVATE_THREAD, 2]]));
    expect(readState(await stats(MEMBER, channelId))).toEqual({ latest: 3, readThrough: 0, firstUnread: 1, hasUnread: true });
  });

  it("given the newest placement since removed, when the member reads the feed and acknowledges what it says, then the Channel is read", async () => {
    const channelId = await channelWithThreads();
    const elsewhere = await reserveChannel("Elsewhere");
    await place(elsewhere, PRIVATE_THREAD);
    await removeMembership(workspace(), { workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: channelId, workstreamId: PRIVATE_THREAD });

    const page = await feed(channelId, MEMBER);
    expect(page.items.map((item) => item.attentionSequenceNumber)).toEqual([1]);
    expect(page.latestAttentionSequenceNumber).toBe(2);
    await workspace().acknowledgeSpaceRead({
      workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId: channelId,
      readThroughSequenceNumber: page.latestAttentionSequenceNumber!,
    });

    expect(readState(await stats(MEMBER, channelId))).toEqual({ latest: 2, readThrough: 2, firstUnread: null, hasUnread: false });
  });

  it("given a guest who reaches a Channel through a thread in it, when they read the stats, then the Channel is never unread for them", async () => {
    const channelId = await channelWithThreads();
    await publish(OPEN_THREAD, [viewerEffect(GUEST)]);

    expect(readState(await stats(GUEST, channelId))).toEqual({ latest: 2, readThrough: 2, firstUnread: null, hasUnread: false });
    // The member, who saw the same placements, is unread: the guest's answer is the exclusion, not an empty Channel.
    expect((await stats(MEMBER, channelId)).hasUnread).toBe(true);
  });

  it("given a Channel the member cannot list, when they acknowledge it, then it is refused as not found", async () => {
    const channelId = await channelWithThreads();
    await workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: channelId,
      audience: { scope: "personal", participantUserIds: [OWNER] },
    });

    await expect(workspace().acknowledgeSpaceRead({
      workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId: channelId,
      readThroughSequenceNumber: 2,
    })).resolves.toEqual({ ok: false, code: "space_not_found" });
  });
});

describe("Threads tab", () => {
  it("given threads and a breakout, when a person reads their threads, then it lists what they take part in and leaves the rest out", async () => {
    await channelWithThreads();
    await openThreadObject(MEMBER_THREAD);
    // The member is listed on, but not part of, this Organization-wide thread.
    await publish(MEMBER_THREAD, [threadEffect("Launch plan"), viewerEffect(MEMBER, { isParticipant: false })]);
    await publish(OPEN_THREAD, [viewerEffect(MEMBER)]);
    await publish(OPEN_THREAD, [breakoutEffect("Make a website"), viewerEffect(MEMBER)], BREAKOUT);

    const page = await myThreads(MEMBER);

    expect(page.items.map((item) => [item.kind, item.id])).toEqual([
      ["breakout", BREAKOUT],
      ["channel", OPEN_THREAD],
    ]);
    expect(page.items[0]).toMatchObject({ breakoutOf: { workstreamId: OPEN_THREAD, title: "Cold outreach" } });
  });

  it("given a pinned thread the person does not take part in, when they read the first page, then it comes back with the pins and nothing they only take part in does", async () => {
    await channelWithThreads();
    await openThreadObject(MEMBER_THREAD);
    await publish(MEMBER_THREAD, [threadEffect("Launch plan"), viewerEffect(MEMBER, { isParticipant: false })]);
    await publish(OPEN_THREAD, [viewerEffect(MEMBER)]);
    await workspace().changePin({
      workspaceId: WORKSPACE_ID, userId: MEMBER, kind: "thread", itemId: MEMBER_THREAD, parentId: null, pinned: true,
    });

    const page = await myThreads(MEMBER);

    expect(page.pinned.map((item) => [item.kind, item.id])).toEqual([["channel", MEMBER_THREAD]]);
  });
});

describe("pins", () => {
  it("given an item the person may not list, when they pin it, then it is refused and nothing is stored", async () => {
    const channelId = await channelWithThreads();

    await expect(workspace().changePin({
      workspaceId: WORKSPACE_ID, userId: MEMBER, kind: "thread", itemId: PRIVATE_THREAD, parentId: null, pinned: true,
    })).resolves.toEqual({ ok: false, code: "pin_target_not_found" });

    await workspace().changePin({
      workspaceId: WORKSPACE_ID, userId: MEMBER, kind: "thread", itemId: OPEN_THREAD, parentId: null, pinned: true,
    });
    const pinned = await workspace().changePin({
      workspaceId: WORKSPACE_ID, userId: MEMBER, kind: "channel", itemId: channelId, parentId: null, pinned: true,
    });
    expect(pinned).toEqual({
      ok: true,
      pins: [
        { kind: "channel", id: channelId, parentId: null },
        { kind: "thread", id: OPEN_THREAD, parentId: null },
      ],
    });
  });

  it("given a breakout private to its owner, when a member pins it, then it is refused until they are in it, and only under its own thread", async () => {
    await channelWithThreads();
    await publish(OPEN_THREAD, [breakoutEffect("Side work"), viewerEffect(OWNER)], BREAKOUT);
    const pinBreakout = (parentId: WorkstreamId) => workspace().changePin({
      workspaceId: WORKSPACE_ID, userId: MEMBER, kind: "breakout", itemId: BREAKOUT, parentId, pinned: true,
    });

    // The member may list the thread, which is not the breakout.
    await expect(pinBreakout(OPEN_THREAD)).resolves.toEqual({ ok: false, code: "pin_target_not_found" });

    await publish(OPEN_THREAD, [viewerEffect(MEMBER)], BREAKOUT);
    // Named under another thread, it is still not there.
    await expect(pinBreakout(PRIVATE_THREAD)).resolves.toEqual({ ok: false, code: "pin_target_not_found" });
    await expect(pinBreakout(OPEN_THREAD)).resolves.toEqual({
      ok: true, pins: [{ kind: "breakout", id: BREAKOUT, parentId: OPEN_THREAD }],
    });
  });

  it("given two pinned Channels, when the member moves the second up, then the stored order is the new one", async () => {
    const first = await reserveChannel("First");
    const second = await reserveChannel("Second");
    for (const itemId of [first, second]) {
      await workspace().changePin({ workspaceId: WORKSPACE_ID, userId: MEMBER, kind: "channel", itemId, parentId: null, pinned: true });
    }

    const moved = await workspace().reorderPins({ workspaceId: WORKSPACE_ID, userId: MEMBER, kind: "channel", ids: [second, first] });

    expect(moved).toEqual({ ok: true, pins: [
      { kind: "channel", id: second, parentId: null },
      { kind: "channel", id: first, parentId: null },
    ] });
  });

  it("given a private Channel, when a member who is not in it pins it, then it is refused", async () => {
    const channelId = await channelWithThreads();
    await workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: channelId,
      audience: { scope: "personal", participantUserIds: [OWNER] },
    });

    await expect(workspace().changePin({
      workspaceId: WORKSPACE_ID, userId: MEMBER, kind: "channel", itemId: channelId, parentId: null, pinned: true,
    })).resolves.toEqual({ ok: false, code: "pin_target_not_found" });
  });

  it("given a pinned thread made private, when the member reads their threads, then the pin no longer lists it", async () => {
    await channelWithThreads();
    await workspace().changePin({
      workspaceId: WORKSPACE_ID, userId: MEMBER, kind: "thread", itemId: OPEN_THREAD, parentId: null, pinned: true,
    });
    expect((await myThreads(MEMBER)).pinned.map((item) => item.id)).toEqual([OPEN_THREAD]);

    await publish(OPEN_THREAD, [threadEffect("Cold outreach", { scope: "personal" })], undefined, 2);

    expect((await myThreads(MEMBER)).pinned).toEqual([]);
  });

  it("given pins in several old Spaces and an arranged order, when migration 97 copies them, then each thread is pinned once in the arranged order", async () => {
    const first = await reserveChannel("First");
    const second = await reserveChannel("Second");
    await openThreadObject(OPEN_THREAD);
    await publish(OPEN_THREAD, [threadEffect("Alpha")]);
    await openThreadObject(MEMBER_THREAD);
    await publish(MEMBER_THREAD, [threadEffect("Beta")]);
    await openThreadObject(PRIVATE_THREAD);
    await publish(PRIVATE_THREAD, [threadEffect("Gamma")]);

    const copied = await runInDurableObject(workspace(), (_instance, state) => {
      const sql = state.storage.sql;
      // Alpha is pinned in two Spaces, and the arranged order puts Beta first;
      // Gamma was never arranged, so it follows by its Space position.
      for (const [spaceId, workstreamId, position] of [
        [first, OPEN_THREAD, 0], [second, OPEN_THREAD, 1], [second, MEMBER_THREAD, 0], [first, PRIVATE_THREAD, 2],
      ] as const) {
        sql.exec(
          `INSERT INTO workspace_workstream_pins (user_id, space_id, workstream_id, position, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, 1)`,
          OWNER, spaceId, workstreamId, position,
        );
      }
      sql.exec(`INSERT INTO workspace_pinned_order (user_id, item_id, position, updated_at) VALUES (?, ?, 0, 1)`, OWNER, MEMBER_THREAD);
      sql.exec(`INSERT INTO workspace_pinned_order (user_id, item_id, position, updated_at) VALUES (?, ?, 1, 1)`, OWNER, OPEN_THREAD);
      // The copy is the migration's own statement, run against the real schema.
      sql.exec(`DELETE FROM workspace_pins`);
      sql.exec(WORKSPACE_PINS_MIGRATION[2] as string);
      return sql.exec<{ item_id: string; position: number }>(
        `SELECT item_id, position FROM workspace_pins WHERE user_id = ? ORDER BY position`, OWNER,
      ).toArray().map((row) => row.item_id);
    });

    expect(copied).toEqual([MEMBER_THREAD, OPEN_THREAD, PRIVATE_THREAD]);
  });
});

describe("Activity tab", () => {
  it("given starts in conversations a member may and may not list, when they read Activity, then only the listable ones appear", async () => {
    await channelWithThreads();
    // The owner starts all three: an Organization-wide thread, a private one,
    // and a breakout private to the owner inside the thread the member can open.
    await publish(OPEN_THREAD, [breakoutEffect("Side work"), viewerEffect(OWNER)], BREAKOUT);

    const member = await activity(MEMBER);
    expect(member.items.map((item) => [item.kind, item.threadId, item.breakout])).toEqual([
      ["thread_started", OPEN_THREAD, null],
    ]);
    // The owner started all three, and their own starts are not news to them.
    expect((await activity(OWNER)).items).toEqual([]);
  });

  it("given a mention in a breakout, when the person named reads Activity, then it appears only once they may list the breakout", async () => {
    await channelWithThreads();
    await publish(OPEN_THREAD, [viewerEffect(MEMBER)]);
    await publish(OPEN_THREAD, [breakoutEffect("Side work"), viewerEffect(OWNER)], BREAKOUT);
    // What WorkspaceDO stores for a breakout's forwarded mention: no text, the
    // author as its only audience, the mention as its one target
    // (`breakout-activity.ts`; hosted-parent-local-effects.test.ts proves it).
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO workspace_activity_events (
          event_id, event_type, subject_type, subject_id, subject_sequence_number, actor_type, actor_user_id,
          actor_label, title, body, canonical_url, audience_kind, audience_user_id, audience_workstream_id,
          digestible, occurred_at, created_at, source_kind, source_id, dedupe_key, metadata_json
        ) VALUES ('mention-event', 'workstream_message_created', 'workstream', ?, 3, 'user', ?, 'Owner', 'Side work', '',
          NULL, 'user', ?, NULL, 0, 1759708800000, 1759708800000, 'workstream_message', 'breakout-turn',
          'message:breakout-turn', ?)`, OPEN_THREAD, OWNER, OWNER, JSON.stringify({ substreamId: BREAKOUT }));
      state.storage.sql.exec(`INSERT INTO workspace_activity_event_targets (event_id, user_id, relation, created_at)
        VALUES ('mention-event', ?, 'mentioned', 1759708800000)`, MEMBER);
    });
    const mentions = async () => (await activity(MEMBER)).items.filter((item) => item.kind === "mentioned");

    // Private to the owner: the member is named but may not list it.
    expect(await mentions()).toEqual([]);

    await publish(OPEN_THREAD, [viewerEffect(MEMBER)], BREAKOUT);
    expect(await mentions()).toEqual([expect.objectContaining({
      kind: "mentioned", threadId: OPEN_THREAD, breakout: expect.objectContaining({ substreamId: BREAKOUT }),
    })]);
  });

  it("given more hidden starts than a page holds, when a member reads Activity, then the page holds what they may list and its cursor names nothing hidden", async () => {
    await channelWithThreads();
    // A page's worth and one more private threads the owner started after the
    // open one. Filtered after the LIMIT, they would fill the page and its
    // cursor with threads the member may not list, and push the open one off.
    await runInDurableObject(workspace(), (_instance, state) => {
      const sql = state.storage.sql;
      const columns = sql.exec<{ name: string }>("PRAGMA table_info(channels)").toArray().map((column) => column.name);
      const source = columns.map((column) => (
        column === "workstream_id" ? "?1 || substr(workstream_id, length(?1) + 1)"
          : column === "source_created_at" ? "?2"
            : column === "source_event_id" ? "source_event_id || ?2"
              : column
      ));
      for (let index = 0; index <= 250; index += 1) {
        sql.exec(
          `INSERT INTO channels (${columns.join(", ")}) SELECT ${source.join(", ")} FROM channels WHERE workstream_id = ?3`,
          `00000000-0000-7000-8000-${String(index + 1000).padStart(4, "0")}`,
          Date.parse("2026-11-01T00:00:00.000Z") + index,
          PRIVATE_THREAD,
        );
      }
    });

    const page = await activity(MEMBER);
    expect(page.items.map((item) => [item.kind, item.threadId])).toEqual([["thread_started", OPEN_THREAD]]);
    expect(page.nextCursor).toBeNull();
  });

  it("given a breakout's mention whose author is unknown, when it is applied, then it is not stored at all rather than shown to the parent thread", async () => {
    await channelWithThreads();
    const effect: ParentEffect = {
      kind: "activity_event",
      eventId: "00000000-0000-7000-8000-00000000e1f1",
      eventType: "workstream_message_created",
      subjectSequenceNumber: 4,
      actorType: "user",
      actorUserId: OWNER,
      actorLabel: "Owner",
      title: "Side work",
      body: "",
      canonicalUrl: null,
      digestible: false,
      occurredAt: "2026-10-05T00:00:00.000Z",
      sourceKind: "workstream_message",
      sourceId: "breakout-turn",
      dedupeKey: "message:breakout-turn",
      metadata: { substreamId: BREAKOUT },
      targets: [{ userId: MEMBER, relation: "mentioned" }],
    } as ParentEffect;
    await runInDurableObject(workspace(), (_instance, state) => {
      // The Queue re-reads the author from D1, and a deleted account reads back
      // as null: the one way this arrives with no author.
      applyWorkstreamRegionalEnvelope(state.storage, WorkspaceRegionalEffectApplyRequestSchema.parse({
        workspaceId: WORKSPACE_ID,
        envelope: ParentEffectEnvelopeSchema.parse({
          kind: "parent_effect", contractVersion: 1, region: "global", workspaceId: WORKSPACE_ID,
          parentKind: "workstream", parentId: OPEN_THREAD, generation: 1, messageId: messageId(),
          partitionKey: "common", sourceVersion: 1, requiredProjectionVersion: null,
          payloadHash: conversationEffectHash(effect), effect,
        }),
        actorUserId: null,
        targetUserIds: [MEMBER],
        recipientIsActiveMember: false,
      }), Date.now());
      expect(state.storage.sql.exec(
        "SELECT audience_kind FROM workspace_activity_events WHERE dedupe_key = 'message:breakout-turn'",
      ).toArray()).toEqual([]);
    });
  });

  it("given a finished run in a thread the person takes part in, when they read Activity, then Rally's finish appears once and marking it seen clears its dot", async () => {
    await openThreadObject(MEMBER_THREAD);
    await publish(MEMBER_THREAD, [
      threadEffect("Funnel report", { state: "completed", completedAt: "2026-10-06T00:00:00.000Z" }),
      viewerEffect(MEMBER),
    ]);

    // The owner started it too, which is its own row; this is about the finish.
    const finished = async () => (await activity(MEMBER)).items.filter((item) => item.kind === "run_finished");
    expect(await finished()).toEqual([expect.objectContaining({
      kind: "run_finished", threadId: MEMBER_THREAD, threadTitle: "Funnel report", actorLabel: "Rally", unread: true,
    })]);

    await workspace().markActivitySeen({
      workspaceId: WORKSPACE_ID, userId: MEMBER, seenThrough: Date.parse("2026-10-06T00:00:00.000Z"),
    });
    expect((await finished()).map((item) => item.unread)).toEqual([false]);
  });
});
