import { afterEach, describe, expect, it, vi } from "vitest";

import {
  workstreamRegionalEffectWakeMessage,
  workstreamRegionalEffectHash,
  type WorkstreamRegionalEffect,
  type WorkstreamRegionalEffectEnvelope,
} from "../src/durable-objects/workstream-regional-effect";
import {
  acknowledgeWorkstreamRegionalEffect,
  applyWorkstreamRegionalEffect,
  loadWorkstreamRegionalEffect,
  processWorkstreamNotificationIntent,
} from "../src/services/workstream-regional-effect-service";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const USER_ID = "00000000-0000-7000-8000-0000000000d1";
const AUTHOR_ID = "00000000-0000-7000-8000-0000000000d2";
const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000d3";
const WORKSTREAM_ID = "00000000-0000-7000-8000-0000000000d4";
const MESSAGE_ID = "00000000-0000-7000-8000-0000000000d5";
const EVENT_ID = "00000000-0000-7000-8000-0000000000d6";
const AT = "2026-08-17T01:00:00.000Z";

function seedAuthority() {
  const database = migratedSqliteDatabase();
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES
      ('${USER_ID}', 'effect-recipient', 'recipient@example.com', 'Recipient', '${AT}', '${AT}'),
      ('${AUTHOR_ID}', 'effect-author', 'author@example.com', 'Author', '${AT}', '${AT}');
    INSERT INTO workspaces
      (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Effects', 'effects', 'global', '${AUTHOR_ID}', '${AT}', '${AT}');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at) VALUES
      ('${WORKSPACE_ID}', '${USER_ID}', 'member', 'active', '${AT}'),
      ('${WORKSPACE_ID}', '${AUTHOR_ID}', 'owner', 'active', '${AT}');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
    VALUES ('${WORKSTREAM_ID}', '${WORKSPACE_ID}', 'Regional effects', '', 'ad_hoc',
            '${AUTHOR_ID}', 'idle', 1, '${AT}', '${AT}', '${AT}');
    UPDATE workstream_authority_control
       SET phase = 'maintenance_draining', generation = 1, updated_at = '${AT}'
     WHERE id = 1;
    UPDATE workstream_authority_control
       SET phase = 'maintenance_importing', updated_at = '${AT}'
     WHERE id = 1;
    UPDATE workstream_authority_routes SET state = 'active'
     WHERE workstream_id = '${WORKSTREAM_ID}';
  `);
  return database;
}

function message(
  effect: WorkstreamRegionalEffect,
  input: {
    messageId: string;
    partitionKey: string;
    sourceVersion: number;
    requiredProjectionVersion?: number;
  },
): WorkstreamRegionalEffectEnvelope {
  const requiredProjectionVersion = effect.kind === "mention_notification"
    ? input.requiredProjectionVersion ?? 1
    : null;
  return {
    kind: "workstream_regional_effect",
    contractVersion: 1,
    region: "global",
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    generation: 1,
    ...input,
    requiredProjectionVersion,
    payloadHash: workstreamRegionalEffectHash(effect, requiredProjectionVersion),
    effect,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("the WorkstreamDO regional effect inbox", () => {
  it("uses an opaque Queue wake-up and fetches the payload from the regional object", async () => {
    const effect: WorkstreamRegionalEffect = {
      kind: "directory_common",
      title: "Not in Queue",
      description: "The object retains this payload",
      preview: "",
      scope: "workspace",
      state: "running",
      systemKind: null,
      lastActivityAt: AT,
      completedAt: null,
      archivedAt: null,
    };
    const envelope = message(effect, {
      messageId: "opaque-common-v1",
      partitionKey: "common",
      sourceVersion: 1,
    });
    const wake = workstreamRegionalEffectWakeMessage(envelope);
    const fetch = vi.fn(async () => Response.json(envelope));
    const objectId = createTestDurableObjectId("effect-object");
    const rooms = createCloudflareTestBinding<DurableObjectNamespace>({
      idFromName: vi.fn(() => objectId),
      get: vi.fn(() => ({ fetch })),
    });
    const env = createTestEnv({ WORKSTREAM_DOS: rooms });

    expect(wake).not.toHaveProperty("effect");
    await expect(loadWorkstreamRegionalEffect(env, wake)).resolves.toEqual(envelope);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps the newest common and user sidebar projections under unordered replay", async () => {
    const database = seedAuthority();
    const env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "global" });
    try {
      const older: WorkstreamRegionalEffect = {
        kind: "directory_common",
        title: "Older",
        description: "Older description",
        preview: "",
        scope: "workspace",
        state: "running",
        systemKind: null,
        lastActivityAt: AT,
        completedAt: null,
        archivedAt: null,
      };
      const newer: WorkstreamRegionalEffect = { ...older, title: "Newest", state: "completed" };
      const newerMessage = message(newer, {
        messageId: "common-v2",
        partitionKey: "common",
        sourceVersion: 2,
      });
      await applyWorkstreamRegionalEffect(env, newerMessage);
      await applyWorkstreamRegionalEffect(env, message(older, {
        messageId: "common-v1",
        partitionKey: "common",
        sourceVersion: 1,
      }));

      expect(database.prepare(
        `SELECT version, title, state FROM workstream_directory_projections
          WHERE workstream_id = ?`,
      ).get(WORKSTREAM_ID)).toEqual({ version: 2, title: "Newest", state: "completed" });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM workstream_regional_effect_receipts`,
      ).get()).toEqual({ count: 2 });

      const userEffect: WorkstreamRegionalEffect = {
        kind: "directory_user",
        userId: USER_ID,
        isParticipant: true,
        unreadCount: 3,
        youAreMentioned: true,
        listable: true,
      };
      const userMessage = message(userEffect, {
        messageId: "user-v1",
        partitionKey: `user:${USER_ID}`,
        sourceVersion: 1,
      });
      await expect(applyWorkstreamRegionalEffect(env, userMessage)).resolves.toEqual({
        replayed: false,
        notificationIntentId: null,
      });
      await expect(applyWorkstreamRegionalEffect(env, userMessage)).resolves.toEqual({
        replayed: true,
        notificationIntentId: null,
      });
      expect(database.prepare(
        `SELECT unread_count, you_are_mentioned
           FROM workstream_directory_user_projections
          WHERE workstream_id = ? AND user_id = ?`,
      ).get(WORKSTREAM_ID, USER_ID)).toEqual({ unread_count: 3, you_are_mentioned: 1 });

      database.prepare(
        `UPDATE workspace_members SET status = 'suspended'
          WHERE workspace_id = ? AND user_id = ?`,
      ).run(WORKSPACE_ID, USER_ID);
      await applyWorkstreamRegionalEffect(env, message({
        ...userEffect,
        unreadCount: 4,
      }, {
        messageId: "user-v2-after-revocation",
        partitionKey: `user:${USER_ID}`,
        sourceVersion: 2,
      }));
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM workstream_directory_user_projections
          WHERE workstream_id = ? AND user_id = ?`,
      ).get(WORKSTREAM_ID, USER_ID)).toEqual({ count: 0 });

      const revokedMention = message({
        kind: "mention_notification",
        intentId: `mention:${MESSAGE_ID}:${USER_ID}`,
        messageId: MESSAGE_ID,
        recipientUserId: USER_ID,
        authorUserId: AUTHOR_ID,
        authorNameSnapshot: "Author",
        workstreamTitleSnapshot: "Regional effects",
        messageText: "No longer visible",
        occurredAt: AT,
      }, {
        messageId: "notification-after-revocation",
        partitionKey: `notification:${MESSAGE_ID}:${USER_ID}`,
        sourceVersion: 3,
      });
      await expect(applyWorkstreamRegionalEffect(env, revokedMention)).resolves.toEqual({
        replayed: false,
        notificationIntentId: null,
      });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM workstream_notification_intents`,
      ).get()).toEqual({ count: 0 });

      const objectId = createTestDurableObjectId("effect-ack-object");
      const rooms = createCloudflareTestBinding<DurableObjectNamespace>({
        idFromName: vi.fn(() => objectId),
        get: vi.fn(() => ({ fetch: vi.fn(async () => Response.json({ ok: true })) })),
      });
      await acknowledgeWorkstreamRegionalEffect(createTestEnv({
        DB: sqliteD1(database),
        WORKSTREAM_DOS: rooms,
      }), newerMessage);
      expect(database.prepare(
        `SELECT acknowledged_at IS NOT NULL AS acknowledged
           FROM workstream_regional_effect_receipts WHERE message_id = ?`,
      ).get(newerMessage.messageId)).toEqual({ acknowledged: 1 });
    } finally {
      database.close();
    }
  });

  it("stores activity and mention intents, then erases notification content after delivery", async () => {
    const database = seedAuthority();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      APP_ENV: "test",
      PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    });
    try {
      const activity: WorkstreamRegionalEffect = {
        kind: "activity_event",
        eventId: EVENT_ID,
        eventType: "workstream.message.posted",
        subjectSequenceNumber: 3,
        actorType: "user",
        actorUserId: AUTHOR_ID,
        actorLabel: "Author",
        title: "Regional effects",
        body: "Please review this",
        canonicalUrl: "https://with-avalon.com/app/workstreams/00000000-0000-7000-8000-0000000000d4",
        digestible: true,
        occurredAt: AT,
        sourceKind: "message",
        sourceId: MESSAGE_ID,
        dedupeKey: `message:${MESSAGE_ID}`,
        metadata: {},
        targets: [{ userId: USER_ID, relation: "mentioned" }],
      };
      await applyWorkstreamRegionalEffect(env, message(activity, {
        messageId: `activity:${MESSAGE_ID}`,
        partitionKey: `activity:${MESSAGE_ID}`,
        sourceVersion: 3,
      }));
      expect(database.prepare(
        `SELECT event_type, audience_kind, audience_workstream_id FROM activity_events
          WHERE id = ?`,
      ).get(EVENT_ID)).toEqual({
        event_type: "workstream.message.posted",
        audience_kind: "workstream",
        audience_workstream_id: WORKSTREAM_ID,
      });

      const mention: WorkstreamRegionalEffect = {
        kind: "mention_notification",
        intentId: `mention:${MESSAGE_ID}:${USER_ID}`,
        messageId: MESSAGE_ID,
        recipientUserId: USER_ID,
        authorUserId: AUTHOR_ID,
        authorNameSnapshot: "Author",
        workstreamTitleSnapshot: "Regional effects",
        messageText: "Please review this",
        occurredAt: AT,
      };
      const viewer: WorkstreamRegionalEffect = {
        kind: "directory_user",
        userId: USER_ID,
        isParticipant: true,
        unreadCount: 1,
        youAreMentioned: true,
        listable: true,
      };
      await applyWorkstreamRegionalEffect(env, message(viewer, {
        messageId: `viewer:${MESSAGE_ID}:${USER_ID}`,
        partitionKey: `user:${USER_ID}`,
        sourceVersion: 1,
      }));
      const applied = await applyWorkstreamRegionalEffect(env, message(mention, {
        messageId: `notification:${MESSAGE_ID}:${USER_ID}`,
        partitionKey: `notification:${MESSAGE_ID}:${USER_ID}`,
        sourceVersion: 3,
      }));
      expect(applied.notificationIntentId).toBe(mention.intentId);
      await expect(processWorkstreamNotificationIntent(env, mention.intentId)).resolves.toBe("delivered");
      expect(database.prepare(
        `SELECT state, payload_json, attempts FROM workstream_notification_intents
          WHERE intent_id = ?`,
      ).get(mention.intentId)).toEqual({ state: "delivered", payload_json: null, attempts: 1 });
    } finally {
      database.close();
    }
  });
});
