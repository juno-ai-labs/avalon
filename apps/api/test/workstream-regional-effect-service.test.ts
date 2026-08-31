import { asWorkspaceId, asWorkstreamId, type WorkstreamId } from "@rally/contracts";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isPersonNotificationEffect,
  WorkstreamRegionalEffectEnvelopeSchema,
  WorkstreamRegionalEffectSchema,
  workstreamRegionalEffectWakeMessage,
  workstreamRegionalEffectHash,
  type WorkstreamRegionalEffect,
  type WorkstreamRegionalEffectEnvelope,
} from "../src/durable-objects/workstream-regional-effect";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import { WorkspaceRegionalEffectApplyRequestSchema } from "../src/durable-objects/workspace-directory-protocol";
import { applyWorkstreamRegionalEnvelope } from "../src/durable-objects/workspace-regional-effect-storage";
import {
  claimWorkspaceNotificationIntent,
  reapSettledWorkspaceNotificationIntents,
  transitionWorkspaceNotificationIntent,
  workspaceNotificationIntentMaintenanceTarget,
} from "../src/durable-objects/workspace-notification-intent-storage";
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
import { createTestSqlStorage } from "./helpers/sql-storage";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const USER_ID = "00000000-0000-7000-8000-0000000000d1";
const AUTHOR_ID = "00000000-0000-7000-8000-0000000000d2";
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000000d3");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000000d4");
const MESSAGE_ID = "00000000-0000-7000-8000-0000000000d5";
const EVENT_ID = "00000000-0000-7000-8000-0000000000d6";
const AT = "2026-08-17T01:00:00.000Z";

function seedAuthority() {
  const database = preRetirementProductSqliteDatabase();
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
    workstreamId?: WorkstreamId;
  },
): WorkstreamRegionalEffectEnvelope {
  const requiredProjectionVersion = isPersonNotificationEffect(effect)
    ? input.requiredProjectionVersion ?? 1
    : null;
  return {
    kind: "workstream_regional_effect",
    contractVersion: 1,
    region: "global",
    workspaceId: WORKSPACE_ID,
    generation: 1,
    ...input,
    workstreamId: input.workstreamId ?? WORKSTREAM_ID,
    requiredProjectionVersion,
    payloadHash: workstreamRegionalEffectHash(effect, requiredProjectionVersion),
    effect,
  };
}

function workspaceSyncNamespace(listable = true) {
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
  const refreshSchedule = vi.fn(async (workspaceId?: string) => {
    void workspaceId;
    return { alarmAt: null };
  });
  const reapNotificationIntents = vi.fn(async (input: {
    workspaceId: string;
    limit: number;
  }) => reapSettledWorkspaceNotificationIntents(storage, input, Date.now()));
  const namespace = createCloudflareTestBinding<DurableObjectNamespace>({
    idFromName: () => createTestDurableObjectId("workspace-sync"),
    get: () => ({
      initializeWorkspace: vi.fn(async () => undefined),
      publishSync: vi.fn(async () => 1),
      // WorkspaceDO owns the workspace alarm, so every settle path now asks it
      // — not a separate scheduler object — to reconcile.
      refreshSchedule,
      applyWorkstreamRegionalEffect: vi.fn(async (input: unknown) =>
        applyWorkstreamRegionalEnvelope(
          storage,
          WorkspaceRegionalEffectApplyRequestSchema.parse(input),
          Date.now(),
        )),
      claimWorkstreamNotificationIntent: vi.fn(async (input: {
        workspaceId: string;
        intentId: string;
      }) => {
        const result = claimWorkspaceNotificationIntent(
          storage,
          input,
          crypto.randomUUID(),
          Date.now(),
        );
        if (result.outcome === "terminal") await refreshSchedule(input.workspaceId);
        return result;
      }),
      transitionWorkstreamNotificationIntent: vi.fn(async (input) => {
        const result = transitionWorkspaceNotificationIntent(storage, input, Date.now());
        if (input.transition === "settle") await refreshSchedule(input.workspaceId);
        return result;
      }),
      notificationIntentMaintenanceTarget: vi.fn(async (input: { workspaceId: string }) =>
        workspaceNotificationIntentMaintenanceTarget(storage, input.workspaceId)),
      reapSettledWorkstreamNotificationIntents: reapNotificationIntents,
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
        listable,
        title: "Regional effects",
        emailAddress: "regional-effects@example.com",
      })),
    }),
  });
  return { database, namespace, refreshSchedule, reapNotificationIntents };
}

afterEach(() => vi.restoreAllMocks());

describe("the WorkstreamDO regional effect inbox", () => {
  it("keeps suggestion feedback receiver-only during a rolling deployment", () => {
    const effect = {
      kind: "suggestion_feedback" as const,
      actionId: "00000000-0000-7000-8000-0000000000e1",
      activityId: "00000000-0000-7000-8000-0000000000e2",
      source: "contextual_routing" as const,
      status: "dismissed" as const,
      resolvedAt: AT,
      resolvedByUserId: USER_ID,
    };
    expect(WorkstreamRegionalEffectSchema.safeParse(effect).success).toBe(false);
    expect(WorkstreamRegionalEffectEnvelopeSchema.safeParse({
      kind: "workstream_regional_effect",
      contractVersion: 1,
      region: "global",
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      generation: 1,
      messageId: "00000000-0000-7000-8000-0000000000e3",
      partitionKey: "suggestion:legacy",
      sourceVersion: 1,
      requiredProjectionVersion: null,
      payloadHash: workstreamRegionalEffectHash(effect),
      effect,
    }).success).toBe(true);
  });

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
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
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
      expect(info).toHaveBeenCalledWith(expect.objectContaining({
        event: "workstream_outbox_acknowledged",
        workspace_id: WORKSPACE_ID,
        workstream_id: WORKSTREAM_ID,
        message_id: MESSAGE_ID,
        effect_kind: "directory_common",
        removed: true,
        outcome: "deleted",
      }));
      expect(info).toHaveBeenCalledWith(expect.objectContaining({
        event: "workstream_regional_effect_terminal",
        message_id: MESSAGE_ID,
        effect_kind: "directory_common",
        reason: "directory_effect_acknowledged",
        outbox_acknowledged: true,
      }));
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
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      WORKSPACE_DOS: workspace.namespace,
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
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      await expect(
        processWorkstreamNotificationIntent(env, WORKSPACE_ID, mention.intentId),
      ).resolves.toBe("delivered");
      expect(workspace.database.prepare(
        `SELECT state, payload_json, attempts FROM workstream_notification_intents
          WHERE intent_id = ?`,
      ).get(mention.intentId)).toEqual({ state: "delivered", payload_json: null, attempts: 1 });
      expect(workspace.refreshSchedule).toHaveBeenCalledWith(WORKSPACE_ID);
      expect(info).toHaveBeenCalledWith(expect.objectContaining({
        event: "workstream_notification_terminal",
        workspace_id: WORKSPACE_ID,
        workstream_id: WORKSTREAM_ID,
        notification_intent_id: mention.intentId,
        recipient_user_id: USER_ID,
        outcome: "delivered",
        reason: "email_fallback_completed",
        delivery_channel: "email",
        slack_outcome: "skipped",
        email_outcome: "skipped",
      }));
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("stores a participant-added intent under its own kind and delivers it", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      WORKSPACE_DOS: workspace.namespace,
      APP_ENV: "test",
      PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    });
    try {
      const added: WorkstreamRegionalEffect = {
        kind: "participant_notification",
        intentId: `participant_added:${USER_ID}:0`,
        sourceId: `participant:${USER_ID}:0`,
        recipientUserId: USER_ID,
        actorUserId: AUTHOR_ID,
        actorNameSnapshot: "Author",
        workstreamTitleSnapshot: "Regional effects",
        workstreamObjectiveSnapshot: "Prove the second notification kind lands",
        titleIsProvisional: false,
        occurredAt: AT,
      };
      const applied = await applyWorkstreamRegionalEffect(env, message(added, {
        messageId: `notification:${added.intentId}`,
        partitionKey: `notification:${added.intentId}`,
        sourceVersion: 1,
      }));
      expect(applied.notificationIntentId).toBe(added.intentId);
      // The kind is what the delivery path branches on, and what the widened
      // CHECK in schema version 9 exists to admit: before it, this insert
      // failed the constraint rather than storing a row.
      expect(workspace.database.prepare(
        `SELECT notification_kind, source_message_id, state FROM workstream_notification_intents
          WHERE intent_id = ?`,
      ).get(added.intentId)).toEqual({
        notification_kind: "participant_added",
        source_message_id: added.sourceId,
        state: "pending",
      });

      await expect(
        processWorkstreamNotificationIntent(env, WORKSPACE_ID, added.intentId),
      ).resolves.toBe("delivered");
      expect(workspace.database.prepare(
        `SELECT state, payload_json FROM workstream_notification_intents WHERE intent_id = ?`,
      ).get(added.intentId)).toEqual({ state: "delivered", payload_json: null });
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("keeps one person's adds to two work streams as two intents", async () => {
    const database = seedAuthority();
    const secondWorkstreamId = "00000000-0000-7000-8000-0000000000e1";
    database.exec(`
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, next_sequence_number, last_activity_at, created_at, updated_at,
         do_identity_anchor)
      VALUES ('${secondWorkstreamId}', '${WORKSPACE_ID}', 'Second room', '', 'ad_hoc',
              '${AUTHOR_ID}', 'idle', 1, '${AT}', '${AT}', '${AT}', 1);
      INSERT OR REPLACE INTO workstream_authority_routes
        (workspace_id, workstream_id, generation, object_name, state, stage_index,
         source_cursor, source_fence_sequence, updated_at)
      VALUES ('${WORKSPACE_ID}', '${secondWorkstreamId}', 1,
              'global:${WORKSPACE_ID}:${secondWorkstreamId}', 'active', 0, 0, 0, '${AT}');
    `);
    const workspace = workspaceSyncNamespace();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      WORKSPACE_DOS: workspace.namespace,
      APP_ENV: "test",
      PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    });
    try {
      // The epoch is object-local and starts at zero in both rooms, while the
      // intents table and `workspace_activity_events.dedupe_key` are
      // workspace-wide — so an identity without the work stream in it makes
      // the second add a conflict that retries forever instead of delivering.
      const added = (
        workstreamId: WorkstreamId,
      ): Extract<WorkstreamRegionalEffect, { kind: "participant_notification" }> => ({
        kind: "participant_notification",
        intentId: `participant_added:${workstreamId}:${USER_ID}:0`,
        sourceId: `participant:${workstreamId}:${USER_ID}:0`,
        recipientUserId: USER_ID,
        actorUserId: AUTHOR_ID,
        actorNameSnapshot: "Author",
        workstreamTitleSnapshot: workstreamId === WORKSTREAM_ID ? "Regional effects" : "Second room",
        workstreamObjectiveSnapshot: "",
        titleIsProvisional: false,
        occurredAt: AT,
      });
      for (const workstreamId of [WORKSTREAM_ID, asWorkstreamId(secondWorkstreamId)]) {
        const effect = added(workstreamId);
        const applied = await applyWorkstreamRegionalEffect(env, message(effect, {
          messageId: `notification:${effect.intentId}`,
          partitionKey: `notification:${effect.intentId}`,
          sourceVersion: 1,
          workstreamId,
        }));
        expect(applied.notificationIntentId).toBe(effect.intentId);
      }
      expect(workspace.database.prepare(
        `SELECT COUNT(*) AS count FROM workstream_notification_intents
          WHERE recipient_user_id = ? AND notification_kind = 'participant_added'`,
      ).get(USER_ID)).toEqual({ count: 2 });
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("re-exposes a participant intent on replay, so a failed delivery is retried", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      WORKSPACE_DOS: workspace.namespace,
      APP_ENV: "test",
      PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    });
    try {
      const effect: WorkstreamRegionalEffect = {
        kind: "participant_notification",
        intentId: `participant_added:${WORKSTREAM_ID}:${USER_ID}:3`,
        sourceId: `participant:${WORKSTREAM_ID}:${USER_ID}:3`,
        recipientUserId: USER_ID,
        actorUserId: AUTHOR_ID,
        actorNameSnapshot: "Author",
        workstreamTitleSnapshot: "Regional effects",
        workstreamObjectiveSnapshot: "",
        titleIsProvisional: false,
        occurredAt: AT,
      };
      const envelope = message(effect, {
        messageId: `notification:${effect.intentId}`,
        partitionKey: `notification:${effect.intentId}`,
        sourceVersion: 1,
      });
      await applyWorkstreamRegionalEffect(env, envelope);
      // The redelivery a transient Slack or email failure produces. The
      // receipt makes it a replay; the caller still needs the intent id back,
      // or it acknowledges the effect and nothing is ever sent.
      const replayed = await applyWorkstreamRegionalEffect(env, envelope);
      expect(replayed.replayed).toBe(true);
      expect(replayed.notificationIntentId).toBe(effect.intentId);
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("logs an inactive recipient before acknowledging a notification effect without an intent", async () => {
    const database = seedAuthority();
    database.prepare(
      `UPDATE workspace_members SET status = 'suspended'
        WHERE workspace_id = ? AND user_id = ?`,
    ).run(WORKSPACE_ID, USER_ID);
    const workspace = workspaceSyncNamespace();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      WORKSPACE_DOS: workspace.namespace,
      APP_ENV: "test",
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const mention: WorkstreamRegionalEffect = {
      kind: "mention_notification",
      intentId: `mention:${MESSAGE_ID}:${USER_ID}:inactive`,
      messageId: MESSAGE_ID,
      recipientUserId: USER_ID,
      authorUserId: AUTHOR_ID,
      authorNameSnapshot: "Author",
      workstreamTitleSnapshot: "Regional effects",
      messageText: "Please review this",
      occurredAt: AT,
    };
    try {
      await expect(applyWorkstreamRegionalEffect(env, message(mention, {
        messageId: `notification:${MESSAGE_ID}:${USER_ID}:inactive`,
        partitionKey: `notification:${MESSAGE_ID}:${USER_ID}`,
        sourceVersion: 3,
      }))).resolves.toMatchObject({ notificationIntentId: null });
      expect(info).toHaveBeenCalledWith(expect.objectContaining({
        event: "workstream_notification_terminal",
        recipient_user_id: USER_ID,
        outcome: "skipped",
        reason: "recipient_inactive",
      }));
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("logs when current directory policy makes a notification recipient unlistable", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace(false);
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      WORKSPACE_DOS: workspace.namespace,
      APP_ENV: "test",
    });
    const mention: WorkstreamRegionalEffect = {
      kind: "mention_notification",
      intentId: `mention:${MESSAGE_ID}:${USER_ID}:unlistable`,
      messageId: MESSAGE_ID,
      recipientUserId: USER_ID,
      authorUserId: AUTHOR_ID,
      authorNameSnapshot: "Author",
      workstreamTitleSnapshot: "Regional effects",
      messageText: "Please review this",
      occurredAt: AT,
    };
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await applyWorkstreamRegionalEffect(env, message(mention, {
        messageId: `notification:${MESSAGE_ID}:${USER_ID}:unlistable`,
        partitionKey: `notification:${MESSAGE_ID}:${USER_ID}`,
        sourceVersion: 3,
      }));
      await expect(processWorkstreamNotificationIntent(env, WORKSPACE_ID, mention.intentId))
        .resolves.toBe("skipped");
      expect(info).toHaveBeenCalledWith(expect.objectContaining({
        event: "workstream_notification_terminal",
        notification_intent_id: mention.intentId,
        recipient_user_id: USER_ID,
        outcome: "skipped",
        reason: "recipient_not_listable",
      }));
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("skips telling somebody they added themselves", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      WORKSPACE_DOS: workspace.namespace,
      APP_ENV: "test",
      PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    });
    try {
      const added: WorkstreamRegionalEffect = {
        kind: "participant_notification",
        intentId: `participant_added:${USER_ID}:1`,
        sourceId: `participant:${USER_ID}:1`,
        recipientUserId: USER_ID,
        actorUserId: USER_ID,
        actorNameSnapshot: "Recipient",
        workstreamTitleSnapshot: "Regional effects",
        workstreamObjectiveSnapshot: "",
        titleIsProvisional: false,
        occurredAt: AT,
      };
      await applyWorkstreamRegionalEffect(env, message(added, {
        messageId: `notification:${added.intentId}`,
        partitionKey: `notification:${added.intentId}`,
        sourceVersion: 1,
      }));
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      await expect(
        processWorkstreamNotificationIntent(env, WORKSPACE_ID, added.intentId),
      ).resolves.toBe("skipped");
      expect(info).toHaveBeenCalledWith(expect.objectContaining({
        event: "workstream_notification_terminal",
        notification_intent_id: added.intentId,
        recipient_user_id: USER_ID,
        outcome: "skipped",
        reason: "self_notification",
      }));
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("reaps terminal mention shells only from their owning WorkspaceDO", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace();
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
      await expect(workspace.reapNotificationIntents({
        workspaceId: WORKSPACE_ID,
        limit: 10,
      })).resolves.toEqual({ reapedIntentIds: [intentId] });
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
