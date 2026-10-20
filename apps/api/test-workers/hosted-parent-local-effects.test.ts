/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * What a hosted parent's write lands in the Organization object, on real
 * workerd (docs/hosted-conversation-parents.md).
 *
 * A Channel parent and the Organization directory share one object, so the
 * parent applies what it publishes (the Channel row, a viewer row, a feed row)
 * inside its own transaction, and the post-commit work the directory owes is
 * a row written in that same transaction. The membership the directory reads
 * is the object's own table, fed by relationship change events, with one D1
 * read for somebody it has never heard of, made before the transaction or,
 * when the transaction meets them, between it and one retry. Each case below
 * is one of those primitives, read inside the object in the same invocation
 * as the write, so an alarm cannot be what put a row there.
 */
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConversationEffectEnvelopeSchema,
  ParentEffectEnvelopeSchema,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  conversationEffectHash,
  type ConversationEffect,
  type ParentEffect,
  type ParentEffectEnvelope,
} from "@rally/contracts";
import type { WorkspaceRelationship } from "@rally/contracts/scope-grants";

import pushDevicesMigration from "../../../packages/db/migrations/0107_user_push_devices.sql?raw";
import { splitSqlStatements } from "../src/lib/sql-statements";
import type { Env } from "../src/env";
import { hostedParentStub } from "./helpers/hosted-parent";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000f00");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000f01");
const SESSION_ID = "00000000-0000-7000-8000-000000000f02";
const CHANNEL_ID = "00000000-0000-7000-8000-000000000f03";
const OTHER_USER_ID = asUserId("00000000-0000-7000-8000-000000000f04");
const BREAKOUT_ID = "00000000-0000-7000-8000-000000000f05";
const SPACE_ID = "00000000-0000-7000-8000-000000000f06";

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: USER_ID, sessionId: SESSION_ID });
  await env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
    VALUES (?, ?, 'active', 'member', '2026-08-18T20:00:00.000Z')`).bind(WORKSPACE_ID, OTHER_USER_ID).run();
  await env.DB.batch(splitSqlStatements(pushDevicesMigration).map((sql) => env.DB.prepare(sql)));
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
}, 30_000);

function workspace() {
  return hostedParentStub(env, WORKSPACE_ID);
}

/** Refuse `ACTIVITY_QUEUE`, so an alarm that fires early keeps its rows rather than sending them. */
async function parkActivityQueue(): Promise<void> {
  await runInDurableObject(workspace(), (instance) => {
    const target = instance as unknown as { env: Env };
    const refused = () => Promise.reject(new Error("activity_queue_parked_by_test"));
    target.env = new Proxy(target.env, {
      get: (current, property, receiver) => property === "ACTIVITY_QUEUE"
        ? { send: refused, sendBatch: refused }
        : Reflect.get(current, property, receiver),
    });
  });
}

function relationship(userId: string): WorkspaceRelationship {
  return {
    workspaceId: WORKSPACE_ID, userId: asUserId(userId), accessClass: "member", role: "member",
    status: "active", incarnation: "existing-member", revision: 1,
  };
}

const reservation = {
  workspaceId: WORKSPACE_ID,
  parentId: CHANNEL_ID,
  createdByUserId: USER_ID,
  authorityGeneration: 1,
  substreamId: asSubstreamId("0"),
  kind: "main" as const,
  directory: {
    title: "Lands with its parent",
    description: "",
    scope: "workspace" as const,
    systemKind: null,
    emailAddress: null,
    titleStatus: "settled" as const,
    createdAt: "2026-09-01T12:00:00.000Z",
  },
};

/** A viewer row, in the shape both a child and the Queue carry it. */
function viewerEffect(userId: string, unreadCount: number): ConversationEffect & ParentEffect {
  return {
    kind: "directory_user",
    userId: asUserId(userId),
    isParticipant: true,
    participantAddedAt: "2026-09-01T12:00:00.000Z",
    unreadCount,
    youAreMentioned: false,
    unseen: false,
    listable: true,
  } as ConversationEffect & ParentEffect;
}

const activity: ConversationEffect = {
  kind: "activity_event",
  eventId: "00000000-0000-7000-8000-000000000f10",
  eventType: "workstream_message_created",
  subjectSequenceNumber: 1,
  actorType: "agent",
  actorUserId: null,
  actorLabel: "Rally",
  title: "Said something",
  body: "",
  canonicalUrl: null,
  digestible: false,
  occurredAt: "2026-09-01T12:00:00.000Z",
  sourceKind: "message",
  sourceId: null,
  dedupeKey: "local-effects-activity",
  metadata: {},
  targets: [],
};

/** What the Channel's Main conversation, or one of its breakouts, stamps on an effect it sends its parent. */
function childEnvelope(sourceVersion: number, effect: ConversationEffect, substreamId = "0") {
  return ConversationEffectEnvelopeSchema.parse({
    kind: "conversation_effect",
    contractVersion: 1,
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: "workstream",
    parentId: CHANNEL_ID,
    substreamId,
    generation: 1,
    messageId: `00000000-0000-7000-8000-0000000f${String(sourceVersion).padStart(4, "0")}`,
    partitionKey: effect.kind === "directory_user" ? `user:${effect.userId}` : "common",
    sourceVersion,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(effect),
    effect,
  });
}

/** A directory envelope as the Queue hands it to the Organization. */
let directorySequence = 0;
function directoryEnvelope(
  parentKind: "workstream" | "space",
  parentId: string,
  effect: ParentEffect,
  substreamId?: string,
): ParentEffectEnvelope {
  directorySequence += 1;
  return ParentEffectEnvelopeSchema.parse({
    kind: "parent_effect",
    contractVersion: 1,
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind,
    parentId,
    ...(substreamId ? { substreamId } : {}),
    generation: 1,
    messageId: `00000000-0000-7000-8000-${String(directorySequence).padStart(10, "0")}f9`,
    partitionKey: effect.kind === "directory_user" ? `user:${effect.userId}` : "common",
    sourceVersion: directorySequence,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(effect),
    effect,
  });
}

interface Rows {
  channels: number;
  viewers: { user_id: string; unread_count: number }[];
  feed: string[];
  outbox: string[];
  receipts: number;
}

function rows(state: DurableObjectState): Rows {
  const sql = state.storage.sql;
  return {
    channels: sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM channels WHERE workstream_id = ?", CHANNEL_ID).one().n,
    viewers: sql.exec<{ user_id: string; unread_count: number }>(
      "SELECT user_id, unread_count FROM channel_viewers WHERE workstream_id = ? ORDER BY user_id", CHANNEL_ID,
    ).toArray(),
    feed: sql.exec<{ dedupe_key: string }>(
      "SELECT dedupe_key FROM workspace_activity_events WHERE audience_workstream_id = ?", CHANNEL_ID,
    ).toArray().map((row) => row.dedupe_key),
    outbox: sql.exec<{ effect_kind: string }>(
      "SELECT effect_kind FROM parent_outbox WHERE parent_id = ? ORDER BY effect_kind", CHANNEL_ID,
    ).toArray().map((row) => row.effect_kind),
    receipts: sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM parent_child_receipts WHERE parent_id = ?", CHANNEL_ID,
    ).toArray()[0]?.n ?? 0,
  };
}

/** Make the object's own directory apply throw once it has run, at the end of the parent's transaction. */
function failAfterLocalApply(instance: unknown): () => void {
  const target = instance as { applyLocalEffects: (envelopes: unknown) => unknown };
  const original = target.applyLocalEffects;
  target.applyLocalEffects = function (this: unknown, envelopes: unknown) {
    original.call(this, envelopes);
    throw new Error("parent_write_failed_by_test");
  };
  return () => { target.applyLocalEffects = original; };
}

describe("a hosted parent's write", () => {
  it("commits its Channel row, viewer row and feed row with the parent change, or none of them", async () => {
    await parkActivityQueue();
    // The person is known, so their viewer row can land in the write itself.
    expect(await workspace().applyMemberStatus({
      workspaceId: WORKSPACE_ID, sequence: 1, removed: false, relationship: relationship(USER_ID),
    })).toEqual({ applied: true });

    await runInDurableObject(workspace(), async (instance, state) => {
      // A reservation that fails after its directory row was applied leaves
      // neither the parent nor the row.
      const restore = failAfterLocalApply(instance);
      const refused = await instance.reserveChild(reservation).then(() => null, (error: unknown) => error);
      restore();
      expect(String(refused)).toContain("parent_write_failed_by_test");
      expect(state.storage.sql.exec("SELECT parent_id FROM parent_metadata WHERE parent_id = ?", CHANNEL_ID).toArray())
        .toEqual([]);
      expect(rows(state).channels).toBe(0);

      // The creator's own viewer row lands with it.
      await instance.reserveChild(reservation);
      expect(rows(state)).toMatchObject({ channels: 1, viewers: [{ user_id: USER_ID, unread_count: 0 }], outbox: [] });

      // The same for a child's effects: the throw takes the parent's receipt
      // with the rows, so a redelivery is applied rather than acknowledged.
      const envelopes = [childEnvelope(1, viewerEffect(USER_ID, 2)), childEnvelope(2, activity)];
      const before = rows(state).receipts;
      const failed = failAfterLocalApply(instance);
      const thrown = await instance.receiveChildEffects({ substreamId: asSubstreamId("0"), envelopes })
        .then(() => null, (error: unknown) => error);
      failed();
      expect(String(thrown)).toContain("parent_write_failed_by_test");
      expect(rows(state)).toEqual({
        channels: 1, viewers: [{ user_id: USER_ID, unread_count: 0 }], feed: [], outbox: [], receipts: before,
      });

      await instance.receiveChildEffects({ substreamId: asSubstreamId("0"), envelopes });
      // Nothing waits in the outbox: the viewer and the feed row committed
      // with the parent's receipt.
      expect(rows(state)).toEqual({
        channels: 1,
        viewers: [{ user_id: USER_ID, unread_count: 2 }],
        feed: ["local-effects-activity"],
        outbox: [],
        receipts: before + envelopes.length,
      });
    });
  });

  it("forwards breakout human message metadata with no text or audience beyond the author", async () => {
    await parkActivityQueue();
    const message = (dedupeKey: string, targets: Array<{ userId: string; relation: string }>): ConversationEffect => ({
      ...activity,
      eventId: dedupeKey === "breakout-mention" ? "00000000-0000-7000-8000-000000000f21" : "00000000-0000-7000-8000-000000000f22",
      actorType: "user",
      actorUserId: USER_ID,
      actorLabel: "Avery",
      body: "The private plan, in the breakout",
      digestible: true,
      sourceKind: "workstream_message",
      sourceId: dedupeKey,
      dedupeKey,
      metadata: { substreamId: BREAKOUT_ID },
      targets,
    });
    await runInDurableObject(workspace(), async (instance, state) => {
      await instance.reserveChild(reservation);
      await instance.receiveChildEffects({
        substreamId: asSubstreamId(BREAKOUT_ID),
        envelopes: [
          childEnvelope(1, message("breakout-mention", [
            { userId: OTHER_USER_ID, relation: "mentioned" }, { userId: USER_ID, relation: "participant" },
          ]), BREAKOUT_ID),
          childEnvelope(2, message("breakout-chatter", [{ userId: USER_ID, relation: "participant" }]), BREAKOUT_ID),
          // Written by a breakout before producers stamped their id: the parent
          // stamps it, so it still lands as the author's alone.
          childEnvelope(3, { ...message("breakout-unstamped", [{ userId: OTHER_USER_ID, relation: "mentioned" }]),
            eventId: "00000000-0000-7000-8000-000000000f23", metadata: {} } as ConversationEffect, BREAKOUT_ID),
        ],
      });
      const sql = state.storage.sql;
      expect(sql.exec(`SELECT dedupe_key, body, digestible, audience_kind, audience_user_id, audience_workstream_id
                         FROM workspace_activity_events WHERE dedupe_key LIKE 'breakout-%'
                        ORDER BY dedupe_key`).toArray()).toEqual([{
        dedupe_key: "breakout-chatter", body: "", digestible: 0,
        audience_kind: "user", audience_user_id: USER_ID, audience_workstream_id: null,
      }, {
        dedupe_key: "breakout-mention", body: "", digestible: 0,
        audience_kind: "user", audience_user_id: USER_ID, audience_workstream_id: null,
      }, {
        dedupe_key: "breakout-unstamped", body: "", digestible: 0,
        audience_kind: "user", audience_user_id: USER_ID, audience_workstream_id: null,
      }]);
      expect(sql.exec(`SELECT target.user_id, target.relation FROM workspace_activity_event_targets target
                         JOIN workspace_activity_events event ON event.event_id = target.event_id
                        WHERE event.dedupe_key = 'breakout-mention'`).toArray())
        .toEqual([{ user_id: OTHER_USER_ID, relation: "mentioned" }]);
    });
  });

  it("refuses a malformed child delivery, naming the field, before it writes anything", async () => {
    const unknownParent = "00000000-0000-7000-8000-000000000f07";
    const malformed: Record<string, unknown> = { ...childEnvelope(1, activity), parentId: unknownParent };
    delete malformed.effect;
    const refused = await workspace().receiveChildEffects({
      substreamId: asSubstreamId("0"),
      envelopes: [malformed as unknown as ReturnType<typeof childEnvelope>],
    }).then(() => null, (error: unknown) => error);
    expect(String(refused)).toContain("envelopes.0.effect");
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT parent_id FROM parent_metadata WHERE parent_id = ?", unknownParent).toArray())
        .toEqual([]);
    });
  });

  it("keeps a follow-up it cannot read as failed, and never runs it", async () => {
    await runInDurableObject(workspace(), async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO workspace_directory_followups (followup_json, attempts, not_before, created_at)
         VALUES (?, 0, 0, 0)`,
        JSON.stringify({ workspaceId: WORKSPACE_ID, publishSnapshotAll: "yes" }),
      );
      const target = instance as unknown as {
        runDirectoryFollowUps(ids: number[]): Promise<void>;
        dueDirectoryFollowUps(now: number): number[];
        nextDirectoryFollowUpDueAt(): number | null;
      };
      await target.runDirectoryFollowUps(target.dueDirectoryFollowUps(Date.now()));
      const kept = state.storage.sql.exec<{ state: string; attempts: number; last_error_code: string | null }>(
        "SELECT state, attempts, last_error_code FROM workspace_directory_followups",
      ).toArray();
      expect(kept).toMatchObject([{ state: "failed", attempts: 0 }]);
      expect(kept[0]!.last_error_code).toMatch(/^directory_followup_invalid:/u);
      // Not due again, so the alarm does not wake for it.
      expect(target.dueDirectoryFollowUps(Date.now())).toEqual([]);
      expect(target.nextDirectoryFollowUpDueAt()).toBeNull();
    });
  });

  it("keeps a follow-up that throws, and the alarm runs it", async () => {
    await parkActivityQueue();
    // Known, so the creator's viewer row lands in the reservation's own
    // write and the reservation records exactly one follow-up.
    await workspace().applyMemberStatus({
      workspaceId: WORKSPACE_ID, sequence: 1, removed: false, relationship: relationship(USER_ID),
    });
    await runInDurableObject(workspace(), async (instance, state) => {
      // A directory_common effect owes a terminal schedule refresh after the
      // commit; that refresh fails once.
      const target = instance as unknown as {
        refreshTerminalSchedule: () => Promise<void>;
        refreshFailing: boolean;
        refreshedAfterFailure: number;
      };
      const original = target.refreshTerminalSchedule.bind(target);
      target.refreshFailing = true;
      target.refreshedAfterFailure = 0;
      target.refreshTerminalSchedule = async () => {
        if (target.refreshFailing) throw new Error("refresh_failed_by_test");
        target.refreshedAfterFailure += 1;
        return original();
      };
      const before = Date.now();
      // The write is not failed for work its commit no longer depends on.
      await instance.reserveChild(reservation);
      expect(rows(state).channels).toBe(1);
      const kept = state.storage.sql.exec<{ followup_json: string; attempts: number; not_before: number }>(
        "SELECT followup_json, attempts, not_before FROM workspace_directory_followups",
      ).toArray();
      expect(kept).toHaveLength(1);
      expect(kept[0]!.attempts).toBe(1);
      expect(kept[0]!.not_before).toBeGreaterThan(before);
      expect(JSON.parse(kept[0]!.followup_json)).toMatchObject({ refreshTerminal: true });
      // Armed for it, so nothing else has to happen for it to run.
      expect(await state.storage.getAlarm()).not.toBeNull();
      // Due now rather than after the retry delay.
      state.storage.sql.exec("UPDATE workspace_directory_followups SET not_before = 0");
      target.refreshFailing = false;
      await state.storage.setAlarm(Date.now());
    });
    await vi.waitFor(() => runInDurableObject(workspace(), (instance, state) => {
      expect(state.storage.sql.exec("SELECT id FROM workspace_directory_followups").toArray()).toEqual([]);
      expect((instance as unknown as { refreshedAfterFailure: number }).refreshedAfterFailure).toBeGreaterThan(0);
    }), { timeout: 10_000, interval: 50 });
  });
});

describe("the Organization's member table", () => {
  it("drops a departing person's viewer rows in the event's transaction and ignores an older event", async () => {
    for (const [sequence, userId] of [[1, USER_ID], [2, OTHER_USER_ID]] as const) {
      await workspace().applyMemberStatus({
        workspaceId: WORKSPACE_ID, sequence, removed: false, relationship: relationship(userId),
      });
    }
    const common: ParentEffect = {
      kind: "directory_common", title: "Launch", description: "", preview: "", scope: "workspace", state: "idle",
      systemKind: null, lastActivityAt: "2026-09-24T00:00:00.000Z", completedAt: null, archivedAt: null,
      latestAttentionOrdinal: 0, unreadTrackingStartOrdinal: 0,
    } as ParentEffect;
    const envelopes = [
      directoryEnvelope("workstream", CHANNEL_ID, common),
      directoryEnvelope("workstream", CHANNEL_ID, common, BREAKOUT_ID),
      directoryEnvelope("space", SPACE_ID, common),
    ];
    for (const userId of [USER_ID, OTHER_USER_ID]) {
      envelopes.push(
        directoryEnvelope("workstream", CHANNEL_ID, viewerEffect(userId, 0)),
        directoryEnvelope("workstream", CHANNEL_ID, viewerEffect(userId, 0), BREAKOUT_ID),
        directoryEnvelope("space", SPACE_ID, viewerEffect(userId, 0)),
      );
    }
    await workspace().applyWorkstreamDirectoryEffects({ workspaceId: WORKSPACE_ID, envelopes });
    const viewers = () => runInDurableObject(workspace(), (_instance, state) => Object.fromEntries(
      (["channel_viewers", "breakout_viewers", "space_viewers"] as const).map((table) => [table, state.storage.sql.exec<{
        user_id: string;
      }>(`SELECT user_id FROM ${table} ORDER BY user_id`).toArray().map((row) => row.user_id)]),
    ));
    const both = [USER_ID, OTHER_USER_ID].sort();
    expect(await viewers()).toEqual({ channel_viewers: both, breakout_viewers: both, space_viewers: both });

    // An event older than the one the table holds is not applied: it would
    // take the person out on a relationship that has since moved on.
    expect(await workspace().applyMemberStatus({
      workspaceId: WORKSPACE_ID, sequence: 1, removed: true, relationship: relationship(OTHER_USER_ID),
    })).toEqual({ applied: false });
    expect(await viewers()).toEqual({ channel_viewers: both, breakout_viewers: both, space_viewers: both });

    expect(await workspace().applyMemberStatus({
      workspaceId: WORKSPACE_ID, sequence: 3, removed: true, relationship: relationship(OTHER_USER_ID),
    })).toEqual({ applied: true });
    expect(await viewers()).toEqual({ channel_viewers: [USER_ID], breakout_viewers: [USER_ID], space_viewers: [USER_ID] });
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT active, sequence, relationship_json FROM workspace_member_status WHERE user_id = ?", OTHER_USER_ID,
      ).one()).toEqual({ active: 0, sequence: 3, relationship_json: null });
    });
  });

  /**
   * Count what the object asks D1 about a person's membership, from here on.
   * The Activity push's device read names the member table too, but learns
   * nobody's relationship, so it is not one of these.
   */
  function countMemberReads(instance: unknown): string[] {
    const target = instance as { env: Env };
    const reads: string[] = [];
    const database = target.env.DB;
    target.env = new Proxy(target.env, {
      get: (current, property, receiver) => property === "DB"
        ? new Proxy(database, {
          get: (db, key) => key === "prepare"
            ? (query: string) => {
              if (query.includes("workspace_members") && !query.includes("user_push_devices")) reads.push(query);
              return db.prepare(query);
            }
            : Reflect.get(db, key),
        })
        : Reflect.get(current, property, receiver),
    });
    return reads;
  }

  it("learns a viewer a child effect names with one D1 read before the transaction, and the row lands in the write", async () => {
    await parkActivityQueue();
    await workspace().applyMemberStatus({
      workspaceId: WORKSPACE_ID, sequence: 1, removed: false, relationship: relationship(USER_ID),
    });
    await workspace().reserveChild(reservation);
    // Not the creator, whom the table knows and whose row the reservation carried.
    await runInDurableObject(workspace(), async (instance, state) => {
      const reads = countMemberReads(instance);
      await instance.receiveChildEffects({
        substreamId: asSubstreamId("0"),
        envelopes: [childEnvelope(1, viewerEffect(OTHER_USER_ID, 5))],
      });
      expect(reads).toHaveLength(1);
      expect(rows(state)).toMatchObject({
        viewers: [{ user_id: USER_ID }, { user_id: OTHER_USER_ID, unread_count: 5 }]
          .sort((a, b) => a.user_id.localeCompare(b.user_id)),
        outbox: [],
      });
      expect(state.storage.sql.exec(
        "SELECT active, sequence FROM workspace_member_status WHERE user_id = ?", OTHER_USER_ID,
      ).toArray()).toEqual([{ active: 1, sequence: 0 }]);

      // Recorded, so their next row lands with no D1 read.
      await instance.receiveChildEffects({
        substreamId: asSubstreamId("0"),
        envelopes: [childEnvelope(2, viewerEffect(OTHER_USER_ID, 6))],
      });
      expect(reads).toHaveLength(1);
      expect(rows(state).viewers).toContainEqual({ user_id: OTHER_USER_ID, unread_count: 6 });
      expect(rows(state).outbox).toEqual([]);
    });
  });

  it("rolls back a write that meets somebody it has never heard of, learns them, and runs the write once more", async () => {
    await parkActivityQueue();
    await runInDurableObject(workspace(), async (instance, state) => {
      const reads = countMemberReads(instance);
      // The creator's viewer row is published inside the reservation's own
      // transaction, and nobody told the table about this person first.
      await instance.reserveChild({ ...reservation, createdByUserId: OTHER_USER_ID });
      expect(reads).toHaveLength(1);
      expect(rows(state)).toMatchObject({ channels: 1, viewers: [{ user_id: OTHER_USER_ID, unread_count: 0 }], outbox: [] });
      expect(state.storage.sql.exec(
        "SELECT created_by_user_id FROM channels WHERE workstream_id = ?", CHANNEL_ID,
      ).toArray()).toEqual([{ created_by_user_id: OTHER_USER_ID }]);
    });
  });
});
