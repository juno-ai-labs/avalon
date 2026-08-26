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
import { beforeEach, describe, expect, it } from "vitest";

import {
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type UserId,
  type WorkstreamId,
} from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import { workstreamRegionalEffectHash } from "../src/durable-objects/workstream-regional-effect";
import type { WorkstreamRegionalEffect } from "../src/durable-objects/workstream-regional-effect";
/**
 * Its own workspace, not the shared fixture's.
 *
 * Every suite in this directory addresses one WorkspaceDO by name, and the
 * shared id is busy: reusing it makes this file queue behind whatever the rest
 * of the run is doing to that object, which showed up as a `beforeAll` timeout
 * rather than as a failure anyone could read.
 */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000008a0");

const OWNER = asUserId("00000000-0000-7000-8000-0000000008a1");
const OUTSIDER = asUserId("00000000-0000-7000-8000-0000000008a2");
const AUTOMATION = "00000000-0000-7000-8000-0000000008b1";
const PLANNED_FOR = "2026-08-20T09:00:00.000Z";

let envelopeSeq = 0;
let workstreamSeq = 0;

function nextWorkstreamId(): WorkstreamId {
  workstreamSeq += 1;
  return asWorkstreamId(`00000000-0000-7000-8000-${String(workstreamSeq).padStart(9, "0")}8c0`);
}

function envelope(
  effect: WorkstreamRegionalEffect,
  workstreamId: WorkstreamId,
  sourceVersion = 1,
) {
  envelopeSeq += 1;
  return {
    kind: "workstream_regional_effect" as const,
    contractVersion: 1 as const,
    region: "global" as const,
    workspaceId: WORKSPACE_ID,
    workstreamId,
    generation: 1,
    messageId: `00000000-0000-7000-8000-${String(envelopeSeq).padStart(9, "0")}8d0`,
    partitionKey: effect.kind === "directory_user" ? `user:${effect.userId}` : "common",
    sourceVersion,
    requiredProjectionVersion: null,
    payloadHash: workstreamRegionalEffectHash(effect),
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
  originType?: "ad_hoc" | "automation";
  automationSubscriptionId?: string | null;
  plannedFor?: string | null;
  participants?: UserId[];
  /** Participants who have been put in it and have not opened it. */
  unseenFor?: UserId[];
  createdByUserId?: UserId;
}

/** Publish one work stream into the directory, the way its own object would. */
async function seedWorkstream(input: SeedInput): Promise<WorkstreamId> {
  const workstreamId = nextWorkstreamId();
  const common: WorkstreamRegionalEffect = {
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
    originType: input.originType ?? "ad_hoc",
    createdByUserId: input.createdByUserId ?? OWNER,
    automationSubscriptionId: input.automationSubscriptionId ?? null,
    plannedFor: input.plannedFor ?? null,
    latestAttentionOrdinal: 0,
    unreadTrackingStartOrdinal: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: input.lastActivityAt,
    resourceLinks: [],
  };
  const viewers = (input.participants ?? [OWNER]).map((userId) => envelope({
    kind: "directory_user",
    userId,
    isParticipant: true,
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
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT NOT NULL, last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id)
    )`),
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
  await establishWorkspace();
  // The directory tests scope their reads to the ids they seeded, so those rows
  // can accumulate harmlessly. The feedback reads cannot — they ask "everything
  // this producer resolved for this event type" — so their two tables are
  // cleared rather than scoped.
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`DELETE FROM workspace_workstream_suggestion_feedback`);
    state.storage.sql.exec(`DELETE FROM workspace_connector_events`);
  });
  // Directory rows can survive from an earlier test in this file, so every read
  // below is scoped to the ids its own test seeded rather than to "everything
  // this object holds".
  envelopeSeq += 1_000;
  // Generous, and only because of the interleave above: a sibling file's
  // `reset()` holds every object's gate, so this file's first hook can wait out
  // a full reset before it gets to run at all. The work itself takes
  // milliseconds — a failure here is a hang, never a slow query.
}, 30_000);

const CONNECTOR_CONNECTION = "00000000-0000-7000-8000-0000000008e0";
let feedbackSeq = 0;

/** Ingest one connector event, so a feedback row has a provider to join to. */
async function seedConnectorEvent(input: {
  eventId: string;
  provider: string;
  eventType: string;
}): Promise<void> {
  await expect(workspace().ingestConnectorEvent({
    workspaceId: WORKSPACE_ID,
    ingressEventId: input.eventId,
    payloadHash: `sha256:${input.eventId.replaceAll("-", "").padEnd(64, "e")}`,
    event: {
      connectorType: input.provider,
      activity: {
        id: input.eventId,
        workspaceId: WORKSPACE_ID,
        region: "global",
        connectionId: CONNECTOR_CONNECTION,
        connectionScope: "workspace",
        connectionOwnerUserId: null,
        provider: input.provider,
        providerEventId: input.eventId,
        eventType: input.eventType,
        resourceType: "pull_request",
        providerResourceId: "juno-ai-labs/avalon#1",
        actor: {},
        subject: {},
        occurredAt: "2026-08-19T09:00:00.000Z",
        receivedAt: "2026-08-19T09:00:01.000Z",
        title: "Something happened",
        summary: "",
        textSnippet: "",
        payloadRef: null,
        visibility: {},
        targetUserIds: [],
        entityKeys: [],
        dedupeKey: input.eventId,
        rawContentHash: null,
        metadata: {},
        externalPeople: [],
      },
    },
  })).resolves.toMatchObject({ eventId: input.eventId });
}

/** Record how one suggestion was resolved, through the effect its object sends. */
async function seedFeedback(input: {
  workstreamId: WorkstreamId;
  activityId: string;
  source: "contextual_routing" | "suggested_work";
  status: "accepted" | "dismissed";
  resolvedAt: string;
}): Promise<void> {
  feedbackSeq += 1;
  await expect(workspace().applyWorkstreamDirectoryEffects({
    workspaceId: WORKSPACE_ID,
    envelopes: [envelope({
      kind: "suggestion_feedback",
      actionId: `00000000-0000-7000-8000-${String(feedbackSeq).padStart(9, "0")}8e1`,
      activityId: input.activityId,
      source: input.source,
      status: input.status,
      resolvedAt: input.resolvedAt,
      resolvedByUserId: OWNER,
    }, input.workstreamId)],
  })).resolves.toMatchObject({ accepted: [{ messageId: expect.any(String) }] });
}

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
      await runInDurableObject(workspace(), (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO workspace_workstream_pins
             (user_id, workstream_id, position, created_at, updated_at)
           VALUES (?, ?, 0, 1, 1)`,
          OWNER,
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
          includeSystem: false,
        },
      });

      expect(result.items).toEqual([included]);
      expect(result.items).not.toContain(pinned);
    });
  });

  describe("lookupWorkstreamDirectory — Slack's unfurl summaries", () => {
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

  describe("plannedWorkstream — the run an automation has queued", () => {
    it("finds the work stream planned for that subscription at that instant", async () => {
      const planned = await seedWorkstream({
        title: "Daily product brief",
        lastActivityAt: "2026-08-15T09:00:00.000Z",
        originType: "automation",
        automationSubscriptionId: AUTOMATION,
        plannedFor: PLANNED_FOR,
      });

      await expect(workspace().plannedWorkstream({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        automationSubscriptionId: AUTOMATION,
        plannedFor: PLANNED_FOR,
      })).resolves.toMatchObject({ id: planned, title: "Daily product brief" });
    });

    it("finds nothing for a different instant of the same subscription", async () => {
      await seedWorkstream({
        title: "Daily product brief",
        lastActivityAt: "2026-08-15T09:00:00.000Z",
        originType: "automation",
        automationSubscriptionId: AUTOMATION,
        plannedFor: PLANNED_FOR,
      });

      // The pair is the key. Matching the subscription alone would hand the
      // scheduler yesterday's work stream to reuse for today's run.
      await expect(workspace().plannedWorkstream({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        automationSubscriptionId: AUTOMATION,
        plannedFor: "2026-08-21T09:00:00.000Z",
      })).resolves.toBeNull();
    });

    it("finds nothing once the planned work stream is archived", async () => {
      const subscription = "00000000-0000-7000-8000-0000000008b2";
      await seedWorkstream({
        title: "Deleted automation's run",
        lastActivityAt: "2026-08-16T09:00:00.000Z",
        originType: "automation",
        automationSubscriptionId: subscription,
        plannedFor: PLANNED_FOR,
        archivedAt: "2026-08-16T10:00:00.000Z",
      });

      await expect(workspace().plannedWorkstream({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        automationSubscriptionId: subscription,
        plannedFor: PLANNED_FOR,
      })).resolves.toBeNull();
    });

    it("gives the scheduler its exact planned row without borrowing a member audience", async () => {
      const transferredSubscription = "00000000-0000-7000-8000-0000000008b3";
      const planned = await seedWorkstream({
        title: "Transferred private automation run",
        lastActivityAt: "2026-08-16T11:00:00.000Z",
        scope: "personal",
        participants: [OUTSIDER],
        createdByUserId: OWNER,
        originType: "automation",
        automationSubscriptionId: transferredSubscription,
        plannedFor: PLANNED_FOR,
      });

      await expect(workspace().plannedWorkstream({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        automationSubscriptionId: transferredSubscription,
        plannedFor: PLANNED_FOR,
      })).resolves.toBeNull();
      await expect(workspace().plannedAutomationWorkstream({
        workspaceId: WORKSPACE_ID,
        automationSubscriptionId: transferredSubscription,
        plannedFor: PLANNED_FOR,
      })).resolves.toMatchObject({ id: planned });
    });
  });

  describe("canReadWorkstream — what the activity router is allowed to route into", () => {
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
  describe("suggestionFeedback — the evidence contextual routing scores a bar from", () => {
    const SINCE = "2026-08-01T00:00:00.000Z";
    const PROVIDER = "github";
    const EVENT_TYPE = "pull_request.review_requested";

    it("returns only this producer's resolutions for this event type", async () => {
      const workstreamId = await seedWorkstream({
        title: "Scored",
        lastActivityAt: "2026-08-19T09:00:00.000Z",
      });
      const mine = "00000000-0000-7000-8000-0000000008f1";
      const otherType = "00000000-0000-7000-8000-0000000008f2";
      await seedConnectorEvent({ eventId: mine, provider: PROVIDER, eventType: EVENT_TYPE });
      await seedConnectorEvent({
        eventId: otherType,
        provider: PROVIDER,
        eventType: "pull_request.closed",
      });
      await seedFeedback({
        workstreamId,
        activityId: mine,
        source: "contextual_routing",
        status: "dismissed",
        resolvedAt: "2026-08-19T10:00:00.000Z",
      });
      // Suggested work writes the same-looking row. Counting it here would
      // answer "was this card useful" when the question asked was "was *this
      // producer* right", and one agent's misses would raise another's bar.
      await seedFeedback({
        workstreamId,
        activityId: mine,
        source: "suggested_work",
        status: "dismissed",
        resolvedAt: "2026-08-19T10:01:00.000Z",
      });
      await seedFeedback({
        workstreamId,
        activityId: otherType,
        source: "contextual_routing",
        status: "dismissed",
        resolvedAt: "2026-08-19T10:02:00.000Z",
      });

      const feedback = await workspace().suggestionFeedback({
        workspaceId: WORKSPACE_ID,
        source: "contextual_routing",
        since: SINCE,
        provider: PROVIDER,
        eventType: EVENT_TYPE,
      });

      expect(feedback.items).toHaveLength(1);
      expect(feedback.items[0]).toMatchObject({
        workstreamId,
        activityId: mine,
        status: "dismissed",
      });
    });

    it("forgets a resolution older than the window it was asked about", async () => {
      const workstreamId = await seedWorkstream({
        title: "Aged out",
        lastActivityAt: "2026-08-19T09:00:00.000Z",
      });
      const activityId = "00000000-0000-7000-8000-0000000008f3";
      await seedConnectorEvent({ eventId: activityId, provider: PROVIDER, eventType: EVENT_TYPE });
      await seedFeedback({
        workstreamId,
        activityId,
        source: "contextual_routing",
        status: "dismissed",
        resolvedAt: "2026-07-01T10:00:00.000Z",
      });

      // A suppression that never decays is a one-way door: the evidence that
      // would clear it can only come from suggestions the suppression prevents.
      const feedback = await workspace().suggestionFeedback({
        workspaceId: WORKSPACE_ID,
        source: "contextual_routing",
        since: SINCE,
        provider: PROVIDER,
        eventType: EVENT_TYPE,
      });

      expect(feedback.items).toEqual([]);
    });

    it("returns resolutions oldest first, so a run of them reads in order", async () => {
      const workstreamId = await seedWorkstream({
        title: "Ordered",
        lastActivityAt: "2026-08-19T09:00:00.000Z",
      });
      const first = "00000000-0000-7000-8000-0000000008f4";
      const second = "00000000-0000-7000-8000-0000000008f5";
      await seedConnectorEvent({ eventId: first, provider: PROVIDER, eventType: EVENT_TYPE });
      await seedConnectorEvent({ eventId: second, provider: PROVIDER, eventType: EVENT_TYPE });
      await seedFeedback({
        workstreamId,
        activityId: second,
        source: "contextual_routing",
        status: "accepted",
        resolvedAt: "2026-08-19T12:00:00.000Z",
      });
      await seedFeedback({
        workstreamId,
        activityId: first,
        source: "contextual_routing",
        status: "dismissed",
        resolvedAt: "2026-08-19T11:00:00.000Z",
      });

      const feedback = await workspace().suggestionFeedback({
        workspaceId: WORKSPACE_ID,
        source: "contextual_routing",
        since: SINCE,
        provider: PROVIDER,
        eventType: EVENT_TYPE,
      });

      // The caller reads a *run* of dismissals ending at the last acceptance,
      // so the order is part of the answer rather than a presentation choice.
      expect(feedback.items.map((item) => item.activityId)).toEqual([first, second]);
    });
  });
});
