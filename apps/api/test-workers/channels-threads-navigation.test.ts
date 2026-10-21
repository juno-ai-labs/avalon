/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The reads behind the Channels, Threads and Activity tabs, on real workerd.
 *
 * Storage words and product words differ here, and the tests use the product
 * ones: a **Channel** is a stored Space, a **thread** is a stored Channel
 * (`channels`), a **breakout** is a substream. See
 * `docs/PRDs/2026-10-10_channels-threads-navigation/prd.md`.
 *
 * Each case is about who may be told what: the feed's private threads, a private
 * Channel's absence, the Threads tab's participation filter, the pin gate, and
 * the Activity tab's per-viewer filter. All of it is SQL over storage the
 * listing rules render into, so a double could only describe it back to
 * itself.
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
  type ActivitySubject,
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
import { drainResourceVersionChanges } from "../src/durable-objects/workspace-resource-versions";
import { WorkspaceActivityFeed } from "../src/durable-objects/workspace-activity-feed";
import { WorkspaceActivityPushes } from "../src/durable-objects/workspace-activity-push";
import { WorkspaceSpaceStorage } from "../src/durable-objects/workspace-space-storage";
import { searchAudienceGroup, searchAudienceGroupIds } from "../src/services/search-audience";
import { WorkspaceRegionalEffectApplyRequestSchema } from "../src/durable-objects/workspace-directory-protocol";
import { applyWorkstreamRegionalEnvelope } from "../src/durable-objects/workspace-regional-effect-storage";
import { hostedParentStub } from "./helpers/hosted-parent";
import { withSpaceStorage, placeMembership, removeMembership } from "./helpers/space-membership";
import { rankPeople } from "../src/durable-objects/workspace-people-ranking";

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
  latestAttentionOrdinal?: number;
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
    latestAttentionOrdinal: overrides.latestAttentionOrdinal ?? 0,
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
  // The placements: what every case here is about. Rally's own messages in a
  // Channel are `personal-channel.test.ts`'s.
  return { ...result.page, items: result.page.items.flatMap((item) => (item.kind === "message" ? [] : [item])) };
}

async function myThreads(userId: UserId) {
  const result = await workspace().listMyThreads({ workspaceId: WORKSPACE_ID, userId, cursor: null });
  if (!result.ok) throw new Error(`listMyThreads refused: ${result.code}`);
  return result.page;
}

async function activity(userId: UserId, only: "mentions" | null = null) {
  const result = await workspace().listActivity({ workspaceId: WORKSPACE_ID, userId, cursor: null, only });
  if (!result.ok) throw new Error(`listActivity refused: ${result.code}`);
  return result.page;
}

beforeEach(async () => {
  await reset();
  effectSequence = 0;
  await establishWorkspace();
});

describe("Channel feed", () => {
  it("given a private thread in a Channel, when a member who cannot open it reads the feed, then it is not listed", async () => {
    const channelId = await channelWithThreads();

    const page = await feed(channelId, MEMBER);

    expect(page.items).toEqual([
      expect.objectContaining({ kind: "thread", thread: expect.objectContaining({ id: OPEN_THREAD, title: "Cold outreach" }) }),
    ]);
    // The owner opens both, so both are listed for them.
    expect((await feed(channelId, OWNER)).items.map((item) => item.thread.id)).toEqual([PRIVATE_THREAD, OPEN_THREAD]);
  });
});

describe("People interaction ranking", () => {
  async function message(threadId: WorkstreamId, author: UserId, targets: Array<{ userId: UserId; relation: string }>, options: {
    substreamId?: string; metadata?: Record<string, unknown>; actorType?: 'user' | 'agent'; occurredAt?: string;
  } = {}) {
    await workspace().recordActivityEvent({
      workspaceId: WORKSPACE_ID, eventType: 'workstream_message_created', subjectType: 'workstream', subjectId: threadId,
      actorType: options.actorType ?? 'user', actorUserId: author, actorLabel: 'A person', title: 'A message',
      audience: { kind: 'workstream', workstreamId: threadId }, digestible: false,
      occurredAt: options.occurredAt ?? '2026-10-20T12:00:00.000Z', sourceKind: 'workstream_message', dedupeKey: messageId(),
      targets, metadata: { substreamId: options.substreamId ?? '0', ...options.metadata },
    });
  }

  it("seeks a person's interactions without scanning unrelated Organization history", async () => {
    const spaceId = await channelWithThreads();
    await message(OPEN_THREAD, OWNER, [{ userId: MEMBER, relation: 'mentioned' }]);
    await message(OPEN_THREAD, GUEST, [{ userId: OWNER, relation: 'mentioned' }]);
    await publish(OPEN_THREAD, [breakoutEffect('Shared breakout'), viewerEffect(OWNER), viewerEffect(MEMBER)], BREAKOUT);
    await message(OPEN_THREAD, MEMBER, [], { substreamId: BREAKOUT });
    await runInDurableObject(workspace(), (_instance, state) => {
      const reads = (): number => {
        const spy = vi.spyOn(state.storage.sql, 'exec');
        try {
          expect(rankPeople(state.storage, { userId: OWNER, accessClass: 'member' }, spaceId)).toEqual({
            channel: [MEMBER, GUEST], organization: [MEMBER, GUEST],
          });
          return (spy.mock.results[0]!.value as ReturnType<SqlStorage['exec']>).rowsRead;
        } finally { spy.mockRestore(); }
      };
      const before = reads();
      // Public replies between other people, with real target edges, must not
      // make this person's read grow with the Organization's retained traffic.
      state.storage.sql.exec(`WITH RECURSIVE numbers(n) AS
        (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 10000)
        INSERT INTO workspace_activity_events (
          event_id, event_type, subject_type, subject_id, actor_type, actor_user_id, actor_label, title, body,
          audience_kind, audience_workstream_id, digestible, occurred_at, created_at, source_kind, dedupe_key, metadata_json
        ) SELECT 'unrelated:' || n, 'workstream_message_created', 'workstream', ?, 'user', ?, 'Other', 'Other', '',
          'workstream', ?, 0, 1, 1, 'workstream_message', 'unrelated:' || n, '{"substreamId":"0"}' FROM numbers`,
      OPEN_THREAD, MEMBER, OPEN_THREAD);
      state.storage.sql.exec(`INSERT INTO workspace_activity_event_targets (event_id, user_id, relation, created_at)
        SELECT event_id, ?, 'mentioned', 1 FROM workspace_activity_events WHERE event_id LIKE 'unrelated:%'`, GUEST);
      const after = reads();
      expect(after).toBeLessThanOrEqual(before + 2);
    });
  });

  it("given replies and mentions, when ranking people, then Channel frequency and Organization frequency differ and each message counts once per person", async () => {
    const spaceId = await channelWithThreads();
    await publish(MEMBER_THREAD, [threadEffect('Another Channel'), viewerEffect(OWNER)]);
    const target = (userId: UserId) => [{ userId, relation: 'participant' }, { userId, relation: 'mentioned' }];
    await message(OPEN_THREAD, MEMBER, target(OWNER));
    await message(OPEN_THREAD, OWNER, [...target(MEMBER), { userId: GUEST, relation: 'mentioned' }]);
    for (let i = 0; i < 3; i += 1) await message(MEMBER_THREAD, GUEST, target(OWNER));
    // Public activity between other people, copied merges and agent text are not interactions with the reader.
    for (let i = 0; i < 5; i += 1) {
      await message(OPEN_THREAD, MEMBER, target(GUEST));
      await message(OPEN_THREAD, MEMBER, target(OWNER), { actorType: 'agent' });
      await message(OPEN_THREAD, MEMBER, target(OWNER), { metadata: { mergedFrom: { breakoutId: BREAKOUT } } });
    }
    expect(await workspace().peopleRanking({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId })).toEqual({
      ok: true, ranking: { channel: [MEMBER, GUEST], organization: [GUEST, MEMBER] },
    });
    expect(await workspace().peopleRanking({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: null })).toEqual({
      ok: true, ranking: { channel: [], organization: [GUEST, MEMBER] },
    });
  });

  it("given inaccessible conversations, when ranking people, then their messages do not contribute and guests cannot read the ranking", async () => {
    const spaceId = await channelWithThreads();
    await message(PRIVATE_THREAD, OWNER, [{ userId: MEMBER, relation: 'mentioned' }]);
    await publish(OPEN_THREAD, [breakoutEffect('Private breakout'), viewerEffect(OWNER)], BREAKOUT);
    await message(OPEN_THREAD, OWNER, [{ userId: MEMBER, relation: 'mentioned' }], { substreamId: BREAKOUT });
    expect(await workspace().peopleRanking({ workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId })).toEqual({
      ok: true, ranking: { channel: [], organization: [] },
    });
    expect(await workspace().peopleRanking({ workspaceId: WORKSPACE_ID, userId: GUEST, spaceId: null })).toEqual({
      ok: false, code: 'space_access_denied',
    });
  });

  it("given a shared breakout, when ranking its replies and mentions, then both directions count and recency breaks frequency ties", async () => {
    const spaceId = await channelWithThreads();
    await publish(OPEN_THREAD, [breakoutEffect('Shared breakout'), viewerEffect(OWNER), viewerEffect(MEMBER)], BREAKOUT);
    await message(OPEN_THREAD, MEMBER, [], { substreamId: BREAKOUT });
    await message(OPEN_THREAD, OWNER, [{ userId: MEMBER, relation: 'mentioned' }], { substreamId: BREAKOUT });
    await message(OPEN_THREAD, GUEST, [{ userId: OWNER, relation: 'mentioned' }], { occurredAt: '2026-10-21T12:00:00.000Z' });
    await message(OPEN_THREAD, OWNER, [{ userId: GUEST, relation: 'mentioned' }], { occurredAt: '2026-10-21T12:01:00.000Z' });
    expect(await workspace().peopleRanking({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId })).toEqual({
      ok: true, ranking: { channel: [GUEST, MEMBER], organization: [GUEST, MEMBER] },
    });
    // Losing the breakout grant removes that evidence immediately.
    await publish(OPEN_THREAD, [viewerEffect(OWNER, { isParticipant: false, listable: false })], BREAKOUT, 2);
    expect(await workspace().peopleRanking({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId })).toEqual({
      ok: true, ranking: { channel: [GUEST], organization: [GUEST] },
    });
  });
});

describe("Channel feed for a guest", () => {
  it("given a guest added to one thread in a Channel, when they read its feed, then they see that thread alone", async () => {
    const channelId = await channelWithThreads();
    await publish(OPEN_THREAD, [viewerEffect(GUEST)]);

    const page = await feed(channelId, GUEST);

    expect(page.items.map((item) => item.thread.id)).toEqual([OPEN_THREAD]);
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
    .map((item) => item.thread.id);

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
      item.thread.id, item.attentionSequenceNumber,
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
      item.thread.id, item.attentionSequenceNumber,
    ]);
    expect(ordinals).toEqual(expect.arrayContaining([[OPEN_THREAD, 3], [PRIVATE_THREAD, 2]]));
    // The first unread row is the one this member sees: the re-placed thread at 3,
    // not its removed placement at 1 or the private thread at 2.
    expect(readState(await stats(MEMBER, channelId))).toEqual({ latest: 3, readThrough: 0, firstUnread: 3, hasUnread: true });
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

  it("given threads placed since a person last read a Channel, when they read the stats, then the new-thread count matches the feed's rows above their position", async () => {
    const channelId = await channelWithThreads();
    await publish(OPEN_THREAD, [viewerEffect(GUEST)]);

    // The member may open one of the two, and the feed shows only that one.
    expect(await stats(MEMBER, channelId)).toMatchObject({ threadCount: 1, newThreadCount: 1 });
    expect((await stats(OWNER, channelId)).newThreadCount).toBe(0);
    expect((await stats(GUEST, channelId)).newThreadCount).toBe(0);

    await workspace().acknowledgeSpaceRead({ workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId: channelId, readThroughSequenceNumber: 2 });
    expect((await stats(MEMBER, channelId)).newThreadCount).toBe(0);

    await openThreadObject(LATE_THREAD);
    await publish(LATE_THREAD, [threadEffect("Late addition"), viewerEffect(OWNER)]);
    await place(channelId, LATE_THREAD);
    expect((await stats(MEMBER, channelId)).newThreadCount).toBe(1);
  });

  it("given a private thread placed since a member last read a Channel, when they read the stats, then the Channel is not unread for them", async () => {
    const channelId = await channelWithThreads();
    await workspace().acknowledgeSpaceRead({ workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId: channelId, readThroughSequenceNumber: 2 });

    await openThreadObject(LATE_THREAD);
    await publish(LATE_THREAD, [threadEffect("Late addition", { scope: "personal" }), viewerEffect(OWNER)]);
    await place(channelId, LATE_THREAD);

    expect(await stats(MEMBER, channelId)).toMatchObject({
      latestAttentionSequenceNumber: 3, newThreadCount: 0, hasUnread: false, firstUnreadSequenceNumber: null,
    });
    // An open thread placed after it is the first unread row, not the hidden one.
    await openThreadObject(MEMBER_THREAD);
    await publish(MEMBER_THREAD, [threadEffect("Open follow-up"), viewerEffect(OWNER)]);
    await place(channelId, MEMBER_THREAD);
    expect(await stats(MEMBER, channelId)).toMatchObject({ newThreadCount: 1, hasUnread: true, firstUnreadSequenceNumber: 4 });
    // Added to the private one, the same member is told about it too.
    await publish(LATE_THREAD, [viewerEffect(MEMBER)]);
    expect(await stats(MEMBER, channelId)).toMatchObject({ newThreadCount: 2, hasUnread: true, firstUnreadSequenceNumber: 3 });
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

/** A resource row in the Organization's store, as a published file leaves one. */
async function storeResource(id: string, title: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, title, mime_type, metadata_json, created_at, updated_at)
       VALUES (?, ?, 'generated_file', 'avalon', ?, 'text/markdown', ?, '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`,
      id, WORKSPACE_ID, title, JSON.stringify(metadata),
    );
  });
}

const ARTIFACT = "00000000-0000-7000-8000-00000000e1a1";
const OTHER_ARTIFACT = "00000000-0000-7000-8000-00000000e1a2";
const UPLOAD = "00000000-0000-7000-8000-00000000e1a3";

describe("artifact pins", () => {
  /** The open thread's Main holds two artifacts it generated and a file somebody attached. */
  async function threadWithArtifacts(): Promise<void> {
    await channelWithThreads();
    await storeResource(ARTIFACT, "Incident summary");
    await storeResource(OTHER_ARTIFACT, "Payloads");
    await storeResource(UPLOAD, "Brief");
    await publish(OPEN_THREAD, [{
      ...threadEffect("Cold outreach"),
      resourceLinks: [
        { resourceId: ARTIFACT, watchEnabled: false, relationshipType: "generated" },
        { resourceId: OTHER_ARTIFACT, watchEnabled: false, relationshipType: "generated" },
        { resourceId: UPLOAD, watchEnabled: false, relationshipType: "attachment" },
      ],
    } as ParentEffect], undefined, 2);
  }

  const pinArtifact = (itemId: string, threadId: WorkstreamId, userId: UserId = MEMBER) => workspace().changeArtifactPin({
    workspaceId: WORKSPACE_ID, userId, itemId, threadId, pinned: true,
  });

  it("given an artifact generated in a Main the member may open, when they pin it, then it lists with its thread and stays out of the other pins", async () => {
    await threadWithArtifacts();

    const pinned = await pinArtifact(ARTIFACT, OPEN_THREAD);

    expect(pinned).toEqual({ ok: true, artifactPins: [{
      id: ARTIFACT,
      threadId: OPEN_THREAD,
      title: "Incident summary",
      resourceType: "generated_file",
      mimeType: "text/markdown",
      updatedAt: "2026-10-03T00:00:00.000Z",
      currentVersion: 1,
      unread: false,
      thread: { title: "Cold outreach", appearance: null, spaceIds: [expect.any(String)] },
    }] });
    // The thread, Channel and breakout list a shipped desktop parses never carries one.
    await expect(workspace().listPins({ workspaceId: WORKSPACE_ID, userId: MEMBER })).resolves.toEqual({ ok: true, pins: [] });
  });

  it("given a file that was attached rather than generated, or named under another thread, when the member pins it, then it is refused and nothing is stored", async () => {
    await threadWithArtifacts();

    await expect(pinArtifact(UPLOAD, OPEN_THREAD)).resolves.toEqual({ ok: false, code: "pin_target_not_found" });
    await expect(pinArtifact(ARTIFACT, PRIVATE_THREAD, OWNER)).resolves.toEqual({ ok: false, code: "pin_target_not_found" });
    await expect(workspace().listArtifactPins({ workspaceId: WORKSPACE_ID, userId: MEMBER }))
      .resolves.toEqual({ ok: true, artifactPins: [] });
  });

  it("given an artifact in a private thread, when a member who cannot open it pins it, then it is refused", async () => {
    await channelWithThreads();
    await storeResource(ARTIFACT, "Comp table");
    await publish(PRIVATE_THREAD, [{
      ...threadEffect("Comp bands", { scope: "personal" }),
      resourceLinks: [{ resourceId: ARTIFACT, watchEnabled: false, relationshipType: "generated" }],
    } as ParentEffect], undefined, 2);

    await expect(pinArtifact(ARTIFACT, PRIVATE_THREAD)).resolves.toEqual({ ok: false, code: "pin_target_not_found" });
    await expect(pinArtifact(ARTIFACT, PRIVATE_THREAD, OWNER)).resolves.toMatchObject({ ok: true, artifactPins: [{ id: ARTIFACT }] });
  });

  it("given a pinned artifact whose thread is made private, when the member reads their artifact pins, then it is left out until they unpin it", async () => {
    await threadWithArtifacts();
    await pinArtifact(ARTIFACT, OPEN_THREAD);

    await publish(OPEN_THREAD, [{
      ...threadEffect("Cold outreach", { scope: "personal" }),
      resourceLinks: [{ resourceId: ARTIFACT, watchEnabled: false, relationshipType: "generated" }],
    } as ParentEffect], undefined, 3);

    await expect(workspace().listArtifactPins({ workspaceId: WORKSPACE_ID, userId: MEMBER }))
      .resolves.toEqual({ ok: true, artifactPins: [] });
    // An unpin is never refused, so a pin the member can no longer see can still be tidied.
    await workspace().changeArtifactPin({ workspaceId: WORKSPACE_ID, userId: MEMBER, itemId: ARTIFACT, threadId: null, pinned: false });
    const stored = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      `SELECT COUNT(*) AS count FROM workspace_pins WHERE user_id = ? AND item_kind = 'artifact'`, MEMBER,
    ).one().count);
    expect(stored).toBe(0);
  });

  /** A new version of a stored artifact, staged the way a producer stages one. */
  async function republish(
    id: string,
    author: { kind: "agent"; onBehalfOf?: UserId } | { kind: "member"; userId: UserId } | { kind: "connector" },
    cause: "published" | "refetched" = "published",
  ): Promise<void> {
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE resources
            SET revision_author_kind = ?, revision_author_run_id = ?, revision_author_user_id = ?,
                revision_author_connection_id = ?, revision_cause = ?, revision_on_behalf_of_user_id = ?,
                content_sha256 = lower(hex(randomblob(8))), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 second')
          WHERE id = ?`,
        author.kind,
        author.kind === "agent" ? "00000000-0000-7000-8000-00000000e1f1" : null,
        author.kind === "member" ? author.userId : null,
        author.kind === "connector" ? "00000000-0000-7000-8000-00000000e1f2" : null,
        cause,
        author.kind === "agent" ? author.onBehalfOf ?? null : null,
        id,
      );
    });
  }

  async function artifactRows(userId: UserId) {
    return (await activity(userId)).items.filter((item) => item.kind === "artifact_updated");
  }

  async function artifactPinState(userId: UserId) {
    const result = await workspace().listArtifactPins({ workspaceId: WORKSPACE_ID, userId });
    if (!result.ok) throw new Error(`listArtifactPins refused: ${result.code}`);
    return result.artifactPins.map((pin) => [pin.id, pin.currentVersion, pin.unread]);
  }

  it("given a pinned artifact Rally republishes, when the member reads Activity and their pins, then both say it was updated until they see that version", async () => {
    await threadWithArtifacts();
    await pinArtifact(ARTIFACT, OPEN_THREAD);
    expect(await artifactPinState(MEMBER)).toEqual([[ARTIFACT, 1, false]]);

    await republish(ARTIFACT, { kind: "agent" });

    const [row] = await artifactRows(MEMBER);
    expect(row).toMatchObject({
      id: `artifact:${ARTIFACT}:2`, actorUserId: null, actorLabel: "Rally", threadId: OPEN_THREAD,
      threadTitle: "Cold outreach", artifact: { resourceId: ARTIFACT, title: "Incident summary", version: 2 }, unread: true,
    });
    expect(await artifactPinState(MEMBER)).toEqual([[ARTIFACT, 2, true]]);
    // Nobody else pinned it, so nobody else is told.
    expect(await artifactRows(OWNER)).toEqual([]);

    await workspace().recordActivityEvents({
      workspaceId: WORKSPACE_ID, userId: MEMBER,
      events: [{ kind: "read", subject: { kind: "artifact", resourceId: ARTIFACT }, through: 2 }],
    });

    expect((await artifactRows(MEMBER)).map((item) => item.unread)).toEqual([false]);
    expect(await artifactPinState(MEMBER)).toEqual([[ARTIFACT, 2, false]]);
  });

  it("given an update to a pinned artifact, when the member marks all Activity read, then the pin is read too", async () => {
    await threadWithArtifacts();
    await pinArtifact(ARTIFACT, OPEN_THREAD);
    await republish(ARTIFACT, { kind: "agent" });
    const [row] = await artifactRows(MEMBER);
    expect(await artifactPinState(MEMBER)).toEqual([[ARTIFACT, 2, true]]);

    await workspace().markActivitySeen({ workspaceId: WORKSPACE_ID, userId: MEMBER, seenThrough: Date.parse(row!.occurredAt) });

    expect((await artifactRows(MEMBER)).map((item) => item.unread)).toEqual([false]);
    expect(await artifactPinState(MEMBER)).toEqual([[ARTIFACT, 2, false]]);
  });

  it("given the member's own edit or a connector refetch, when they read Activity, then neither is news to them", async () => {
    await threadWithArtifacts();
    await pinArtifact(ARTIFACT, OPEN_THREAD);

    await republish(ARTIFACT, { kind: "member", userId: MEMBER });
    await republish(ARTIFACT, { kind: "connector" }, "refetched");

    expect(await artifactRows(MEMBER)).toEqual([]);
    expect(await artifactPinState(MEMBER)).toEqual([[ARTIFACT, 3, false]]);
  });

  it("given Rally revising a pinned artifact for one pinner, then it is news to another pinner and not to them, pushes included", async () => {
    await threadWithArtifacts();
    await pinArtifact(ARTIFACT, OPEN_THREAD);
    await pinArtifact(ARTIFACT, OPEN_THREAD, OWNER);

    await republish(ARTIFACT, { kind: "agent", onBehalfOf: MEMBER });

    expect(await artifactRows(MEMBER)).toEqual([]);
    expect(await artifactPinState(MEMBER)).toEqual([[ARTIFACT, 2, false]]);
    expect((await artifactRows(OWNER)).map((item) => item.id)).toEqual([`artifact:${ARTIFACT}:2`]);
    expect(await artifactPinState(OWNER)).toEqual([[ARTIFACT, 2, true]]);
    const pending = await runInDurableObject(workspace(), (_instance, state) => {
      const pushes = new WorkspaceActivityPushes(state.storage, new WorkspaceActivityFeed(state.storage, new WorkspaceSpaceStorage(state.storage)));
      const subject = (userId: UserId) => [{
        kind: "artifact" as const, threadId: OPEN_THREAD, substreamId: null, userId, itemId: `artifact:${ARTIFACT}:2`,
      }];
      return {
        member: pushes.pending({ userId: MEMBER, accessClass: "member" }, subject(MEMBER), new Set()).map((item) => item.id),
        owner: pushes.pending({ userId: OWNER, accessClass: "member" }, subject(OWNER), new Set()).map((item) => item.id),
      };
    });
    expect(pending).toEqual({ member: [], owner: [`artifact:${ARTIFACT}:2`] });
  });

  it("given a pinned artifact whose thread the member can no longer open, when Rally republishes it, then no row names it", async () => {
    await threadWithArtifacts();
    await pinArtifact(ARTIFACT, OPEN_THREAD);
    await publish(OPEN_THREAD, [{
      ...threadEffect("Cold outreach", { scope: "personal" }),
      resourceLinks: [{ resourceId: ARTIFACT, watchEnabled: false, relationshipType: "generated" }],
    } as ParentEffect], undefined, 3);

    await republish(ARTIFACT, { kind: "agent" });

    expect(await artifactRows(MEMBER)).toEqual([]);
  });

  it("given a republish of a pinned artifact, when the pushes are decided, then its pinner is sent that row and nobody else", async () => {
    await threadWithArtifacts();
    await pinArtifact(ARTIFACT, OPEN_THREAD);
    await republish(ARTIFACT, { kind: "agent" });

    const decided = await runInDurableObject(workspace(), (_instance, state) => {
      // The ledger the trigger filled names the version; the drain empties it.
      const updates = drainResourceVersionChanges(state.storage.sql);
      const subjects = updates.map((update) => ({
        kind: "artifact" as const, threadId: OPEN_THREAD, substreamId: null, userId: MEMBER,
        itemId: `artifact:${update.resourceId}:${update.version}`,
      }));
      const pushes = new WorkspaceActivityPushes(state.storage, new WorkspaceActivityFeed(state.storage, new WorkspaceSpaceStorage(state.storage)));
      return {
        updates,
        audience: pushes.audience(subjects),
        member: pushes.pending({ userId: MEMBER, accessClass: "member" }, subjects, new Set()).map((item) => item.id),
        owner: pushes.pending({ userId: OWNER, accessClass: "member" }, subjects, new Set()).map((item) => item.id),
        again: drainResourceVersionChanges(state.storage.sql),
      };
    });

    expect(decided).toEqual({
      updates: [{ resourceId: ARTIFACT, version: 2, cause: "published" }],
      audience: { everyone: false, userIds: [MEMBER] },
      member: [`artifact:${ARTIFACT}:2`],
      owner: [],
      again: [],
    });
  });

  it("given an unpin, then the member's sockets alone are told to read Activity again, since its rows went with the pin", async () => {
    await threadWithArtifacts();
    await pinArtifact(ARTIFACT, OPEN_THREAD);
    await republish(ARTIFACT, { kind: "agent" });
    expect((await artifactRows(MEMBER)).map((item) => item.id)).toEqual([`artifact:${ARTIFACT}:2`]);
    // Start with an existing notification with the same topic and audience.
    // The unpin must publish a new event even when its payload is unchanged.
    await workspace().markActivitySeen({ workspaceId: WORKSPACE_ID, userId: MEMBER, seenThrough: 0 });
    const latest = () => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
      waterline: number; topics_json: string; audience_json: string | null;
    }>("SELECT waterline, topics_json, audience_json FROM workspace_sync_events ORDER BY waterline DESC LIMIT 1").one());
    const before = await latest();

    await workspace().changeArtifactPin({ workspaceId: WORKSPACE_ID, userId: MEMBER, itemId: ARTIFACT, threadId: null, pinned: false });

    expect(await artifactRows(MEMBER)).toEqual([]);
    const after = await latest();
    expect(after.waterline).toBeGreaterThan(before.waterline);
    expect(after).toMatchObject({ topics_json: JSON.stringify(["activity"]), audience_json: JSON.stringify([MEMBER]) });
  });

  it("given two pinned artifacts, when the member moves the second up, then they list in the new order", async () => {
    await threadWithArtifacts();
    await pinArtifact(ARTIFACT, OPEN_THREAD);
    await pinArtifact(OTHER_ARTIFACT, OPEN_THREAD);

    const moved = await workspace().reorderArtifactPins({ workspaceId: WORKSPACE_ID, userId: MEMBER, ids: [OTHER_ARTIFACT, ARTIFACT] });

    expect(moved.ok && moved.artifactPins.map((pin) => pin.id)).toEqual([OTHER_ARTIFACT, ARTIFACT]);
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
    // Dated now: the alarm's `activity_reap` deletes an event past its 90-day
    // retention, and any write that arms the alarm would otherwise take it.
    const now = Date.now();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO workspace_activity_events (
          event_id, event_type, subject_type, subject_id, subject_sequence_number, actor_type, actor_user_id,
          actor_label, title, body, canonical_url, audience_kind, audience_user_id, audience_workstream_id,
          digestible, occurred_at, created_at, source_kind, source_id, dedupe_key, metadata_json
        ) VALUES ('mention-event', 'workstream_message_created', 'workstream', ?, 3, 'user', ?, 'Owner', 'Side work', '',
          NULL, 'user', ?, NULL, 0, ?, ?, 'workstream_message', 'breakout-turn',
          'message:breakout-turn', ?)`, OPEN_THREAD, OWNER, OWNER, now, now, JSON.stringify({ substreamId: BREAKOUT }));
      state.storage.sql.exec(`INSERT INTO workspace_activity_event_targets (event_id, user_id, relation, created_at)
        VALUES ('mention-event', ?, 'mentioned', ?)`, MEMBER, now);
    });
    const mentions = async () => (await activity(MEMBER)).items.filter((item) => item.kind === "mentioned");

    // Private to the owner: the member is named but may not list it.
    expect(await mentions()).toEqual([]);

    await publish(OPEN_THREAD, [viewerEffect(MEMBER)], BREAKOUT);
    expect(await mentions()).toEqual([expect.objectContaining({
      kind: "mentioned", threadId: OPEN_THREAD, breakout: expect.objectContaining({ substreamId: BREAKOUT }),
    })]);
  });

  it("given a mention, an add and a start, when the member reads Activity filtered to mentions, then only the mention comes back", async () => {
    await channelWithThreads();
    await publish(OPEN_THREAD, [viewerEffect(MEMBER)]);
    await runInDurableObject(workspace(), (_instance, state) => {
      for (const [eventId, relation, at] of [["mention-event", "mentioned", 1759708800000], ["added-event", "added", 1759708900000]] as const) {
        state.storage.sql.exec(`INSERT INTO workspace_activity_events (
            event_id, event_type, subject_type, subject_id, subject_sequence_number, actor_type, actor_user_id,
            actor_label, title, body, canonical_url, audience_kind, audience_user_id, audience_workstream_id,
            digestible, occurred_at, created_at, source_kind, source_id, dedupe_key, metadata_json
          ) VALUES (?, ?, 'workstream', ?, 3, 'user', ?, 'Owner', 'Open', '',
            NULL, 'workspace', NULL, NULL, 0, ?, ?, 'workstream_message', ?, ?, '{}')`,
        eventId, relation === "added" ? "workstream_participant_added" : "workstream_message_created",
        OPEN_THREAD, OWNER, at, at, eventId, `message:${eventId}`);
        state.storage.sql.exec(`INSERT INTO workspace_activity_event_targets (event_id, user_id, relation, created_at)
          VALUES (?, ?, ?, ?)`, eventId, MEMBER, relation, at);
      }
    });

    expect((await activity(MEMBER)).items.map((item) => item.kind).sort()).toEqual(["added", "mentioned", "new_message", "thread_started"]);
    const mentions = await activity(MEMBER, "mentions");
    expect(mentions.items.map((item) => [item.kind, item.id])).toEqual([["mentioned", "mention-event"]]);
    expect(mentions.nextCursor).toBeNull();
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

  it("given a person marks Activity read, then their sockets alone are told to read Activity again", async () => {
    await workspace().markActivitySeen({
      workspaceId: WORKSPACE_ID, userId: MEMBER, seenThrough: Date.parse("2026-10-06T00:00:00.000Z"),
    });

    await runInDurableObject(workspace(), (_instance, state) => {
      // The replayed log is what a socket that reconnects reads, and what the
      // live send is cut from: the topic, and an audience of the reader.
      expect(state.storage.sql.exec<{ topics_json: string; audience_json: string | null }>(
        "SELECT topics_json, audience_json FROM workspace_sync_events ORDER BY waterline DESC LIMIT 1",
      ).toArray()).toEqual([{ topics_json: JSON.stringify(["activity"]), audience_json: JSON.stringify([MEMBER]) }]);
    });
  });
});

describe("Activity settled by the app's events", () => {
  /** One event naming the member, dated now so the retention reap leaves it. */
  async function nameMember(eventId: string, relation: "added" | "mentioned", metadata: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO workspace_activity_events (
          event_id, event_type, subject_type, subject_id, subject_sequence_number, actor_type, actor_user_id,
          actor_label, title, body, canonical_url, audience_kind, audience_user_id, audience_workstream_id,
          digestible, occurred_at, created_at, source_kind, source_id, dedupe_key, metadata_json
        ) VALUES (?, ?, 'workstream', ?, 3, 'user', ?, 'Owner', 'Open', '',
          NULL, 'workspace', NULL, NULL, 0, ?, ?, 'workstream_message', ?, ?, ?)`,
      eventId, relation === "added" ? "workstream_participant_added" : "workstream_message_created",
      OPEN_THREAD, OWNER, now, now, eventId, `message:${eventId}`, JSON.stringify(metadata));
      state.storage.sql.exec(`INSERT INTO workspace_activity_event_targets (event_id, user_id, relation, created_at)
        VALUES (?, ?, ?, ?)`, eventId, MEMBER, relation, now);
    });
  }

  async function read(subject: ActivitySubject, through: number): Promise<void> {
    await workspace().recordActivityEvents({ workspaceId: WORKSPACE_ID, userId: MEMBER, events: [{ kind: "read", subject, through }] });
  }

  async function unread(): Promise<Record<string, boolean>> {
    return Object.fromEntries((await activity(MEMBER)).items.map((item) => [item.id, item.unread]));
  }

  it("given mentions at messages 29 and 30, when the member reads the thread through 29, then only the mention at 29 is done", async () => {
    await openThreadObject(OPEN_THREAD);
    await publish(OPEN_THREAD, [threadEffect("Cold outreach", { latestAttentionOrdinal: 30 }), viewerEffect(MEMBER)]);
    await nameMember("mention-29", "mentioned", { substreamId: "0", attentionOrdinal: 29 });
    await nameMember("mention-30", "mentioned", { substreamId: "0", attentionOrdinal: 30 });

    await read({ kind: "thread", threadId: OPEN_THREAD }, 29);
    expect(await unread()).toMatchObject({ "mention-29": false, "mention-30": true });

    // A late event short of where the member already read moves nothing back.
    await read({ kind: "thread", threadId: OPEN_THREAD }, 3);
    expect(await unread()).toMatchObject({ "mention-29": false, "mention-30": true });
  });

  it("given a mention in a breakout, when the member reads the thread through it, then the breakout's mention stays until the breakout is read", async () => {
    await channelWithThreads();
    await publish(OPEN_THREAD, [viewerEffect(MEMBER)]);
    await publish(OPEN_THREAD, [breakoutEffect("Side work"), viewerEffect(OWNER), viewerEffect(MEMBER)], BREAKOUT);
    await nameMember("breakout-mention", "mentioned", { substreamId: BREAKOUT, attentionOrdinal: 2 });

    await read({ kind: "thread", threadId: OPEN_THREAD }, 2);
    expect(await unread()).toMatchObject({ "breakout-mention": true });

    await read({ kind: "breakout", threadId: OPEN_THREAD, substreamId: BREAKOUT }, 2);
    expect(await unread()).toMatchObject({ "breakout-mention": false });
  });

  it("given the member was added to a thread, when the app reports it opened, then the add is done", async () => {
    await openThreadObject(OPEN_THREAD);
    await publish(OPEN_THREAD, [threadEffect("Cold outreach", { latestAttentionOrdinal: 2 }), viewerEffect(MEMBER)]);
    await nameMember("added-event", "added", { substreamId: "0" });
    expect(await unread()).toMatchObject({ "added-event": true });

    await read({ kind: "thread", threadId: OPEN_THREAD }, 0);
    expect(await unread()).toMatchObject({ "added-event": false });
  });

  /** Move the member's last read of a subject to before `at`, as a read made earlier would have left it. */
  async function readBefore(subjectKey: string, at: number): Promise<void> {
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE workspace_activity_reads SET updated_at = ? WHERE user_id = ? AND subject_key = ?",
        at - 1, MEMBER, subjectKey,
      );
    });
  }

  it("given the member opened a thread before being added to it, when the add arrives, then it stays unread until they open it again", async () => {
    await openThreadObject(OPEN_THREAD);
    await publish(OPEN_THREAD, [threadEffect("Cold outreach", { latestAttentionOrdinal: 2 }), viewerEffect(MEMBER)]);
    await read({ kind: "thread", threadId: OPEN_THREAD }, 2);
    await nameMember("added-event", "added", { substreamId: "0" });
    const addedAt = (await activity(MEMBER)).items.find((item) => item.id === "added-event")!.occurredAt;
    await readBefore(`thread:${OPEN_THREAD}`, Date.parse(addedAt));
    expect(await unread()).toMatchObject({ "added-event": true });

    await read({ kind: "thread", threadId: OPEN_THREAD }, 0);
    expect(await unread()).toMatchObject({ "added-event": false });
  });

  it("given a finished run, when the member opens the thread after it, then the finish is done, and a later message leaves it done", async () => {
    await openThreadObject(MEMBER_THREAD);
    const completedAt = "2026-10-06T00:00:00.000Z";
    await publish(MEMBER_THREAD, [
      threadEffect("Funnel report", { state: "completed", completedAt, latestAttentionOrdinal: 4 }),
      viewerEffect(MEMBER),
    ]);
    const finished = async () => (await activity(MEMBER)).items.filter((item) => item.kind === "run_finished").map((item) => item.unread);

    // Read all of it, but before the run finished.
    await read({ kind: "thread", threadId: MEMBER_THREAD }, 4);
    await readBefore(`thread:${MEMBER_THREAD}`, Date.parse(completedAt));
    expect(await finished()).toEqual([true]);

    await read({ kind: "thread", threadId: MEMBER_THREAD }, 0);
    expect(await finished()).toEqual([false]);

    await publish(MEMBER_THREAD, [
      threadEffect("Funnel report", { state: "completed", completedAt, latestAttentionOrdinal: 9 }),
    ], undefined, 2);
    expect(await finished()).toEqual([false]);
  });

  it("given a read that moves a waterline, then the member's sockets alone are told to read Activity again, and a repeat tells nobody", async () => {
    const published = () => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
      topics_json: string;
      audience_json: string | null;
    }>("SELECT topics_json, audience_json FROM workspace_sync_events ORDER BY waterline DESC").toArray());

    const before = (await published()).length;
    await read({ kind: "thread", threadId: OPEN_THREAD }, 3);
    const afterFirst = await published();
    expect(afterFirst.length).toBe(before + 1);
    expect(afterFirst[0]).toEqual({ topics_json: JSON.stringify(["activity"]), audience_json: JSON.stringify([MEMBER]) });

    await read({ kind: "thread", threadId: OPEN_THREAD }, 3);
    expect((await published()).length).toBe(before + 1);
  });

  it("given a start cleared by reading its Channel, when the thread moves out of that Channel, then it stays cleared", async () => {
    const channelId = await channelWithThreads();
    const elsewhere = await reserveChannel("Elsewhere");
    await place(elsewhere, OPEN_THREAD);
    const started = async () => (await activity(MEMBER)).items
      .filter((item) => item.kind === "thread_started" && item.threadId === OPEN_THREAD).map((item) => item.unread);
    expect(await started()).toEqual([true]);

    await read({ kind: "channel", channelId }, 1);
    expect(await started()).toEqual([false]);

    await removeMembership(workspace(), { workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: channelId, workstreamId: OPEN_THREAD });
    expect(await started()).toEqual([false]);
  });
});

describe("Channel merges", () => {
  async function stats(userId: UserId, channelId: SpaceId) {
    const result = await workspace().listChannelStats({ workspaceId: WORKSPACE_ID, userId });
    if (!result.ok) throw new Error(`listChannelStats refused: ${result.code}`);
    const row = result.stats.find((entry) => entry.channelId === channelId);
    if (!row) throw new Error("Channel not listed");
    return { latest: row.latestAttentionSequenceNumber, readThrough: row.readThroughSequenceNumber,
      firstUnread: row.firstUnreadSequenceNumber, hasUnread: row.hasUnread, newThreads: row.newThreadCount };
  }

  const auth = (userId: UserId) => ({
    sessionId: `merge-${userId}`, userId, workspaceId: WORKSPACE_ID, region: "global" as const,
    role: userId === OWNER ? "owner" as const : "member" as const,
  });

  async function merge(channelId: SpaceId | null, operationId: string, body = "Shipped the sequence.") {
    await storeResource(ARTIFACT, "Price model").catch(() => undefined);
    return workspace().mergeThreadIntoChannel({
      auth: auth(OWNER), workstreamId: OPEN_THREAD, spaceId: channelId, body, operationId,
      embeds: [{ id: ARTIFACT, title: "Price model", kind: "generated_file" }],
    });
  }

  /** Where the canonical resource check finds this reader may read the artifact through a Channel. */
  async function sharedThrough(userId: UserId, resourceId = ARTIFACT) {
    const [facts] = await workspace().authorizationResourceFacts({ workspaceId: WORKSPACE_ID, userId, resourceIds: [resourceId], accessClass: "member" });
    return facts && facts.exists ? facts.sharedThrough : "absent";
  }

  async function messages(channelId: SpaceId, userId: UserId) {
    const result = await workspace().listChannelFeed({ workspaceId: WORKSPACE_ID, userId, spaceId: channelId, cursor: null });
    if (!result.ok) throw new Error(`listChannelFeed refused: ${result.code}`);
    return result.page.items.flatMap((item) => (item.kind === "message" ? [item] : []));
  }

  it("given a thread placed in two Channels, when its merge Channels are read, then the earliest placement comes first, whatever the ids", async () => {
    // Reserved first, so its id sorts first; placed second.
    const board = await reserveChannel("Board");
    const outbound = await channelWithThreads();
    await place(board, OPEN_THREAD);

    const target = await workspace().channelMergeTarget({ auth: auth(OWNER), workstreamId: OPEN_THREAD, spaceId: null });
    expect(target).toMatchObject({ ok: true, spaceId: outbound, name: "Outbound" });
    expect(target.channels).toEqual([{ id: outbound, name: "Outbound" }, { id: board, name: "Board" }]);
  });

  it("given a thread whose earliest placement is a private Channel, when its placement is read with nobody asking, then the Organization-wide Channel is named and the private one is not", async () => {
    const outbound = await channelWithThreads();
    const made = await workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: outbound, audience: { scope: "personal", participantUserIds: [OWNER] },
    });
    expect(made).toMatchObject({ ok: true, space: { scope: "personal" } });
    // Nothing Organization-wide holds the thread yet: no placement, rather than the private name.
    expect(await workspace().threadMergePlacement({ workspaceId: WORKSPACE_ID, workstreamId: OPEN_THREAD }))
      .toEqual({ ok: false, code: "merge_channel_not_placed" });
    const board = await reserveChannel("Board");
    await place(board, OPEN_THREAD);
    expect(await workspace().threadMergePlacement({ workspaceId: WORKSPACE_ID, workstreamId: OPEN_THREAD }))
      .toEqual({ ok: true, spaceId: board, title: "Board" });
  });

  it("given a member read through the placements, when the owner merges a thread, then it is the newest item, names its thread, and is news to the member alone", async () => {
    const channelId = await channelWithThreads();
    await workspace().acknowledgeSpaceRead({ workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId: channelId, readThroughSequenceNumber: 2 });

    expect(await merge(null, "op-1")).toMatchObject({ ok: true, spaceId: channelId, name: "Outbound", replayed: false });

    const feedItems = (await workspace().listChannelFeed({ workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId: channelId, cursor: null }));
    if (!feedItems.ok) throw new Error("feed refused");
    expect(feedItems.page.items.find((item) => item.kind === "thread" && item.thread.id === OPEN_THREAD))
      .toMatchObject({ kind: "thread", thread: { resolved: true, archivedAt: null } });
    expect(feedItems.page.items[0]).toMatchObject({
      kind: "message",
      attentionSequenceNumber: 3,
      message: {
        author: { kind: "member", userId: OWNER },
        body: "Shipped the sequence.",
        merge: { threadId: OPEN_THREAD, title: "Cold outreach", summary: "Cold outreach summary",
          embeds: [{ id: ARTIFACT, title: "Price model", kind: "generated_file" }] },
      },
    });
    expect(await stats(MEMBER, channelId)).toEqual({ latest: 3, readThrough: 2, firstUnread: 3, hasUnread: true, newThreads: 0 });
    expect(await stats(OWNER, channelId)).toMatchObject({ latest: 3, readThrough: 3, hasUnread: false });
  });

  it("given a merge, when the same operation retries, then nothing moves, and when the thread merges again, then the one merge is replaced at the bottom", async () => {
    const channelId = await channelWithThreads();
    const first = await merge(channelId, "op-1");
    if (!first.ok) throw new Error("merge refused");

    // A retry shares nothing new: the first attempt already linked the embed.
    expect(await merge(channelId, "op-1", "A retry's words")).toEqual({ ...first, replayed: true, linked: [] });
    // Nor does a retry that names an embed the merge never had: it wrote nothing.
    await storeResource(OTHER_ARTIFACT, "Comp model");
    expect(await workspace().mergeThreadIntoChannel({
      auth: auth(OWNER), workstreamId: OPEN_THREAD, spaceId: channelId, body: "Shipped the sequence.", operationId: "op-1",
      embeds: [{ id: OTHER_ARTIFACT, title: "Comp model", kind: "generated_file" }],
    })).toMatchObject({ ok: true, replayed: true, linked: [] });
    expect(await sharedThrough(OWNER, OTHER_ARTIFACT)).toBeNull();
    expect((await messages(channelId, OWNER)).map((item) => [item.message.body, item.attentionSequenceNumber]))
      .toEqual([["Shipped the sequence.", 3]]);

    const again = await merge(channelId, "op-2", "Shipped, with the follow-ups.");
    expect(again).toMatchObject({ ok: true, messageId: first.messageId, replayed: false });
    expect((await messages(channelId, OWNER)).map((item) => [item.message.body, item.attentionSequenceNumber]))
      .toEqual([["Shipped, with the follow-ups.", 4]]);
    // A late retry of the first operation, after the second replaced it, is
    // still a replay: it does not overwrite the newer merge or take an ordinal.
    expect(await merge(channelId, "op-1", "Shipped the sequence.")).toMatchObject({ ok: true, replayed: true });
    expect((await messages(channelId, OWNER)).map((item) => [item.message.body, item.attentionSequenceNumber]))
      .toEqual([["Shipped, with the follow-ups.", 4]]);
  });

  describe("read by a thread's agent as a conversation", () => {
    const threadScope = (workstreamId: WorkstreamId) => ({ kind: "conversation" as const, parentId: workstreamId,
      substreamId: asSubstreamId("0") });
    const channelsOf = async (userId: UserId, workstreamId: WorkstreamId) =>
      (await workspace().conversationToolScope({ workspaceId: WORKSPACE_ID, userId, scope: threadScope(workstreamId) }))
        .conversations.filter((entry) => entry.kind === "space");

    it("given a thread in a Channel, when its agent lists conversations, then the Channel is a parent it can resolve by id or name", async () => {
      const channelId = await channelWithThreads();
      const entry = { conversationId: channelId, parentId: channelId, substreamId: "0", kind: "space", title: "Outbound",
        isHome: false, isOwn: false, isParent: true };
      expect(await channelsOf(MEMBER, OPEN_THREAD)).toEqual([entry]);
      for (const reference of [channelId, "outbound"]) {
        expect(await workspace().resolveConversationToolTarget({ workspaceId: WORKSPACE_ID, userId: MEMBER,
          scope: threadScope(OPEN_THREAD), reference })).toEqual({ ok: true, conversation: entry, sidekickName: null });
      }
    });

    it("given a breakout of a thread in a Channel, when its agent lists conversations, then its thread's Channel is a parent too", async () => {
      const channelId = await channelWithThreads();
      const scope = { kind: "conversation" as const, parentId: OPEN_THREAD, substreamId: BREAKOUT };
      const listed = await workspace().conversationToolScope({ workspaceId: WORKSPACE_ID, userId: MEMBER, scope });
      expect(listed.conversations.filter((entry) => entry.kind === "space"))
        .toEqual([{ conversationId: channelId, parentId: channelId, substreamId: "0", kind: "space", title: "Outbound",
          isHome: false, isOwn: false, isParent: true }]);
      expect(await workspace().resolveConversationToolTarget({ workspaceId: WORKSPACE_ID, userId: MEMBER, scope,
        reference: "Outbound" })).toMatchObject({ ok: true, conversation: { conversationId: channelId } });
    });

    it("given a thread in a private Channel, when a member outside it lists or names it, then it is not theirs to reach", async () => {
      const channelId = await channelWithThreads();
      await workspace().noteSpaceAudience({
        workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: channelId, audience: { scope: "personal", participantUserIds: [OWNER] },
      });
      expect(await channelsOf(MEMBER, OPEN_THREAD)).toEqual([]);
      expect(await channelsOf(OWNER, OPEN_THREAD)).toHaveLength(1);
      expect(await workspace().resolveConversationToolTarget({ workspaceId: WORKSPACE_ID, userId: MEMBER,
        scope: threadScope(OPEN_THREAD), reference: channelId })).toMatchObject({ ok: false, code: "conversation_not_in_scope" });
    });
  });

  describe("in the search index", () => {
    const reference = (messageId: string) => ({ type: "channel_message_search_projection_v1" as const, region: "global" as const,
      workspaceId: WORKSPACE_ID, messageId });

    it("given a merge, when its document is prepared, then it is the words under the Channel's name, readable by the Channel's readers; a removal withdraws it", async () => {
      const channelId = await channelWithThreads();
      const merged = await merge(channelId, "op-icp", "Resolution: our ICP is growth teams at Series A companies.");
      if (!merged.ok) throw new Error("merge refused");
      const prepared = await workspace().prepareChannelMessageSearch(reference(merged.messageId));
      expect(prepared).toEqual({ retry: false, documents: [{
        id: expect.stringMatching(/^[a-f0-9]{64}$/u), source: "channel_messages", sourceId: merged.messageId,
        scopeId: channelId, revision: 1, text: "Resolution: our ICP is growth teams at Series A companies.",
        audience: [`space:${channelId}`],
        display: { title: "Outbound", sourceLabel: "Outbound", occurredAt: expect.any(Number), transcriptSequence: null,
          url: null, mimeType: null, archived: false },
      }] });

      expect(await workspace().removeChannelMessage({ auth: auth(OWNER), spaceId: channelId, messageId: merged.messageId }))
        .toEqual({ ok: true });
      const removed = await workspace().prepareChannelMessageSearch(reference(merged.messageId));
      expect(removed).toEqual({ retry: false, documents: [{
        id: prepared.documents[0]!.id, source: "channel_messages", sourceId: merged.messageId, scopeId: channelId,
        revision: 2, text: null,
      }] });
      expect(await workspace().channelMessageSearchRevision({ workspaceId: WORKSPACE_ID, messageId: merged.messageId }))
        .toBe(2);
    });

    it("given a reader of a Channel, when their search audience is read, then it holds the group a Channel message carries", async () => {
      const channelId = await channelWithThreads();
      const [group] = await searchAudienceGroupIds([`space:${channelId}`]);
      expect(await workspace().readSearchAudience({ workspaceId: WORKSPACE_ID, userId: MEMBER })).toContain(group);
    });
  });

  it("given a Channel that does not hold the thread, when it merges, then it is refused and nothing is posted", async () => {
    const channelId = await channelWithThreads();
    const elsewhere = await reserveChannel("Elsewhere");

    expect(await merge(elsewhere, "op-e")).toEqual({
      ok: false, code: "merge_channel_not_placed", channels: [{ id: channelId, name: "Outbound" }],
    });
    expect(await messages(channelId, OWNER)).toEqual([]);
    expect(await messages(elsewhere, OWNER)).toEqual([]);
  });

  it("given a private thread, when its participant merges it, then a member who cannot open it sees the result and its embeds as news without the thread's name or summary, and the participant sees it whole", async () => {
    const channelId = await channelWithThreads();
    await workspace().acknowledgeSpaceRead({ workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId: channelId, readThroughSequenceNumber: 2 });
    await storeResource(OTHER_ARTIFACT, "Comp model");

    expect(await workspace().mergeThreadIntoChannel({
      auth: auth(OWNER), workstreamId: PRIVATE_THREAD, spaceId: null, body: "Bands are set.", operationId: "op-p",
      embeds: [{ id: OTHER_ARTIFACT, title: "Comp model", kind: "generated_file" }],
    })).toMatchObject({ ok: true, spaceId: channelId, name: "Outbound", replayed: false, linked: [OTHER_ARTIFACT] });

    const embeds = [{ id: OTHER_ARTIFACT, title: "Comp model", kind: "generated_file" }];
    expect((await messages(channelId, MEMBER)).map((item) => item.message)).toEqual([{
      id: expect.any(String),
      author: { kind: "member", userId: OWNER },
      body: "Bands are set.",
      merge: { threadId: PRIVATE_THREAD, title: "", summary: null, embeds, private: true },
    }]);
    expect(await stats(MEMBER, channelId)).toMatchObject({ hasUnread: true, firstUnread: 3 });
    expect((await messages(channelId, OWNER))[0]?.message.merge).toEqual({
      threadId: PRIVATE_THREAD, title: "Comp bands", summary: "Comp bands summary", embeds,
    });
  });

  it("given a merge into an Organization-wide Channel, when a member who cannot open the thread asks to read its artifact, then the Channel admits them", async () => {
    const channelId = await channelWithThreads();
    await storeResource(OTHER_ARTIFACT, "Comp model");
    expect(await sharedThrough(MEMBER, OTHER_ARTIFACT)).toBeNull();
    await workspace().mergeThreadIntoChannel({
      auth: auth(OWNER), workstreamId: PRIVATE_THREAD, spaceId: null, body: "Bands are set.", operationId: "op-p",
      embeds: [{ id: OTHER_ARTIFACT, title: "Comp model", kind: "generated_file" }],
    });
    expect(await sharedThrough(MEMBER, OTHER_ARTIFACT)).toBe(channelId);
  });

  it("given a merge into a private Channel, when a member is added to the Channel later, then they can read its artifact, and when removed, they cannot", async () => {
    const channelId = await channelWithThreads();
    await workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: channelId, audience: { scope: "personal", participantUserIds: [OWNER] },
    });
    expect(await merge(channelId, "op-1")).toMatchObject({ ok: true });
    expect(await sharedThrough(OWNER)).toBe(channelId);
    expect(await sharedThrough(MEMBER)).toBeNull();

    const [channelGroup] = await searchAudienceGroupIds([searchAudienceGroup.space(channelId)]);
    expect(await workspace().readSearchAudience({ workspaceId: WORKSPACE_ID, userId: MEMBER })).not.toContain(channelGroup);

    await workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: channelId, audience: { scope: "personal", participantUserIds: [OWNER, MEMBER] },
    });
    expect(await sharedThrough(MEMBER)).toBe(channelId);
    // Search follows: the member now holds the Channel's group.
    expect(await workspace().readSearchAudience({ workspaceId: WORKSPACE_ID, userId: MEMBER })).toContain(channelGroup);

    await workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: channelId, audience: { scope: "personal", participantUserIds: [OWNER] },
    });
    expect(await sharedThrough(MEMBER)).toBeNull();
  });

  it("given a merge whose thread was made private since, when a member who cannot open it reads the Channel, then the merge stays, without its thread's name", async () => {
    const channelId = await channelWithThreads();
    await merge(channelId, "op-1");
    await publish(OPEN_THREAD, [threadEffect("Cold outreach", { scope: "personal" }), viewerEffect(OWNER)], undefined, 2);

    expect((await messages(channelId, MEMBER)).map((item) => item.message.merge))
      .toEqual([{ threadId: OPEN_THREAD, title: "", summary: null, embeds: [{ id: ARTIFACT, title: "Price model", kind: "generated_file" }], private: true }]);
    expect((await messages(channelId, OWNER))[0]?.message.merge).toMatchObject({ title: "Cold outreach" });
  });

  it("given a merge, when each person reads Activity, then the member sees a merged row naming the Channel and its author does not", async () => {
    const channelId = await channelWithThreads();
    const merged = await merge(channelId, "op-1");
    if (!merged.ok) throw new Error("merge refused");

    expect((await activity(MEMBER)).items.filter((item) => item.kind === "merged")).toEqual([expect.objectContaining({
      kind: "merged", actorUserId: OWNER, threadId: OPEN_THREAD, threadTitle: "Cold outreach", breakout: null,
      mergedInto: { channelId, name: "Outbound" }, unread: true,
    })]);
    expect((await activity(OWNER)).items.filter((item) => item.kind === "merged")).toEqual([]);
    // Reading the Channel through the merge settles the row.
    await workspace().recordActivityEvents({ workspaceId: WORKSPACE_ID, userId: MEMBER,
      events: [{ kind: "read", subject: { kind: "channel", channelId }, through: 3 }] });
    expect((await activity(MEMBER)).items.find((item) => item.kind === "merged")?.unread).toBe(false);
  });

  it("given a private thread's merge, when a member who cannot open the thread reads Activity, then the row is the Channel's and names no thread", async () => {
    const channelId = await channelWithThreads();
    await workspace().mergeThreadIntoChannel({
      auth: auth(OWNER), workstreamId: PRIVATE_THREAD, spaceId: null, body: "Bands are set.", operationId: "op-p", embeds: [],
    });
    expect((await activity(MEMBER)).items.filter((item) => item.kind === "merged")).toEqual([expect.objectContaining({
      kind: "merged", actorUserId: OWNER, threadTitle: "", breakout: null, channelIds: [channelId],
      mergedInto: { channelId, name: "Outbound", threadPrivate: true }, unread: true,
    })]);
  });

  it("given a merge, when a member who is not its author removes it, then it stays; when its author does, then it is gone", async () => {
    const channelId = await channelWithThreads();
    const merged = await merge(channelId, "op-1");
    if (!merged.ok) throw new Error("merge refused");
    const remove = (userId: UserId) => workspace().removeChannelMessage({
      auth: auth(userId), spaceId: channelId, messageId: merged.messageId,
    });

    expect(await remove(MEMBER)).toEqual({ ok: false, code: "space_access_denied" });
    expect(await messages(channelId, OWNER)).toHaveLength(1);
    expect(await remove(OWNER)).toEqual({ ok: true });
    expect(await messages(channelId, OWNER)).toEqual([]);
  });
});


describe("posting subscribes the author", () => {
  it("makes a Channel message author a participant, while Rally messages seat nobody", async () => {
    const channelId = await reserveChannel("Outbound");
    const participants = () => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ user_id: string }>(
      `SELECT user_id FROM space_viewers WHERE space_id = ? AND is_participant = 1 ORDER BY user_id`, channelId,
    ).toArray().map((row) => row.user_id));
    expect(await participants()).toEqual([OWNER]);
    await withSpaceStorage(workspace(), (storage) => storage.postMessage(channelId, { author: { kind: "rally" }, body: "News" }, Date.now()));
    expect(await participants()).toEqual([OWNER]);
    await withSpaceStorage(workspace(), (storage) => storage.postMessage(channelId,
      { author: { kind: "member", userId: MEMBER }, body: "Following up", key: "join-by-message" }, Date.now()));
    expect(await participants()).toEqual([OWNER, MEMBER]);
  });

  it("makes the author starting a thread in a Channel a participant of that Channel", async () => {
    const channelId = await reserveChannel("Outbound");
    const reserved = await workspace().reserveChannelInSpaces({
      workspaceId: WORKSPACE_ID, userId: MEMBER, workstreamId: OPEN_THREAD, spaceIds: [channelId],
      requestedScope: "workspace", requestedParticipantUserIds: [], authorityGeneration: 1,
      directory: { title: "My first post", description: "", emailAddress: null, titleStatus: "settled", createdAt: new Date().toISOString() },
    });
    expect(reserved.status).toBe("reserved");
    const participants = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ user_id: string }>(
      `SELECT user_id FROM space_viewers WHERE space_id = ? AND is_participant = 1 ORDER BY user_id`, channelId,
    ).toArray().map((row) => row.user_id));
    expect(participants).toEqual([OWNER, MEMBER]);
  });
});
