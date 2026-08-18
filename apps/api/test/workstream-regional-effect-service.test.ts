import { afterEach, describe, expect, it, vi } from "vitest";

import {
  workstreamRegionalEffectWakeMessage,
  workstreamRegionalEffectHash,
  type WorkstreamRegionalEffect,
  type WorkstreamRegionalEffectEnvelope,
} from "../src/durable-objects/workstream-regional-effect";
import {
  consumeActivityQueue,
} from "../src/queues/activity-consumer";
import {
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

function workspaceSyncNamespace() {
  return createCloudflareTestBinding<DurableObjectNamespace>({
    idFromName: () => createTestDurableObjectId("workspace-sync"),
    get: () => ({
      initializeWorkspace: vi.fn(async () => undefined),
      publishSync: vi.fn(async () => 1),
      notificationDirectoryState: vi.fn(async () => ({
        authorityGeneration: 1,
        viewerVersion: 1,
        listable: true,
        title: "Regional effects",
        emailAddress: "regional-effects@example.com",
      })),
    }),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("the WorkstreamDO regional effect inbox", () => {
  it("routes an opaque directory wake-up through Queue into WorkspaceDO and acknowledges the child outbox", async () => {
    const database = seedAuthority();
    const common: WorkstreamRegionalEffect = {
      kind: "directory_common",
      title: "Queue-delivered state",
      description: "Latest-state workspace projection",
      preview: "",
      scope: "workspace",
      state: "running",
      systemKind: null,
      lastActivityAt: AT,
      completedAt: null,
      archivedAt: null,
    };
    const envelope = message(common, {
      messageId: MESSAGE_ID,
      partitionKey: "common",
      sourceVersion: 7,
    });
    const loadRegionalEffect = vi.fn(async () => envelope);
    const acknowledgeRegionalEffect = vi.fn(async () => true);
    const applyWorkstreamDirectoryEffects = vi.fn(async () => ({
      accepted: [{ messageId: envelope.messageId, payloadHash: envelope.payloadHash }],
      directoryChanged: true,
    }));
    const workstreams = createCloudflareTestBinding<DurableObjectNamespace>({
      idFromName: () => createTestDurableObjectId("queue-workstream"),
      get: () => ({ loadRegionalEffect, acknowledgeRegionalEffect }),
    });
    const workspaces = createCloudflareTestBinding<DurableObjectNamespace>({
      idFromName: () => createTestDurableObjectId("queue-workspace"),
      get: () => ({ applyWorkstreamDirectoryEffects }),
    });
    const env = createTestEnv({
      DB: sqliteD1(database),
      APP_ENV: "test",
      AVALON_REGION: "global",
      WORKSTREAM_DOS: workstreams,
      WORKSPACE_DOS: workspaces,
    });
    const ack = vi.fn();
    const retry = vi.fn();
    const queueMessage = {
      id: "directory-wake",
      timestamp: new Date(AT),
      body: workstreamRegionalEffectWakeMessage(envelope),
      attempts: 1,
      ack,
      retry,
    } satisfies Message<unknown>;
    try {
      await consumeActivityQueue({
        messages: [queueMessage],
        queue: "activity",
        metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } satisfies MessageBatch<unknown>, env);

      expect(loadRegionalEffect).toHaveBeenCalledOnce();
      expect(applyWorkstreamDirectoryEffects).toHaveBeenCalledWith({
        workspaceId: WORKSPACE_ID,
        envelopes: [envelope],
      });
      expect(acknowledgeRegionalEffect).toHaveBeenCalledWith({
        messageId: envelope.messageId,
        payloadHash: envelope.payloadHash,
      });
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM workstream_regional_effect_receipts`,
      ).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

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
    const loadRegionalEffect = vi.fn(async () => envelope);
    const objectId = createTestDurableObjectId("effect-object");
    const rooms = createCloudflareTestBinding<DurableObjectNamespace>({
      idFromName: vi.fn(() => objectId),
      get: vi.fn(() => ({ loadRegionalEffect })),
    });
    const env = createTestEnv({
      APP_ENV: "test",
      AVALON_REGION: "global",
      WORKSTREAM_DOS: rooms,
    });

    expect(wake).not.toHaveProperty("effect");
    await expect(loadWorkstreamRegionalEffect(env, wake)).resolves.toEqual(envelope);
    expect(loadRegionalEffect).toHaveBeenCalledOnce();
  });

  it("rejects workspace-owned directory effects from the regional Queue consumer", async () => {
    const database = seedAuthority();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      WORKSPACE_DOS: workspaceSyncNamespace(),
    });
    try {
      const common: WorkstreamRegionalEffect = {
        kind: "directory_common",
        title: "Workspace-owned",
        description: "This belongs in WorkspaceDO",
        preview: "",
        scope: "workspace",
        state: "running",
        systemKind: null,
        lastActivityAt: AT,
        completedAt: null,
        archivedAt: null,
      };
      const commonMessage = message(common, {
        messageId: "common-v1",
        partitionKey: "common",
        sourceVersion: 1,
      });
      await expect(applyWorkstreamRegionalEffect(env, commonMessage))
        .rejects.toThrow("workspace_owned_effect_misdirected_to_regional_queue");
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM workstream_regional_effect_receipts`,
      ).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("stores activity and mention intents, then erases notification content after delivery", async () => {
    const database = seedAuthority();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      WORKSPACE_DOS: workspaceSyncNamespace(),
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
