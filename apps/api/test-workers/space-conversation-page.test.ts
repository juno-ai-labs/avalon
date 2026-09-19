/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The Space dashboard's list, on real workerd.
 *
 * What this suite is about is the *page*: which conversations a Space answers
 * with for one person, in what order, and how a breakout's own projection gets
 * there. Every part of that needs the runtime. The forwarding is a Channel
 * object's outbox drained through the real activity consumer into a real
 * WorkspaceDO; the idempotency is that WorkspaceDO's receipt table; the
 * visibility, the ordering and the cursor are SQL over storage a double could
 * only describe back to itself.
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
import { beforeEach, describe, expect, it } from "vitest";

import {
  asSpaceId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  conversationNeedsViewer,
  HarnessStatusSchema,
  type HarnessStatus,
  type SpaceId,
  type UserId,
  type WorkstreamId,
} from "@rally/contracts";
import {
  ConversationEffectEnvelopeSchema,
  conversationEffectHash,
  ParentEffectEnvelopeSchema,
  type ConversationEffect,
  type ParentEffect,
} from "@rally/contracts/conversation-effects";

import { workspaceDOName, workstreamDOName } from "../src/durable-objects/names";
import { SPACE_CHANNEL_PAGE_SIZE } from "../src/durable-objects/workspace-space-storage";
import {
  consumeEffectBodies,
  deliverParentEffects,
  pendingParentEffects,
} from "./helpers/conversation-effects";

/** Its own workspace id: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000d100");
const OWNER = asUserId("00000000-0000-7000-8000-00000000d101");
const MEMBER = asUserId("00000000-0000-7000-8000-00000000d102");
const CHANNEL_A = asWorkstreamId("00000000-0000-7000-8000-00000000d103");
const CHANNEL_B = asWorkstreamId("00000000-0000-7000-8000-00000000d104");
const PRIVATE_CHANNEL = asWorkstreamId("00000000-0000-7000-8000-00000000d105");
const BREAKOUT_ONE = asSubstreamId("00000000-0000-7000-8000-00000000d106");
const BREAKOUT_TWO = asSubstreamId("00000000-0000-7000-8000-00000000d107");

const workspace = () => env.WORKSPACE_DOS.getByName(workspaceDOName("global", WORKSPACE_ID));
const channelObject = (workstreamId: WorkstreamId) =>
  env.WORKSTREAM_DOS.getByName(workstreamDOName("global", WORKSPACE_ID, workstreamId));

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
      last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id)
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
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
}

interface ChannelState {
  scope?: "personal" | "workspace";
  state?: string;
  lastActivityAt?: string;
  archivedAt?: string | null;
  latestAttentionOrdinal?: number;
}

function channelCommonEffect(title: string, overrides: ChannelState = {}): ParentEffect {
  return {
    kind: "directory_common",
    title,
    description: "",
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
    manualUnreadFromOrdinal: null,
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
  state?: string;
  lastActivityAt?: string;
  archivedAt?: string | null;
} = {}): ConversationEffect {
  return {
    kind: "directory_common",
    title,
    description: "",
    preview: "",
    scope: "personal",
    state: overrides.state ?? "needs_input",
    systemKind: null,
    lastActivityAt: overrides.lastActivityAt ?? "2026-09-19T10:00:00.000Z",
    completedAt: null,
    archivedAt: overrides.archivedAt ?? null,
  };
}

function childEnvelope(
  workstreamId: WorkstreamId,
  substreamId: string,
  effect: ConversationEffect,
  sourceVersion: number,
) {
  return ConversationEffectEnvelopeSchema.parse({
    kind: "conversation_effect",
    contractVersion: 1,
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: "workstream",
    parentId: workstreamId,
    substreamId,
    generation: 1,
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
 * Deliberately not written straight at WorkspaceDO: what is under test in the
 * first case is the *forward*, which is a decision the Channel object makes,
 * and a hand-written envelope would have proved the receiving half twice and
 * the sending half not at all.
 */
async function publishBreakout(
  workstreamId: WorkstreamId,
  substreamId: string,
  effects: readonly ConversationEffect[],
  sourceVersion = 1,
): Promise<void> {
  await channelObject(workstreamId).receiveChildEffects({
    substreamId,
    envelopes: effects.map((effect) => childEnvelope(workstreamId, substreamId, effect, sourceVersion)),
  });
  await deliverParentEffects(env, channelObject(workstreamId));
}

/** The identity row every effect path on a Channel object reads its address from. */
async function openChannelObject(workstreamId: WorkstreamId): Promise<void> {
  await runInDurableObject(channelObject(workstreamId), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO workstream_metadata
         (id, workspace_id, workstream_id, region, authority_generation, title,
          description, preview, scope, exact_state, last_activity_at,
          created_at, updated_at)
       VALUES (1, ?, ?, 'global', 1, 'Member Channel', '', '', 'workspace', 'idle', 1, 1, 1)`,
      WORKSPACE_ID,
      workstreamId,
    );
    state.storage.sql.exec(
      `INSERT INTO conversation_children
         (substream_id, kind, created_by_user_id, created_at, status, updated_at)
       VALUES ('0', 'main', ?, 1, 'ready', 1)`,
      OWNER,
    );
  });
}

async function reserve(name: string, scope: "personal" | "workspace" = "workspace"): Promise<SpaceId> {
  const result = await workspace().reserveSpace({
    workspaceId: WORKSPACE_ID,
    userId: OWNER,
    space: { name, iconKey: "briefcase", colorKey: "blue", scope },
  });
  if (!result.ok) throw new Error(`reserveSpace refused: ${result.code}`);
  return asSpaceId(result.space.id);
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

async function page(spaceId: SpaceId, userId: UserId, cursor: string | null = null) {
  const result = await workspace().listSpaceChannels({
    workspaceId: WORKSPACE_ID, userId, spaceId, cursor,
  });
  if (!result.ok) throw new Error(`listSpaceChannels refused: ${result.code}`);
  return result.page;
}

async function conversationWaterline(spaceId: SpaceId, userId: UserId): Promise<number> {
  const result = await workspace().spaceSummary({ workspaceId: WORKSPACE_ID, userId, spaceId });
  if (!result.ok) throw new Error(`spaceSummary refused: ${result.code}`);
  return result.space.conversationWaterline;
}

function inspect(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
  return workspace().runInspectionSql({ sql, bindings: [] });
}

function breakoutRows(): Promise<{ rows: Record<string, unknown>[] }> {
  return inspect(`SELECT workstream_id, substream_id, title, exact_state
                    FROM workspace_breakout_directory ORDER BY substream_id`);
}

beforeEach(async () => {
  await reset();
  effectSequence = 0;
  await establishWorkspace();
}, 30_000);

describe("space dashboard conversation page", () => {
  it("given a breakout projection, when its Channel forwards it, then it lands in the breakout tables", async () => {
    await openChannelObject(CHANNEL_A);

    await publishBreakout(CHANNEL_A, BREAKOUT_ONE, [
      breakoutCommonEffect("Pricing"),
      viewerEffect(OWNER) as ConversationEffect,
    ]);

    // The row is the Organization's, written from the Channel's forward, and
    // it is in the breakout tables rather than the Channel directory: a
    // breakout listed as a Channel is what a `substream_id` column on
    // `workspace_workstream_directory` would have produced the first time a
    // sidebar query forgot to filter it out.
    expect(await breakoutRows()).toMatchObject({
      rows: [{ workstream_id: CHANNEL_A, substream_id: BREAKOUT_ONE, title: "Pricing", exact_state: "needs_input" }],
    });
    await expect(inspect("SELECT workstream_id FROM workspace_workstream_directory"))
      .resolves.toMatchObject({ rows: [] });
    await expect(inspect("SELECT user_id, listable FROM workspace_breakout_viewers"))
      .resolves.toMatchObject({ rows: [{ user_id: OWNER, listable: 1 }] });
  });

  it("given the same projection redelivered, when the Queue delivers it again, then it is acked and changes nothing", async () => {
    const spaceId = await reserve("Hiring");
    await openChannelObject(CHANNEL_A);
    await publishChannel(CHANNEL_A, [channelCommonEffect("Roadmap"), viewerEffect(OWNER)]);
    await place(spaceId, CHANNEL_A);

    await channelObject(CHANNEL_A).receiveChildEffects({
      substreamId: BREAKOUT_ONE,
      envelopes: [childEnvelope(CHANNEL_A, BREAKOUT_ONE, breakoutCommonEffect("Pricing"), 1)],
    });
    // The bytes the Queue carries, captured before the outbox is drained, so
    // the second delivery below is the *same message* rather than a second
    // projection that happens to look like it.
    const queued = await pendingParentEffects(channelObject(CHANNEL_A));
    expect(queued).toHaveLength(1);
    expect(await consumeEffectBodies(env, queued)).toEqual({ acked: 1, retried: 0 });

    const after = await breakoutRows();
    const waterline = await conversationWaterline(spaceId, OWNER);

    // At-least-once is the Queue's whole contract, so this is the ordinary
    // case. It must be acknowledged — a message that fails here is retried
    // until it reaches the dead-letter queue — and it must not be counted
    // twice, because the count is what tells a client its page is stale.
    expect(await consumeEffectBodies(env, queued)).toEqual({ acked: 1, retried: 0 });
    expect(await breakoutRows()).toEqual(after);
    expect(await conversationWaterline(spaceId, OWNER)).toBe(waterline);
  });

  it("given a Channel this viewer cannot see, when they read the page, then its breakout is absent too", async () => {
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
    // Not "an empty page because the Space is empty": the member can read the
    // Space, and the only thing keeping both rows off their page is the
    // Channel's own audience.
    expect((await page(spaceId, MEMBER)).items).toEqual([]);
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

  it("given conversations of both kinds, when the page is read, then it is newest first and the cursor continues it", async () => {
    const spaceId = await reserve("Hiring");
    await openChannelObject(CHANNEL_A);
    await openChannelObject(CHANNEL_B);
    await publishChannel(CHANNEL_A, [
      channelCommonEffect("Channel A", { state: "needs_input", lastActivityAt: "2026-09-19T09:00:00.000Z" }),
      viewerEffect(OWNER),
    ]);
    await publishChannel(CHANNEL_B, [
      channelCommonEffect("Channel B", { state: "needs_input", lastActivityAt: "2026-09-19T12:00:00.000Z" }),
      viewerEffect(OWNER),
    ]);
    await place(spaceId, CHANNEL_A);
    await place(spaceId, CHANNEL_B);
    await publishBreakout(CHANNEL_A, BREAKOUT_ONE, [
      breakoutCommonEffect("Breakout at eleven", { lastActivityAt: "2026-09-19T11:00:00.000Z" }),
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
      breakoutOf: { workstreamId: CHANNEL_A, substreamId: BREAKOUT_ONE, title: "Channel A" },
    });
    expect(full.items[0]).toMatchObject({ kind: "channel", breakoutOf: null });

    // Four conversations fit in one page, so there is nothing to continue
    // from: `nextCursor` is null exactly when the answer is complete, which is
    // what stops a client asking for a page that does not exist.
    expect(full.nextCursor).toBeNull();
  });

  it("given more conversations than one page holds, when the cursor is followed, then the walk is complete and repeats nothing", async () => {
    const spaceId = await reserve("Hiring");
    // Seeded as rows rather than as projections. What is under test is the
    // keyset walk over `SPACE_CHANNEL_PAGE_SIZE`, and reaching that through
    // the effect pipeline would be 251 Queue round trips to set up a property
    // about SQL — these are the same rows the pipeline writes, in the same
    // real storage, written in one transaction.
    //
    // The tie at the page boundary is the point of the fixture. Four
    // conversations share one activity instant across the 250th row, so a
    // cursor that carried only the timestamp would either repeat the whole tie
    // or skip past it.
    const total = 260;
    const tieStart = 248;
    await runInDurableObject(workspace(), (_instance, state) => {
      for (let index = 0; index < total; index += 1) {
        const id = `00000000-0000-7000-8000-${String(index).padStart(10, "0")}e1`;
        const inTie = index >= tieStart && index < tieStart + 4;
        const activity = inTie ? 5_000_000 : 9_000_000 - index * 1_000;
        state.storage.sql.exec(
          `INSERT INTO workspace_workstream_directory
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
          id, `event-${index}`, `Channel ${String(index).padStart(3, "0")}`, activity,
        );
        state.storage.sql.exec(
          `INSERT INTO space_channel_memberships
             (space_id, workstream_id, state, generation, joined_at, updated_at, removed_at)
           VALUES (?, ?, 'active', 1, 1, 1, NULL)`,
          spaceId, id,
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
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    // Activity descending, with the tie broken the way the cursor compares:
    // kind first, then id — which for four Channels at one instant is id order.
    const expected = [...Array.from({ length: total }, (_unused, index) => index)]
      .sort((left, right) => {
        const activityFor = (index: number) => (
          index >= tieStart && index < tieStart + 4 ? 5_000_000 : 9_000_000 - index * 1_000
        );
        return activityFor(right) - activityFor(left) || left - right;
      })
      .map((index) => `Channel ${String(index).padStart(3, "0")}`);
    expect(seen).toEqual(expected);
  });

  it("given every combination of run state and reader state, then the page and the contracts predicate agree", async () => {
    const spaceId = await reserve("Hiring");
    await openChannelObject(CHANNEL_A);
    await publishChannel(CHANNEL_A, [channelCommonEffect("Roadmap"), viewerEffect(OWNER)]);
    await place(spaceId, CHANNEL_A);

    // The wire status a stored `exact_state` produces, one state per status, so
    // the walk covers the whole `HarnessStatus` union rather than the states
    // that happen to be easy to reach.
    const stateForStatus: Record<HarnessStatus, string> = {
      scheduled: "scheduled",
      running: "running",
      needs_input: "needs_input",
      completed: "completed",
      failed: "failed",
      stopped: "cancelled",
      idle: "idle",
    };
    let version = 1;
    let checked = 0;
    for (const harnessStatus of HarnessStatusSchema.options) {
      for (let mask = 0; mask < 8; mask += 1) {
        const hasUnread = (mask & 1) !== 0;
        const unseen = (mask & 2) !== 0;
        const youAreMentioned = (mask & 4) !== 0;
        version += 1;
        // Written as the columns the mapper reads, so that what is compared is
        // the two implementations rather than two spellings of one input:
        // unread is an attention ordinal above the seen waterline, and a
        // mention is a mention ordinal above the same waterline.
        await publishChannel(
          CHANNEL_A,
          [
            channelCommonEffect("Roadmap", {
              state: stateForStatus[harnessStatus],
              latestAttentionOrdinal: hasUnread ? 5 : 0,
            }),
            viewerEffect(OWNER, {
              unseen,
              youAreMentioned,
              latestMentionAttentionOrdinal: youAreMentioned ? 9 : 0,
              seenAttentionOrdinal: 0,
            }),
          ],
          version,
        );
        const listed = (await page(spaceId, OWNER)).items;
        const expected = conversationNeedsViewer({
          harnessStatus,
          hasUnread,
          unseen,
          youAreMentioned,
        });
        expect({ harnessStatus, hasUnread, unseen, youAreMentioned, listed: listed.length === 1 })
          .toEqual({ harnessStatus, hasUnread, unseen, youAreMentioned, listed: expected });
        // When it is listed, the row the page built has to satisfy the
        // predicate too — otherwise the two could agree on the count while
        // disagreeing about what the row says, which is the drift the desktop
        // would then draw.
        if (listed[0]) expect(conversationNeedsViewer(listed[0])).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBe(HarnessStatusSchema.options.length * 8);
  });

  it("given a member breakout's activity, when it moves, then the refresh signal moves and an outsider's does not", async () => {
    const spaceId = await reserve("Hiring");
    const otherSpaceId = await reserve("Marketing");
    await openChannelObject(CHANNEL_A);
    await openChannelObject(CHANNEL_B);
    await publishChannel(CHANNEL_A, [channelCommonEffect("Roadmap"), viewerEffect(OWNER)]);
    await publishChannel(CHANNEL_B, [channelCommonEffect("Outside"), viewerEffect(OWNER)]);
    await place(spaceId, CHANNEL_A);
    await place(otherSpaceId, CHANNEL_B);

    const before = await conversationWaterline(spaceId, OWNER);
    await publishBreakout(CHANNEL_A, BREAKOUT_ONE, [
      breakoutCommonEffect("Pricing"),
    ]);
    const afterBreakout = await conversationWaterline(spaceId, OWNER);
    expect(afterBreakout).toBeGreaterThan(before);

    // A Channel in another Space moves nothing here. The signal is per Space
    // as well as per person, so a busy Organization does not refetch every
    // dashboard on every message.
    await publishChannel(
      CHANNEL_B,
      [channelCommonEffect("Outside", { lastActivityAt: "2026-09-19T13:00:00.000Z" })],
      2,
    );
    expect(await conversationWaterline(spaceId, OWNER)).toBe(afterBreakout);
    expect(await conversationWaterline(otherSpaceId, OWNER)).toBeGreaterThan(0);
  });

  it("given a background-agent conversation, when it projects, then nothing is forwarded for it", async () => {
    await openChannelObject(CHANNEL_A);
    await channelObject(CHANNEL_A).receiveChildEffects({
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
    // no destination.
    expect(await pendingParentEffects(channelObject(CHANNEL_A))).toEqual([]);
  });
});
