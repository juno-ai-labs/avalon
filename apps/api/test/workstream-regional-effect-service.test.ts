import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  workstreamRegionalEffectWakeMessage,
  workstreamRegionalEffectHash,
  type WorkstreamRegionalEffect,
  type WorkstreamRegionalEffectEnvelope,
} from "../src/durable-objects/workstream-regional-effect";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import { WorkspaceRegionalEffectApplyRequestSchema } from "../src/durable-objects/workspace-directory-protocol";
import { applyWorkstreamRegionalEnvelope } from "../src/durable-objects/workspace-regional-effect-storage";
import {
  consumeActivityQueue,
} from "../src/queues/activity-consumer";
import {
  applyWorkstreamRegionalEffect,
  loadWorkstreamRegionalEffect,
  processWorkstreamNotificationIntent,
  reapSettledWorkspaceNotificationIntents,
} from "../src/services/workstream-regional-effect-service";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";
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
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    for (const statement of migration.statements) database.exec(statement);
  }
  database.prepare(
    `INSERT INTO workspace_identity
       (id, workspace_id, region, placement_affinity, created_at, updated_at)
     VALUES (1, ?, 'global', 'wnam', 0, 0)`,
  ).run(WORKSPACE_ID);
  // The apply path runs the real object storage logic over this database, so
  // the receipt-with-effect transaction is exercised rather than stubbed.
  const storage = createCloudflareTestBinding<DurableObjectStorage>({
    transactionSync: (body: () => unknown) => body(),
    sql: createTestSqlStorage(database),
  });
  const namespace = createCloudflareTestBinding<DurableObjectNamespace>({
    idFromName: () => createTestDurableObjectId("workspace-sync"),
    get: () => ({
      initializeWorkspace: vi.fn(async () => undefined),
      publishSync: vi.fn(async () => 1),
      applyWorkstreamRegionalEffect: vi.fn(async (input: unknown) =>
        applyWorkstreamRegionalEnvelope(
          storage,
          WorkspaceRegionalEffectApplyRequestSchema.parse(input),
          Date.now(),
        )),
      executeRuntimeSql: vi.fn(async (input: {
        statements: Array<{ sql: string; params: Array<string | number | null> }>;
      }) => ({
        status: 200,
        bodyJson: JSON.stringify({
          results: input.statements.map((statement) => {
            const rows = database.prepare(statement.sql).all(
              ...statement.params as SQLInputValue[],
            ) as Array<Record<string, string | number | null>>;
            const changes = database.prepare("SELECT changes() AS changes").get() as { changes: number };
            return {
              columns: rows[0] ? Object.keys(rows[0]) : [],
              rows,
              changes: Number(changes.changes),
            };
          }),
        }),
      })),
      notificationDirectoryState: vi.fn(async () => ({
        authorityGeneration: 1,
        viewerVersion: 1,
        listable: true,
        title: "Regional effects",
        emailAddress: "regional-effects@example.com",
      })),
    }),
  });
  return { database, namespace };
}

afterEach(() => vi.restoreAllMocks());

describe("the WorkstreamDO regional effect inbox", () => {
  it("acknowledges effects from an authority generation superseded by re-cutover", async () => {
    const database = seedAuthority();
    database.prepare(
      `UPDATE workstream_authority_routes SET generation = 2 WHERE workstream_id = ?`,
    ).run(WORKSTREAM_ID);
    const env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "global" });
    const effect: WorkstreamRegionalEffect = {
      kind: "activity_event",
      eventId: EVENT_ID,
      eventType: "workstream.message.posted",
      subjectSequenceNumber: 1,
      actorType: "system",
      actorUserId: null,
      actorLabel: "Avalon",
      title: "Old generation",
      body: "Do not replay",
      canonicalUrl: null,
      digestible: false,
      occurredAt: AT,
      sourceKind: "message",
      sourceId: MESSAGE_ID,
      dedupeKey: `message:${MESSAGE_ID}`,
      metadata: {},
      targets: [],
    };
    try {
      await expect(applyWorkstreamRegionalEffect(env, message(effect, {
        messageId: `activity:${MESSAGE_ID}`,
        partitionKey: `activity:${MESSAGE_ID}`,
        sourceVersion: 1,
      }))).resolves.toEqual({ replayed: true, notificationIntentId: null });
    } finally {
      database.close();
    }
  });

  it("replays through the WorkspaceDO receipt without re-applying the effect", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      WORKSPACE_DOS: workspace.namespace,
    });
    const effect: WorkstreamRegionalEffect = {
      kind: "activity_event",
      eventId: EVENT_ID,
      eventType: "workstream.message.posted",
      subjectSequenceNumber: 1,
      actorType: "system",
      actorUserId: null,
      actorLabel: "Avalon",
      title: "Already applied",
      body: "Replay",
      canonicalUrl: null,
      digestible: false,
      occurredAt: AT,
      sourceKind: "message",
      sourceId: MESSAGE_ID,
      dedupeKey: `message:${MESSAGE_ID}`,
      metadata: {},
      targets: [],
    };
    const envelope = message(effect, {
      messageId: `activity:${MESSAGE_ID}`,
      partitionKey: `activity:${MESSAGE_ID}`,
      sourceVersion: 1,
    });
    try {
      await expect(applyWorkstreamRegionalEffect(env, envelope)).resolves.toEqual({
        replayed: false,
        notificationIntentId: null,
      });
      await expect(applyWorkstreamRegionalEffect(env, envelope)).resolves.toEqual({
        replayed: true,
        notificationIntentId: null,
      });
      expect(workspace.database.prepare(
        "SELECT COUNT(*) AS count FROM workspace_activity_events WHERE event_id = ?",
      ).get(EVENT_ID)).toEqual({ count: 1 });
      expect(workspace.database.prepare(
        "SELECT payload_hash FROM workspace_workstream_effect_receipts WHERE message_id = ?",
      ).get(envelope.messageId)).toEqual({ payload_hash: envelope.payloadHash });
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("rejects a replayed message id whose payload hash changed", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      WORKSPACE_DOS: workspace.namespace,
    });
    const effect: WorkstreamRegionalEffect = {
      kind: "activity_event",
      eventId: EVENT_ID,
      eventType: "workstream.message.posted",
      subjectSequenceNumber: 1,
      actorType: "system",
      actorUserId: null,
      actorLabel: "Avalon",
      title: "Conflicting content",
      body: "Original",
      canonicalUrl: null,
      digestible: false,
      occurredAt: AT,
      sourceKind: "message",
      sourceId: MESSAGE_ID,
      dedupeKey: `message:${MESSAGE_ID}`,
      metadata: {},
      targets: [],
    };
    const envelope = message(effect, {
      messageId: `activity:${MESSAGE_ID}`,
      partitionKey: `activity:${MESSAGE_ID}`,
      sourceVersion: 1,
    });
    workspace.database.prepare(
      `INSERT INTO workspace_workstream_effect_receipts
         (message_id, workstream_id, payload_hash, received_at)
       VALUES (?, ?, 'fnv1a64:0000000000000000', 0)`,
    ).run(envelope.messageId, WORKSTREAM_ID);
    try {
      await expect(applyWorkstreamRegionalEffect(env, envelope))
        .rejects.toThrow("workstream_effect_receipt_hash_conflict");
    } finally {
      database.close();
      workspace.database.close();
    }
  });


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
    const workspace = workspaceSyncNamespace();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      WORKSPACE_DOS: workspace.namespace,
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
      expect(workspace.database.prepare(
        `SELECT COUNT(*) AS count FROM workspace_workstream_effect_receipts`,
      ).get()).toEqual({ count: 0 });
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("stores activity and mention intent in WorkspaceDO, then erases delivered content", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace();
    const refreshScheduler = vi.fn(async () => ({ alarmAt: null }));
    const schedulers = createCloudflareTestBinding<DurableObjectNamespace>({
      idFromName: () => createTestDurableObjectId("workspace-scheduler"),
      get: () => ({ refresh: refreshScheduler }),
    });
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      WORKSPACE_DOS: workspace.namespace,
      WORKSPACE_SCHEDULERS: schedulers,
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
        `SELECT COUNT(*) AS count FROM activity_events WHERE id = ?`,
      ).get(EVENT_ID)).toEqual({ count: 0 });
      expect(workspace.database.prepare(
        `SELECT actor_user_id, audience_workstream_id FROM workspace_activity_events
          WHERE event_id = ?`,
      ).get(EVENT_ID)).toEqual({
        actor_user_id: AUTHOR_ID,
        audience_workstream_id: WORKSTREAM_ID,
      });
      expect(workspace.database.prepare(
        `SELECT relation FROM workspace_activity_event_targets WHERE event_id = ? AND user_id = ?`,
      ).get(EVENT_ID, USER_ID)).toEqual({ relation: "mentioned" });
      expect(workspace.database.prepare(
        `SELECT COUNT(*) AS count FROM workspace_workstream_effect_receipts`,
      ).get()).toEqual({ count: 1 });

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
      await expect(
        processWorkstreamNotificationIntent(env, WORKSPACE_ID, mention.intentId),
      ).resolves.toBe("delivered");
      expect(workspace.database.prepare(
        `SELECT state, payload_json, attempts FROM workstream_notification_intents
          WHERE intent_id = ?`,
      ).get(mention.intentId)).toEqual({ state: "delivered", payload_json: null, attempts: 1 });
      expect(refreshScheduler).toHaveBeenCalledWith(WORKSPACE_ID);
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("reaps terminal mention shells only from their owning WorkspaceDO", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      WORKSPACE_DOS: workspace.namespace,
    });
    const intentId = `mention:${MESSAGE_ID}:${USER_ID}:expired`;
    workspace.database.prepare(
      `INSERT INTO workstream_notification_intents
         (intent_id, workspace_id, workstream_id, recipient_user_id,
          source_message_id, source_generation, source_version,
          required_directory_version, notification_kind, payload_json,
          payload_hash, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, 1, 'mention', NULL, 'expired-hash',
               'delivered', 1, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
    ).run(intentId, WORKSPACE_ID, WORKSTREAM_ID, USER_ID, MESSAGE_ID);

    try {
      await expect(reapSettledWorkspaceNotificationIntents(env, WORKSPACE_ID, 10))
        .resolves.toBe(1);
      expect(workspace.database.prepare(
        "SELECT COUNT(*) AS count FROM workstream_notification_intents",
      ).get()).toEqual({ count: 0 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM workstream_notification_intents",
      ).get()).toEqual({ count: 0 });
    } finally {
      database.close();
      workspace.database.close();
    }
  });
});
