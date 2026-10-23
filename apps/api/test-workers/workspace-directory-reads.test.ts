/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The four workspace-directory reads that became the only implementation.
 *
 * Slack's App Home task list, its unfurl summaries, an automation's planned
 * work stream and the activity router's visibility check each had a regional D1
 * query beside them until migration 0090 closed the phase for good. The Node
 * suites that covered those callers now reach the object through a stub, which
 * can answer anything — so what the object actually decides is only asserted
 * here.
 *
 * Each test seeds through `applyWorkstreamDirectoryEffects`, the same envelope a
 * work stream's own object publishes, rather than by writing the directory
 * tables: a projection that stopped applying an effect would otherwise pass.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  asSpaceId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  conversationEffectHash,
  type ParentEffect,
  type UserId,
  type WorkstreamId,
} from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import { writeSidekickDirectoryRow } from "./helpers/sidekick";
/**
 * Its own workspace, not the shared fixture's.
 *
 * Every suite in this directory addresses one WorkspaceDO by name, and the
 * shared id is busy: reusing it makes this file queue behind whatever the rest
 * of the run is doing to that object, which showed up as a `beforeAll` timeout
 * rather than as a failure anyone could read.
 */
let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000008a0");

const OWNER = asUserId("00000000-0000-7000-8000-0000000008a1");
const SPACE_ID = asSpaceId("00000000-0000-7000-8000-0000000008a6");
const OTHER_SPACE_ID = asSpaceId("00000000-0000-7000-8000-0000000008a7");
const OUTSIDER = asUserId("00000000-0000-7000-8000-0000000008a2");
const MEMBER_A = asUserId("00000000-0000-7000-8000-0000000008a3");
const MEMBER_B = asUserId("00000000-0000-7000-8000-0000000008a4");
const MEMBER_C = asUserId("00000000-0000-7000-8000-0000000008a5");

let workspaceSeq = 0;
let envelopeSeq = 0;
let workstreamSeq = 0;

function nextWorkstreamId(): WorkstreamId {
  workstreamSeq += 1;
  return asWorkstreamId(`00000000-0000-7000-8000-${String(workstreamSeq).padStart(9, "0")}8c0`);
}

function envelope(
  effect: ParentEffect,
  workstreamId: WorkstreamId,
  sourceVersion = 1,
) {
  envelopeSeq += 1;
  return {
    kind: "parent_effect" as const,
    contractVersion: 1 as const,
    region: "global" as const,
    workspaceId: WORKSPACE_ID,
    parentKind: "workstream" as const,
    parentId: workstreamId,
    generation: 1,
    messageId: `00000000-0000-7000-8000-${String(envelopeSeq).padStart(9, "0")}8d0`,
    partitionKey: effect.kind === "directory_user" ? `user:${effect.userId}` : "common",
    sourceVersion,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(effect),
    effect,
  };
}

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

interface SeedInput {
  title: string;
  lastActivityAt: string;
  scope?: "personal" | "workspace";
  systemKind?: "digest" | null;
  archivedAt?: string | null;
  participants?: UserId[];
  /** Participants who have been put in it and have not opened it. */
  unseenFor?: UserId[];
  /** Join timestamps carried on each `directory_user` effect. */
  joinedAt?: ReadonlyArray<readonly [UserId, string]>;
  createdByUserId?: UserId;
}

/** Publish one work stream into the directory, the way its own object would. */
async function seedWorkstream(input: SeedInput): Promise<WorkstreamId> {
  const workstreamId = nextWorkstreamId();
  const common: ParentEffect = {
    kind: "directory_common",
    title: input.title,
    description: "",
    preview: "",
    scope: input.scope ?? "workspace",
    state: "idle",
    systemKind: input.systemKind ?? null,
    lastActivityAt: input.lastActivityAt,
    completedAt: null,
    archivedAt: input.archivedAt ?? null,
    createdByUserId: input.createdByUserId ?? OWNER,
    latestAttentionOrdinal: 0,
    unreadTrackingStartOrdinal: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: input.lastActivityAt,
    resourceLinks: [],
  };
  const joinedAt = new Map(input.joinedAt ?? []);
  const viewers = (input.participants ?? [OWNER]).map((userId) => envelope({
    kind: "directory_user",
    userId,
    isParticipant: true,
    ...(joinedAt.has(userId) ? { participantAddedAt: joinedAt.get(userId)! } : {}),
    unreadCount: 0,
    youAreMentioned: false,
    unseen: (input.unseenFor ?? []).includes(userId),
    listable: true,
    seenAttentionOrdinal: 0,
    manualUnreadFromOrdinal: null,
    manualUnreadGeneration: 0,
    latestMentionAttentionOrdinal: 0,
  }, workstreamId));

  await expect(workspace().applyWorkstreamDirectoryEffects({
    workspaceId: WORKSPACE_ID,
    envelopes: [envelope(common, workstreamId), ...viewers],
  })).resolves.toMatchObject({ directoryChanged: true });
  return workstreamId;
}

async function seedSpacePlacements(
  placements: ReadonlyArray<readonly [typeof SPACE_ID, readonly WorkstreamId[]]>,
): Promise<void> {
  await runInDurableObject(workspace(), (_instance, state) => {
    for (const [spaceId, workstreamIds] of placements) {
      state.storage.sql.exec(
        `INSERT INTO spaces
           (space_id, title, scope, appearance_json, archived_at, created_by_user_id,
            system_role, authority_generation, source_version, payload_hash, revision,
            created_at, updated_at, source_created_at, source_updated_at)
         VALUES (?, 'Batch test', 'workspace', NULL, NULL, ?, NULL, 1, 1,
                 ?, 1, 1, 1, 1, 1)`,
        spaceId,
        OWNER,
        `batch-space-${spaceId}`,
      );
      for (const workstreamId of workstreamIds) {
        state.storage.sql.exec(
          `INSERT INTO space_channel_memberships
             (space_id, workstream_id, state, generation, joined_at, updated_at, removed_at)
           VALUES (?, ?, 'active', 1, 1, 1, NULL)`,
          spaceId,
          workstreamId,
        );
      }
    }
  });
}

/**
 * Re-established before every test, not once in `beforeAll`.
 *
 * Other files in this directory call `reset()`, which wipes D1 and every
 * object's storage — and which needs the input gate, so a `beforeAll` that
 * opens an object while a sibling file is resetting simply waits until the hook
 * times out. Everything here is idempotent, so paying for it per test is
 * cheaper than reasoning about the interleaving.
 */
async function establishWorkspace(): Promise<void> {
  // Applying a directory effect reads the regional membership roll to decide
  // who may list a work stream, so the tables have to exist even where nothing
  // here turns on their contents.
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT, abandoned_at TEXT
    )`),
    // `access_class` mirrors the production column, default and all: the
    // workspace socket reads it at accept time to decide whether this session
    // is told about Spaces, so a fixture without it fails the upgrade rather
    // than the thing under test.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (incarnation TEXT DEFAULT 'existing-member',
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT NOT NULL, access_class TEXT NOT NULL DEFAULT 'member',
      last_seen_at TEXT, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (workspace_incarnation TEXT DEFAULT 'existing-member',
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
      (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'owner')`)
      .bind(WORKSPACE_ID, OWNER),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'member')`)
      .bind(WORKSPACE_ID, OUTSIDER),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
}

beforeEach(async () => {
  workspaceSeq += 1;
  WORKSPACE_ID = asWorkspaceId(`00000000-0000-7000-8000-${String(workspaceSeq).padStart(9, "0")}8a0`);
  await establishWorkspace();
  // Each test owns its directory: earlier fixtures must not crowd its page.
  envelopeSeq += 1_000;
  // Generous, and only because of the interleave above: a sibling file's
  // `reset()` holds every object's gate, so this file's first hook can wait out
  // a full reset before it gets to run at all. The work itself takes
  // milliseconds — a failure here is a hang, never a slow query.
}, 30_000);

describe("what the workspace object answers about its work streams", () => {
  describe("batchUpdateTargets — generic filtered Queue fan-out", () => {
    it("selects one viewer-visible unpinned date range without probing children", async () => {
      const included = await seedWorkstream({
        title: "Included",
        lastActivityAt: "2020-03-12T12:00:00.000Z",
      });
      const pinned = await seedWorkstream({
        title: "Pinned",
        lastActivityAt: "2020-03-13T12:00:00.000Z",
      });
      const otherSpace = await seedWorkstream({
        title: "Only in another Space",
        lastActivityAt: "2020-03-14T12:00:00.000Z",
      });
      await seedSpacePlacements([
        [SPACE_ID, [included, pinned]],
        [OTHER_SPACE_ID, [otherSpace]],
      ]);
      await runInDurableObject(workspace(), (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO workspace_workstream_pins
             (user_id, space_id, workstream_id, position, created_at, updated_at)
           VALUES (?, ?, ?, 0, 1, 1)`,
          OWNER,
          SPACE_ID,
          pinned,
        );
      });
      await seedWorkstream({
        title: "Too old",
        lastActivityAt: "2020-03-09T12:00:00.000Z",
      });
      await seedWorkstream({
        title: "Private to somebody else",
        lastActivityAt: "2020-03-14T12:00:00.000Z",
        scope: "personal",
        participants: [OUTSIDER],
        createdByUserId: OUTSIDER,
      });
      await seedWorkstream({
        title: "System machinery",
        lastActivityAt: "2020-03-15T12:00:00.000Z",
        systemKind: "digest",
      });
      await seedWorkstream({
        title: "Already archived",
        lastActivityAt: "2020-03-16T12:00:00.000Z",
        archivedAt: "2020-03-17T00:00:00.000Z",
      });

      const result = await workspace().batchUpdateTargets({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        filter: {
          lastActivityAt: {
            atOrAfter: "2020-03-10T00:00:00.000Z",
            before: "2020-03-20T00:00:00.000Z",
          },
          pinned: false,
          spaceId: SPACE_ID,
          includeSystem: false,
        },
      });

      expect(result.items).toEqual([included]);
      expect(result.items).not.toContain(pinned);
      expect(result.items).not.toContain(otherSpace);
      // The note half of the same answer, empty here because this suite seeds
      // no notes. It is asserted so that a filter resolution which stopped
      // reporting notes at all would fail here rather than silently leave a
      // grouping's **Archive all** counting only half of what it takes.
      expect(result.noteIds).toEqual([]);
    });

    it("freezes one operation and resumes only its undispatched targets", async () => {
      const included = await seedWorkstream({
        title: "Frozen target",
        lastActivityAt: "2010-03-12T12:00:00.000Z",
      });
      const request = {
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        operationId: "00000000-0000-7000-8000-0000000008f1",
        requestHash: "fnv1a64:1111111111111111",
        filter: {
          lastActivityAt: {
            atOrAfter: "2010-03-10T00:00:00.000Z",
            before: "2010-03-20T00:00:00.000Z",
          },
          pinned: false,
          spaceId: SPACE_ID,
          includeSystem: false,
        },
        update: { kind: "mark_read" },
      } as const;

      await seedSpacePlacements([[SPACE_ID, [included]]]);

      await expect(workspace().beginWorkstreamBatchDispatch(request)).resolves.toEqual({
        items: [included],
        targetCount: 1,
      });
      await seedWorkstream({
        title: "Arrived after confirmation",
        lastActivityAt: "2010-03-13T12:00:00.000Z",
      });

      await expect(workspace().beginWorkstreamBatchDispatch(request)).resolves.toEqual({
        items: [included],
        targetCount: 1,
      });
      await expect(workspace().advanceWorkstreamBatchDispatch({
        workspaceId: WORKSPACE_ID,
        operationId: request.operationId,
        requestHash: request.requestHash,
        workstreamIds: [included],
      })).resolves.toEqual({ remainingCount: 0 });
      await expect(workspace().beginWorkstreamBatchDispatch(request)).resolves.toEqual({
        items: [],
        targetCount: 1,
      });
    });

    it("records 100 published ids without exceeding the object SQLite bind limit", async () => {
      // Cloudflare admits 100 messages even though the product currently sends
      // 50. Object SQLite also admits 100 parameters total, and this statement
      // needs two scalars beside the ids. The real engine proves that this layer
      // stays safe if the product's transport limit changes later.
      const included: WorkstreamId[] = [];
      for (let index = 0; index < 100; index += 1) {
        included.push(await seedWorkstream({
          title: `Full Queue batch ${index}`,
          lastActivityAt: "2009-03-12T12:00:00.000Z",
        }));
      }
      await seedSpacePlacements([[SPACE_ID, included]]);
      const request = {
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        operationId: "00000000-0000-7000-8000-0000000008f2",
        requestHash: "fnv1a64:2222222222222222",
        filter: {
          lastActivityAt: {
            atOrAfter: "2009-03-10T00:00:00.000Z",
            before: "2009-03-20T00:00:00.000Z",
          },
          pinned: false,
          spaceId: SPACE_ID,
          includeSystem: false,
        },
        update: { kind: "mark_read" },
      } as const;

      await expect(workspace().beginWorkstreamBatchDispatch(request)).resolves.toEqual({
        items: [...included].sort(),
        targetCount: 100,
      });
      await expect(workspace().advanceWorkstreamBatchDispatch({
        workspaceId: WORKSPACE_ID,
        operationId: request.operationId,
        requestHash: request.requestHash,
        workstreamIds: included,
      })).resolves.toEqual({ remainingCount: 0 });
      await expect(workspace().beginWorkstreamBatchDispatch(request)).resolves.toEqual({
        items: [],
        targetCount: 100,
      });
    });
  });

  describe("lookupWorkstreamDirectory — Slack's unfurl summaries", () => {
    it("accepts the lookup schema maximum without exceeding the SQLite bind limit", async () => {
      const unknownIds = Array.from({ length: 250 }, (_, index) => (
        asWorkstreamId(`00000000-0000-7000-8000-${String(900_000 + index).padStart(12, "0")}`)
      ));

      await expect(workspace().lookupWorkstreamDirectory({
        workspaceId: WORKSPACE_ID,
        workstreamIds: unknownIds,
      })).resolves.toEqual({ items: [] });
    });

    it("returns exactly the ids asked for, and no others", async () => {
      const wanted = await seedWorkstream({
        title: "Quarterly planning",
        lastActivityAt: "2026-08-10T12:00:00.000Z",
      });
      const other = await seedWorkstream({
        title: "Not asked for",
        lastActivityAt: "2026-08-11T12:00:00.000Z",
      });

      const page = await workspace().lookupWorkstreamDirectory({
        workspaceId: WORKSPACE_ID,
        workstreamIds: [wanted],
      });

      expect(page.items.map((item) => item.workstreamId)).toEqual([wanted]);
      expect(page.items[0]).toMatchObject({ title: "Quarterly planning" });
      expect(page.items.map((item) => item.workstreamId)).not.toContain(other);
    });

    it("still returns an archived work stream, and says it is archived", async () => {
      // The caller drops these itself, so the object returning them is what
      // makes that filter reachable. An object that hid them would leave the
      // Slack path's `archivedAt === null` check dead, and the next person to
      // read it would delete it as redundant.
      const archived = await seedWorkstream({
        title: "Retired",
        lastActivityAt: "2026-08-09T12:00:00.000Z",
        archivedAt: "2026-08-10T00:00:00.000Z",
      });

      const page = await workspace().lookupWorkstreamDirectory({
        workspaceId: WORKSPACE_ID,
        workstreamIds: [archived],
      });

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.archivedAt).not.toBeNull();
    });

    it("answers an id it has never heard of with nothing, not an error", async () => {
      const page = await workspace().lookupWorkstreamDirectory({
        workspaceId: WORKSPACE_ID,
        workstreamIds: [asWorkstreamId("00000000-0000-7000-8000-0000000008ff")],
      });

      expect(page.items).toEqual([]);
    });
  });

  describe("linkTitle — the name a shared link's page shows signed out", () => {
    it("names a Channel by its id, private or not, and nothing for an id it does not hold", async () => {
      const channel = await seedWorkstream({
        title: "Q3 launch plan",
        lastActivityAt: "2026-08-10T12:00:00.000Z",
        scope: "personal",
      });

      await expect(workspace().linkTitle({ workspaceId: WORKSPACE_ID, target: { kind: "channel", workstreamId: channel } }))
        .resolves.toEqual({ title: "Q3 launch plan" });
      await expect(workspace().linkTitle({ workspaceId: WORKSPACE_ID, target: { kind: "channel", workstreamId: nextWorkstreamId() } }))
        .resolves.toEqual({ title: null });
    });

    it("names a Space", async () => {
      await seedSpacePlacements([[SPACE_ID, []]]);

      await expect(workspace().linkTitle({ workspaceId: WORKSPACE_ID, target: { kind: "space", spaceId: SPACE_ID } }))
        .resolves.toEqual({ title: "Batch test" });
    });

    it("names a live Sidekick and not a deleted one", async () => {
      const row = {
        workspaceId: WORKSPACE_ID, authorUserId: OWNER, scope: "workspace" as const,
        owningWorkstreamId: null, title: "Weekly digest", description: "",
      };
      const live = "00000000-0000-7000-8000-0000000008e1";
      const deleted = "00000000-0000-7000-8000-0000000008e2";
      await writeSidekickDirectoryRow(env, { ...row, automationId: live, lifecycle: "active" });
      await writeSidekickDirectoryRow(env, { ...row, automationId: deleted, lifecycle: "deleted" });

      await expect(workspace().linkTitle({ workspaceId: WORKSPACE_ID, target: { kind: "sidekick", sidekickId: live } }))
        .resolves.toEqual({ title: "Weekly digest" });
      await expect(workspace().linkTitle({ workspaceId: WORKSPACE_ID, target: { kind: "sidekick", sidekickId: deleted } }))
        .resolves.toEqual({ title: null });
    });
  });

  describe("recentWorkstreamDirectory — Slack's App Home task list", () => {
    it("withholds a system work stream from a caller that did not ask for one", async () => {
      const ordinary = await seedWorkstream({
        title: "Ordinary work",
        lastActivityAt: "2026-08-12T09:00:00.000Z",
      });
      const digest = await seedWorkstream({
        title: "Digest machinery",
        lastActivityAt: "2026-08-12T10:00:00.000Z",
        systemKind: "digest",
      });

      const page = await workspace().recentWorkstreamDirectory({
        workspaceId: WORKSPACE_ID,
        audience: { scope: "user", userId: OWNER },
        includeSystem: false,
        participantsOnly: true,
        limit: 50,
      });

      const ids = page.items.map((item) => item.workstreamId);
      expect(ids).toContain(ordinary);
      // Newer than the ordinary one, so it would lead the list if it were shown
      // at all. Slack has no equivalent of the desktop's Debug enabled.
      expect(ids).not.toContain(digest);
    });

    it("withholds a work stream the viewer does not participate in", async () => {
      const theirs = await seedWorkstream({
        title: "Somebody else's",
        lastActivityAt: "2026-08-13T09:00:00.000Z",
        scope: "personal",
        participants: [OUTSIDER],
        createdByUserId: OUTSIDER,
      });

      const page = await workspace().recentWorkstreamDirectory({
        workspaceId: WORKSPACE_ID,
        audience: { scope: "user", userId: OWNER },
        includeSystem: false,
        participantsOnly: true,
        limit: 50,
      });

      expect(page.items.map((item) => item.workstreamId)).not.toContain(theirs);
    });

    it("keeps one person's unseen work stream unseen for them alone", async () => {
      const workstreamId = await seedWorkstream({
        title: "Warehouse migration",
        lastActivityAt: "2026-08-14T09:00:00.000Z",
        participants: [OWNER, OUTSIDER],
        unseenFor: [OUTSIDER],
      });

      const theirs = await workspace().listWorkstreams({
        workspaceId: WORKSPACE_ID,
        userId: OUTSIDER,
        includeSystem: false,
        limit: 50,
      });
      const mine = await workspace().listWorkstreams({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        includeSystem: false,
        limit: 50,
      });

      // Same work stream, one row per reader: the flag is the viewer's, so it
      // has to survive the projection as the viewer's rather than the row's.
      expect(theirs.items.find((item) => item.id === workstreamId)?.unseen).toBe(true);
      expect(mine.items.find((item) => item.id === workstreamId)?.unseen).toBe(false);
    });

    it("orders by last activity and honours the limit", async () => {
      const older = await seedWorkstream({
        title: "Older",
        lastActivityAt: "2026-08-14T09:00:00.000Z",
      });
      const newer = await seedWorkstream({
        title: "Newer",
        lastActivityAt: "2026-08-14T11:00:00.000Z",
      });

      const page = await workspace().recentWorkstreamDirectory({
        workspaceId: WORKSPACE_ID,
        audience: { scope: "user", userId: OWNER },
        includeSystem: false,
        participantsOnly: true,
        limit: 1,
      });

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.workstreamId).toBe(newer);
      expect(page.items.map((item) => item.workstreamId)).not.toContain(older);
    });

    it("never treats a workspace audience as permission to inspect private rows", async () => {
      const shared = await seedWorkstream({
        title: "Shared planning",
        lastActivityAt: "2026-08-14T10:00:00.000Z",
        scope: "workspace",
      });
      const privateWorkstream = await seedWorkstream({
        title: "Private acquisition plan",
        lastActivityAt: "2026-08-14T12:00:00.000Z",
        scope: "personal",
        participants: [OWNER],
      });

      const workspacePage = await workspace().recentWorkstreamDirectory({
        workspaceId: WORKSPACE_ID,
        audience: { scope: "workspace" },
        includeSystem: false,
        participantsOnly: false,
        limit: 50,
      });
      const userPage = await workspace().recentWorkstreamDirectory({
        workspaceId: WORKSPACE_ID,
        audience: { scope: "user", userId: OWNER },
        includeSystem: false,
        participantsOnly: false,
        limit: 50,
      });

      expect(workspacePage.items.map((item) => item.workstreamId)).toContain(shared);
      expect(workspacePage.items.map((item) => item.workstreamId)).not.toContain(privateWorkstream);
      expect(userPage.items.map((item) => item.workstreamId)).toEqual(expect.arrayContaining([
        shared,
        privateWorkstream,
      ]));
    });
  });

  describe("listWorkstreams — sidebar participant preview", () => {
    const extraMembers = [MEMBER_A, MEMBER_B, MEMBER_C];

    async function admitExtraMembers(): Promise<void> {
      await env.DB.batch(extraMembers.map((userId) => env.DB.prepare(
        `INSERT OR REPLACE INTO workspace_members
           (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'member')`,
      ).bind(WORKSPACE_ID, userId)));
    }

    async function stampViewerProjectedAt(
      workstreamId: WorkstreamId,
      recency: ReadonlyArray<readonly [UserId, number]>,
    ): Promise<void> {
      await runInDurableObject(workspace(), (_instance, state) => {
        for (const [userId, projectedAt] of recency) {
          state.storage.sql.exec(
            `UPDATE channel_viewers
                SET projected_at = ?
              WHERE workstream_id = ? AND user_id = ?`,
            projectedAt,
            workstreamId,
            userId,
          );
        }
      });
    }

    function nextMessage(socket: WebSocket): Promise<MessageEvent> {
      return new Promise((resolve) => socket.addEventListener("message", resolve, { once: true }));
    }

    async function connect(userId: UserId, ticketSuffix: string): Promise<WebSocket> {
      await env.DB.prepare(`INSERT OR REPLACE INTO sessions
        (id, user_id, workspace_id, region, revoked_at, expires_at)
        VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
        .bind(`directory-session-${userId}`, userId, WORKSPACE_ID).run();
      const response = await workspace().fetch("https://workspace.test/socket", {
        headers: {
          Upgrade: "websocket",
          "x-rally-workspace-id": WORKSPACE_ID,
          "x-rally-placement-affinity": "wnam",
          "x-rally-user-id": userId,
          "x-rally-session-id": `directory-session-${userId}`,
          "x-rally-socket-ticket-id": `00000000-0000-7000-8000-${ticketSuffix}`,
          "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
        },
      });
      if (response.status !== 101 || !response.webSocket) {
        throw new Error(`workspace socket rejected: ${response.status} ${await response.text()}`);
      }
      response.webSocket.accept();
      const initial = nextMessage(response.webSocket);
      response.webSocket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
      expect(JSON.parse(String((await initial).data))).toMatchObject({ type: "workspace_sync" });
      return response.webSocket;
    }

    it("serves UUIDv4 common and viewer state on the real socket and warns about their origin", async () => {
      const workstreamId = await seedWorkstream({ title: "Historical identities", lastActivityAt: "2026-10-23T00:00:00.000Z" });
      const commonEventId = "00000000-0000-4000-8000-000000000901";
      const viewerEventId = "00000000-0000-4000-8000-000000000902";
      await runInDurableObject(workspace(), (instance, state) => {
        state.storage.sql.exec("UPDATE channels SET source_event_id = ? WHERE workstream_id = ?", commonEventId, workstreamId);
        state.storage.sql.exec("UPDATE channel_viewers SET source_event_id = ? WHERE workstream_id = ? AND user_id = ?", viewerEventId, workstreamId, OWNER);
        const host = instance as unknown as { env: { LOG_LEVEL: string } };
        host.env = new Proxy(host.env, { get: (target, key, receiver) => key === "LOG_LEVEL" ? "warn" : Reflect.get(target, key, receiver) });
      });
      const page = await workspace().listWorkstreams({ workspaceId: WORKSPACE_ID, userId: OWNER, includeSystem: false, limit: 50 });
      expect(page.stateVersions).toEqual([expect.objectContaining({ workstreamId, commonEventId, viewerEventId })]);
      const warnings = vi.spyOn(console, "warn");
      let socket: WebSocket | undefined;
      try {
        socket = await connect(OWNER, "000000000903");
        const answer = nextMessage(socket);
        socket.send(JSON.stringify({ type: "list_workstreams", requestId: "00000000-0000-7000-8000-000000000904", limit: 50, includeSystem: false }));
        expect(JSON.parse(String((await answer).data))).toMatchObject({
          type: "workspace_workstream_page", stateVersions: [expect.objectContaining({ workstreamId, commonEventId, viewerEventId })],
        });
        for (const [field, eventId] of [["commonEventId", commonEventId], ["viewerEventId", viewerEventId]]) {
          expect(warnings).toHaveBeenCalledWith(expect.objectContaining({
            event: "workspace_directory_non_v7_event_id", field, event_id: eventId,
            workspace_id: WORKSPACE_ID, workstream_id: workstreamId, uuid_version: "4",
          }));
        }
      } finally {
        socket?.close();
        warnings.mockRestore();
      }
    });

    it("caps a personal row at three newest participant ids and an overflow", async () => {
      await admitExtraMembers();
      const workstreamId = await seedWorkstream({
        title: "Staffing",
        lastActivityAt: "2026-08-19T09:00:00.000Z",
        scope: "personal",
        participants: [OWNER, OUTSIDER, MEMBER_A, MEMBER_B, MEMBER_C],
        joinedAt: [
          [MEMBER_C, "2026-08-19T09:00:05.000Z"],
          [MEMBER_B, "2026-08-19T09:00:04.000Z"],
          [MEMBER_A, "2026-08-19T09:00:03.000Z"],
          [OUTSIDER, "2026-08-19T09:00:02.000Z"],
          [OWNER, "2026-08-19T09:00:01.000Z"],
        ],
      });

      const page = await workspace().listWorkstreams({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        includeSystem: false,
        limit: 50,
      });
      const row = page.items.find((item) => item.id === workstreamId);

      expect(row?.participantUserIds).toEqual([MEMBER_C, MEMBER_B, MEMBER_A]);
      expect(row?.participantExtraCount).toBe(2);
    });

    it("does not reshuffle faces when overlay projected_at is rewritten", async () => {
      await admitExtraMembers();
      const workstreamId = await seedWorkstream({
        title: "Staffing recency",
        lastActivityAt: "2026-08-19T09:05:00.000Z",
        scope: "personal",
        participants: [OWNER, OUTSIDER, MEMBER_A, MEMBER_B, MEMBER_C],
        joinedAt: [
          [MEMBER_C, "2026-08-19T09:00:05.000Z"],
          [MEMBER_B, "2026-08-19T09:00:04.000Z"],
          [MEMBER_A, "2026-08-19T09:00:03.000Z"],
          [OUTSIDER, "2026-08-19T09:00:02.000Z"],
          [OWNER, "2026-08-19T09:00:01.000Z"],
        ],
      });
      await stampViewerProjectedAt(workstreamId, [
        [OWNER, 9_000],
        [OUTSIDER, 8_000],
        [MEMBER_A, 7_000],
        [MEMBER_B, 6_000],
        [MEMBER_C, 5_000],
      ]);

      const page = await workspace().listWorkstreams({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        includeSystem: false,
        limit: 50,
      });
      const row = page.items.find((item) => item.id === workstreamId);

      expect(row?.participantUserIds).toEqual([MEMBER_C, MEMBER_B, MEMBER_A]);
      expect(row?.participantExtraCount).toBe(2);
    });

    it("does not carry participant ids on a workspace-scoped row", async () => {
      await admitExtraMembers();
      const workstreamId = await seedWorkstream({
        title: "Shared planning",
        lastActivityAt: "2026-08-19T10:00:00.000Z",
        scope: "workspace",
        participants: [OWNER, OUTSIDER, MEMBER_A, MEMBER_B, MEMBER_C],
      });

      const page = await workspace().listWorkstreams({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        includeSystem: false,
        limit: 50,
      });
      const row = page.items.find((item) => item.id === workstreamId);

      expect(row?.participantUserIds).toEqual([]);
      expect(row?.participantExtraCount).toBe(0);
    });

    it("lists more than 100 personal work streams without exceeding the SQLite bind limit", async () => {
      const started = Date.parse("2026-08-19T11:00:00.000Z");
      for (let index = 0; index < 101; index += 1) {
        await seedWorkstream({
          title: `Bind room ${index}`,
          lastActivityAt: new Date(started + index * 1_000).toISOString(),
          scope: "personal",
          participants: [OWNER],
        });
      }

      const page = await workspace().listWorkstreams({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        includeSystem: false,
        limit: 250,
      });

      expect(page.items.filter((item) => item.title.startsWith("Bind room "))).toHaveLength(101);
    });

    it("pushes the recomputed facepile to every connected participant after a join", async () => {
      await admitExtraMembers();
      const workstreamId = await seedWorkstream({
        title: "Live pile",
        lastActivityAt: "2026-08-19T12:00:00.000Z",
        scope: "personal",
        participants: [OWNER, MEMBER_A],
        joinedAt: [
          [OWNER, "2026-08-19T12:00:01.000Z"],
          [MEMBER_A, "2026-08-19T12:00:02.000Z"],
        ],
      });
      const ownerSocket = await connect(OWNER, "0000000008f1");
      const memberSocket = await connect(MEMBER_A, "0000000008f2");
      const ownerPush = nextMessage(ownerSocket);
      const memberPush = nextMessage(memberSocket);

      await expect(workspace().applyWorkstreamDirectoryEffects({
        workspaceId: WORKSPACE_ID,
        envelopes: [envelope({
          kind: "directory_user",
          userId: MEMBER_B,
          isParticipant: true,
          participantAddedAt: "2026-08-19T12:00:03.000Z",
          unreadCount: 0,
          youAreMentioned: false,
          unseen: true,
          listable: true,
          seenAttentionOrdinal: 0,
          manualUnreadFromOrdinal: null,
          manualUnreadGeneration: 0,
          latestMentionAttentionOrdinal: 0,
        }, workstreamId)],
      })).resolves.toMatchObject({ directoryChanged: true });

      const ownerEvent = JSON.parse(String((await ownerPush).data)) as {
        type: string;
        workstreamId: string;
        workstream: { participantUserIds: string[] } | null;
      };
      const memberEvent = JSON.parse(String((await memberPush).data)) as {
        type: string;
        workstreamId: string;
        workstream: { participantUserIds: string[] } | null;
      };
      expect(ownerEvent).toMatchObject({ type: "workspace_workstream_state", workstreamId });
      expect(memberEvent).toMatchObject({ type: "workspace_workstream_state", workstreamId });
      expect(ownerEvent.workstream?.participantUserIds).toEqual([MEMBER_B, MEMBER_A, OWNER]);
      expect(memberEvent.workstream?.participantUserIds).toEqual([MEMBER_B, MEMBER_A, OWNER]);

      const ownerRemoved = nextMessage(ownerSocket);
      const memberRemoved = nextMessage(memberSocket);
      await expect(workspace().applyWorkstreamDirectoryEffects({
        workspaceId: WORKSPACE_ID,
        envelopes: [envelope({
          kind: "directory_user",
          userId: MEMBER_B,
          isParticipant: false,
          participantAddedAt: null,
          unreadCount: 0,
          youAreMentioned: false,
          unseen: false,
          listable: false,
          seenAttentionOrdinal: 0,
          manualUnreadFromOrdinal: null,
          manualUnreadGeneration: 0,
          latestMentionAttentionOrdinal: 0,
        }, workstreamId, 2)],
      })).resolves.toMatchObject({ directoryChanged: true });

      expect(JSON.parse(String((await ownerRemoved).data))).toMatchObject({
        type: "workspace_workstream_state",
        workstreamId,
        workstream: { participantUserIds: [MEMBER_A, OWNER] },
      });
      expect(JSON.parse(String((await memberRemoved).data))).toMatchObject({
        type: "workspace_workstream_state",
        workstreamId,
        workstream: { participantUserIds: [MEMBER_A, OWNER] },
      });
    });
  });

  describe("canReadWorkstream — what the activity router is allowed to route into", () => {
    it("accepts the readable-id schema maximum without exceeding the SQLite bind limit", async () => {
      const unknownIds = Array.from({ length: 100 }, (_, index) => (
        asWorkstreamId(`00000000-0000-7000-8000-${String(910_000 + index).padStart(12, "0")}`)
      ));

      await expect(workspace().readableWorkstreamIds({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        workstreamIds: unknownIds,
      })).resolves.toEqual({ items: [] });
    });

    it("filters a bounded set through one directory audience read", async () => {
      const shared = await seedWorkstream({
        title: "Workspace scoped batch",
        lastActivityAt: "2026-08-17T08:00:00.000Z",
        scope: "workspace",
        participants: [OUTSIDER],
      });
      const mine = await seedWorkstream({
        title: "My private batch",
        lastActivityAt: "2026-08-17T08:01:00.000Z",
        scope: "personal",
        participants: [OWNER],
      });
      const theirs = await seedWorkstream({
        title: "Their private batch",
        lastActivityAt: "2026-08-17T08:02:00.000Z",
        scope: "personal",
        participants: [OUTSIDER],
      });

      await expect(workspace().readableWorkstreamIds({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        workstreamIds: [theirs, shared, mine],
      })).resolves.toEqual({ items: [shared, mine].sort() });
    });

    it("admits a participant and a workspace-scoped work stream alike", async () => {
      const shared = await seedWorkstream({
        title: "Workspace scoped",
        lastActivityAt: "2026-08-17T09:00:00.000Z",
        scope: "workspace",
        participants: [OWNER],
      });

      await expect(workspace().canReadWorkstream({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        workstreamId: shared,
      })).resolves.toBe(true);
      await expect(workspace().canReadWorkstream({
        workspaceId: WORKSPACE_ID,
        userId: OUTSIDER,
        workstreamId: shared,
      })).resolves.toBe(true);
    });

    it("refuses someone else's personal work stream", async () => {
      const theirs = await seedWorkstream({
        title: "Private",
        lastActivityAt: "2026-08-18T09:00:00.000Z",
        scope: "personal",
        participants: [OUTSIDER],
        createdByUserId: OUTSIDER,
      });

      await expect(workspace().canReadWorkstream({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        workstreamId: theirs,
      })).resolves.toBe(false);
    });

    it("revokes a private work stream from its creator after participation ends", async () => {
      const created = await seedWorkstream({
        title: "Creator-owned private work",
        lastActivityAt: "2026-08-18T10:00:00.000Z",
        scope: "personal",
        participants: [OUTSIDER],
        createdByUserId: OWNER,
      });

      await expect(workspace().canReadWorkstream({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        workstreamId: created,
      })).resolves.toBe(false);
      await expect(workspace().recentWorkstreamDirectory({
        workspaceId: WORKSPACE_ID,
        audience: { scope: "user", userId: OWNER },
        includeSystem: false,
        participantsOnly: true,
        limit: 50,
      }).then((page) => page.items.map((item) => item.workstreamId)))
        .resolves.not.toContain(created);
    });

    it("refuses an archived work stream to a reader who could otherwise open it", async () => {
      const archived = await seedWorkstream({
        title: "Finished and filed",
        lastActivityAt: "2026-08-18T10:00:00.000Z",
        scope: "workspace",
        archivedAt: "2026-08-19T10:00:00.000Z",
      });

      // Archival is what takes a work stream out of every listing, and this is
      // the read the routes ahead of those listings share: adding an archived
      // work stream to a project, or routing activity into it, is refused here
      // rather than by each caller.
      await expect(workspace().canReadWorkstream({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        workstreamId: archived,
      })).resolves.toBe(false);
    });

    it("refuses a work stream it has never heard of", async () => {
      // The routing path treats `true` as permission to deliver an activity, so
      // an unknown id must not read as "nothing objected".
      await expect(workspace().canReadWorkstream({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        workstreamId: asWorkstreamId("00000000-0000-7000-8000-0000000008fe"),
      })).resolves.toBe(false);
    });
  });
 });
