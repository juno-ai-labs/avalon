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

import { WORKSPACE_PINS_MIGRATION } from "../src/durable-objects/workspace-pin-storage";
import { hostedParentStub } from "./helpers/hosted-parent";
import { placeMembership } from "./helpers/space-membership";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000e100");
const OWNER = asUserId("00000000-0000-7000-8000-00000000e101");
const MEMBER = asUserId("00000000-0000-7000-8000-00000000e102");
const OPEN_THREAD = asWorkstreamId("00000000-0000-7000-8000-00000000e103");
const PRIVATE_THREAD = asWorkstreamId("00000000-0000-7000-8000-00000000e104");
const MEMBER_THREAD = asWorkstreamId("00000000-0000-7000-8000-00000000e105");
const BREAKOUT = asSubstreamId("00000000-0000-7000-8000-00000000e106");

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
      sourceVersion: 1,
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
      { kind: "locked", placedAt: expect.any(String), threadId: PRIVATE_THREAD },
      expect.objectContaining({ kind: "thread", thread: expect.objectContaining({ id: OPEN_THREAD, title: "Cold outreach" }) }),
    ]);
    // The owner opens both, so neither is locked for them.
    expect((await feed(channelId, OWNER)).items.map((item) => item.kind)).toEqual(["thread", "thread"]);
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
  async function recordStart(workstreamId: WorkstreamId, substreamId: string, eventId: string, occurredAt: string) {
    await workspace().recordActivityEvent({
      workspaceId: WORKSPACE_ID,
      eventId,
      eventType: "workstream_message_created",
      subjectType: "workstream",
      subjectId: workstreamId,
      subjectSequenceNumber: 1,
      actorType: "user",
      actorUserId: OWNER,
      actorLabel: "Owner",
      title: "opening",
      audience: { kind: "workstream", workstreamId },
      digestible: true,
      occurredAt,
      sourceKind: "workstream_message",
      sourceId: eventId,
      dedupeKey: `message:${eventId}`,
      metadata: { substreamId },
    });
  }

  it("given starts in conversations a member may and may not list, when they read Activity, then only the listable ones appear", async () => {
    await channelWithThreads();
    await publish(OPEN_THREAD, [breakoutEffect("Side work"), viewerEffect(OWNER)], BREAKOUT);
    await recordStart(OPEN_THREAD, "0", "00000000-0000-7000-8000-00000000e201", "2026-10-03T00:00:00.000Z");
    await recordStart(PRIVATE_THREAD, "0", "00000000-0000-7000-8000-00000000e202", "2026-10-04T00:00:00.000Z");
    // A breakout private to the owner, inside a thread the member can open.
    await recordStart(OPEN_THREAD, BREAKOUT, "00000000-0000-7000-8000-00000000e203", "2026-10-05T00:00:00.000Z");

    const member = await activity(MEMBER);
    expect(member.items.map((item) => [item.kind, item.threadId, item.breakout])).toEqual([
      ["thread_started", OPEN_THREAD, null],
    ]);
    // The owner started all three, and their own starts are not news to them.
    expect((await activity(OWNER)).items).toEqual([]);
  });

  it("given a finished run in a thread the person takes part in, when they read Activity, then Rally's finish appears once and marking it seen clears its dot", async () => {
    await openThreadObject(MEMBER_THREAD);
    await publish(MEMBER_THREAD, [
      threadEffect("Funnel report", { state: "completed", completedAt: "2026-10-06T00:00:00.000Z" }),
      viewerEffect(MEMBER),
    ]);

    expect((await activity(MEMBER)).items).toEqual([expect.objectContaining({
      kind: "run_finished", threadId: MEMBER_THREAD, threadTitle: "Funnel report", actorLabel: "Rally", unread: true,
    })]);

    await workspace().markActivitySeen({
      workspaceId: WORKSPACE_ID, userId: MEMBER, seenThrough: Date.parse("2026-10-06T00:00:00.000Z"),
    });
    expect((await activity(MEMBER)).items.map((item) => item.unread)).toEqual([false]);
  });
});
