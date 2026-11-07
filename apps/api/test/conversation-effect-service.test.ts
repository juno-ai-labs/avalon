import "../../../tests/isolated-region";
import { asAutomationId, asSubstreamId, asWorkspaceId, asWorkstreamId, DEFAULT_MEMBER_PREFERENCES, DEFAULT_NOTIFICATION_CHANNELS, type NotificationChannel, type WorkstreamId } from "@rally/contracts";
import {
  conversationEffectHash,
  isPersonNotificationEffect,
  type ConversationEffect,
  type ConversationEffectEnvelope,
  type ParentEffect,
  type ParentEffectEnvelope,
} from "@rally/contracts/conversation-effects";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import {
  claimWorkspaceNotificationIntent,
  reapSettledWorkspaceNotificationIntents,
  recordPersonNotificationIntent,
  transitionWorkspaceNotificationIntent,
  workspaceNotificationIntentMaintenanceTarget,
  type PersonNotificationEnvelope,
} from "../src/durable-objects/workspace-notification-intent-storage";
import { consumeActivityQueue } from "../src/queues/activity-consumer";
import { workspaceConnectorEventQueueMessage } from "../src/services/workspace-connector-event-ingress";
import { processWorkstreamNotificationIntent } from "../src/services/conversation-effect-service";
import type { Env } from "../src/env";
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
const AUTOMATION_ID = asAutomationId("00000000-0000-7000-8000-0000000000d7");
const RUN_ID = "00000000-0000-7000-8000-0000000000d8";
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

/** A parent's effect, addressed to the workspace. */
function message(
  effect: ParentEffect,
  input: {
    messageId: string;
    partitionKey: string;
    sourceVersion: number;
    requiredProjectionVersion?: number;
    parentId?: string;
    parentKind?: "workstream" | "automation";
  },
): ParentEffectEnvelope {
  const requiredProjectionVersion = isPersonNotificationEffect(effect)
    ? input.requiredProjectionVersion ?? 1
    : null;
  return {
    kind: "parent_effect",
    contractVersion: 1,
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: input.parentKind ?? "workstream",
    parentId: input.parentId ?? WORKSTREAM_ID,
    generation: 1,
    messageId: input.messageId,
    partitionKey: input.partitionKey,
    sourceVersion: input.sourceVersion,
    requiredProjectionVersion,
    payloadHash: conversationEffectHash(effect, requiredProjectionVersion),
    effect,
  };
}

/** A child conversation's effect, addressed to its parent. */
function childMessage(
  effect: ConversationEffect,
  input: {
    messageId: string;
    parentKind: "workstream" | "automation" | "canvas";
    parentId: string;
    substreamId?: string;
  },
): ConversationEffectEnvelope {
  const requiredProjectionVersion = isPersonNotificationEffect(effect) ? 1 : null;
  return {
    kind: "conversation_effect",
    contractVersion: 1,
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: input.parentKind,
    parentId: input.parentId,
    substreamId: asSubstreamId(input.substreamId ?? "0"),
    generation: 1,
    messageId: input.messageId,
    partitionKey: "common",
    sourceVersion: 1,
    requiredProjectionVersion,
    payloadHash: conversationEffectHash(effect, requiredProjectionVersion),
    effect,
  };
}

function directoryCommon(title = "Queue-delivered state"): Extract<ParentEffect, { kind: "directory_common" }> {
  return {
    kind: "directory_common",
    title,
    description: "Latest-state workspace projection",
    preview: "",
    scope: "workspace",
    state: "running",
    systemKind: null,
    lastActivityAt: AT,
    completedAt: null,
    archivedAt: null,
  };
}

/** A mention or an add, as a conversation sends one to its parent. */
type PersonEffect = Extract<ConversationEffect, { kind: "mention_notification" | "participant_notification" }>;

function mentionEffect(suffix = ""): Extract<PersonEffect, { kind: "mention_notification" }> {
  return {
    kind: "mention_notification",
    intentId: `mention:${MESSAGE_ID}:${USER_ID}${suffix}`,
    messageId: MESSAGE_ID,
    recipientUserId: USER_ID,
    authorUserId: AUTHOR_ID,
    authorNameSnapshot: "Author",
    workstreamTitleSnapshot: "Regional effects",
    messageText: "Please review this",
    occurredAt: AT,
  };
}

/** One Queue message and the two verdicts the consumer can give it. */
function queued(body: unknown, attempts = 1) {
  const ack = vi.fn();
  const retry = vi.fn();
  const queueMessage = {
    id: "effect",
    timestamp: new Date(AT),
    body,
    attempts,
    ack,
    retry,
  } satisfies Message<unknown>;
  const batch = {
    messages: [queueMessage],
    queue: "activity",
    metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
    retryAll: vi.fn(),
    ackAll: vi.fn(),
  } satisfies MessageBatch<unknown>;
  return { batch, ack, retry };
}

/**
 * The Organization object hosting a work stream parent: the workspace double,
 * plus the one contract method the consumer calls on the parent it hosts.
 */
function hostingWorkstreamParent(
  workspace: DurableObjectNamespace,
  receiveChildEffects: (input: unknown) => Promise<unknown>,
): Env["WORKSPACE_DOS"] {
  return createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
    idFromName: (name: string) => workspace.idFromName(name),
    get: (id: DurableObjectId) => ({ ...workspace.get(id), receiveChildEffects }),
  });
}

function workspaceSyncNamespace(listable = true, mentionChannels: NotificationChannel[] = ["push", "slack_agent_dm", "email"],
  parentKind: "canvas" | null = "canvas") {
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
  const claimWorkstreamNotificationIntent = vi.fn(async (input: {
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
  });
  const applyWorkstreamDirectoryEffects = vi.fn(async (input: { envelopes: ParentEffectEnvelope[] }) => ({
    accepted: input.envelopes.map((envelope) => ({
      messageId: envelope.messageId,
      payloadHash: envelope.payloadHash,
    })),
    directoryChanged: true,
  }));
  const namespace = createCloudflareTestBinding<DurableObjectNamespace>({
    idFromName: () => createTestDurableObjectId("workspace-sync"),
    get: () => ({
      initializeWorkspace: vi.fn(async () => undefined),
      publishSync: vi.fn(async () => 1),
      // WorkspaceDO owns the workspace alarm, so every settle path asks it,
      // not a separate scheduler object, to reconcile.
      refreshSchedule,
      applyWorkstreamDirectoryEffects,
      claimWorkstreamNotificationIntent,
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
        listable,
        title: "Regional effects",
        emailAddress: "regional-effects@example.com",
      })),
      // The conversation is a Canvas's Chat, so each transport carries its link.
      resolveHostedParent: vi.fn(async () => (parentKind ? { kind: parentKind, authority: { exists: true } } : { kind: null })),
      // Every channel chosen, so each transport's path runs.
      memberPreferences: vi.fn(async () => ({
        ...DEFAULT_MEMBER_PREFERENCES,
        notify: { ...DEFAULT_NOTIFICATION_CHANNELS, mentions: mentionChannels, added: ["push", "slack_agent_dm", "email"] },
      })),
    }),
  });
  return {
    database,
    storage,
    namespace,
    refreshSchedule,
    reapNotificationIntents,
    claimWorkstreamNotificationIntent,
    applyWorkstreamDirectoryEffects,
  };
}

/**
 * A Canvas Chat's mention or add, as the conversation sends it to its parent.
 * Its intent is what the hosted parent records (`recordPersonNotificationIntent`,
 * the function `HostedConversation.applyChildEnvelope` calls); that the parent
 * calls it is proved on real workerd, in `canvas-conversation.test.ts`.
 */
function personNotification(
  effect: Extract<ConversationEffect, { kind: "mention_notification" | "participant_notification" }>,
  parentId: string = WORKSTREAM_ID,
): PersonNotificationEnvelope {
  return childMessage(effect, { messageId: `notification:${effect.intentId}`, parentKind: "canvas", parentId }) as PersonNotificationEnvelope;
}

/** Record the intent a hosted parent records for this effect, and return its id. */
function record(
  workspace: ReturnType<typeof workspaceSyncNamespace>,
  effect: Extract<ConversationEffect, { kind: "mention_notification" | "participant_notification" }>,
  parentId?: string,
): string {
  return recordPersonNotificationIntent(workspace.storage, personNotification(effect, parentId), Date.now());
}

function regionalEnv(
  database: DatabaseSync,
  workspace: ReturnType<typeof workspaceSyncNamespace>,
  extra: {
    /** The hosted work stream parent's `receiveChildEffects`, answered by WorkspaceDO. */
    workstreamReceive?: (input: unknown) => Promise<unknown>;
  } = {},
): Env {
  const { workstreamReceive, ...bindings } = extra;
  return createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    WORKSPACE_DOS: workstreamReceive
      ? hostingWorkstreamParent(workspace.namespace, workstreamReceive)
      : workspace.namespace,
    APP_ENV: "test",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    ...bindings,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("a hosted parent's notification intents and their delivery", () => {
  it("records one intent per mention, and refuses the same mention under another identity by name", async () => {
    const workspace = workspaceSyncNamespace();
    try {
      const mention = mentionEffect();
      expect(record(workspace, mention)).toBe(mention.intentId);
      // A re-emission of the same message converges on the one row.
      expect(record(workspace, mention)).toBe(mention.intentId);
      expect(workspace.database.prepare(
        `SELECT recipient_user_id, notification_kind, source_message_id, state FROM workstream_notification_intents`,
      ).all()).toEqual([{
        recipient_user_id: USER_ID, notification_kind: "mention", source_message_id: MESSAGE_ID, state: "pending",
      }]);
      // The same message and recipient under a new intent id is a producer bug.
      expect(() => record(workspace, mentionEffect(":renamed")))
        .toThrow("notification_intent_identity_conflict");
    } finally {
      workspace.database.close();
    }
  });

  it("delivers a recorded mention, then erases its content", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace();
    const env = regionalEnv(database, workspace);
    try {
      const mention = mentionEffect();
      record(workspace, mention);
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
        reason: "chosen_channels_attempted",
        channels: "push,slack_agent_dm,email",
        push_enqueued: false,
        slack_outcome: "skipped",
        email_outcome: "skipped",
      }));
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("tries no channel the person did not choose: no email stands in for the rest", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace(true, []);
    const env = regionalEnv(database, workspace);
    try {
      const mention = mentionEffect();
      record(workspace, mention);
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      await expect(processWorkstreamNotificationIntent(env, WORKSPACE_ID, mention.intentId)).resolves.toBe("delivered");
      expect(info).toHaveBeenCalledWith(expect.objectContaining({
        event: "workstream_notification_terminal",
        outcome: "delivered",
        reason: "no_channel_chosen",
        channels: "",
        push_enqueued: false,
        slack_outcome: "skipped",
        email_outcome: null,
      }));
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("settles a mention whose conversation has no link, and names why Slack and email sent nothing", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace(true, ["push", "slack_agent_dm", "email"], null);
    const env = regionalEnv(database, workspace);
    try {
      const mention = mentionEffect(":linkless");
      record(workspace, mention);
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      await expect(processWorkstreamNotificationIntent(env, WORKSPACE_ID, mention.intentId)).resolves.toBe("delivered");
      for (const channel of ["slack", "email"]) {
        expect(info).toHaveBeenCalledWith(expect.objectContaining({
          event: "workstream_notification_transport_terminal", channel, outcome: "skipped",
          reason: "conversation_not_linkable", parent_kind: "missing",
        }));
      }
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("stores a participant-added intent under its own kind and delivers it", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace();
    const env = regionalEnv(database, workspace);
    try {
      const added: PersonEffect = {
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
      expect(record(workspace, added)).toBe(added.intentId);
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

  it("keeps one person's adds to two conversations as two intents", async () => {
    const secondWorkstreamId = "00000000-0000-7000-8000-0000000000e1";
    const workspace = workspaceSyncNamespace();
    try {
      // The epoch is object-local and starts at zero in both rooms, while the
      // intents table and `workspace_activity_events.dedupe_key` are
      // workspace-wide, so an identity without the work stream in it makes
      // the second add a conflict that retries forever instead of delivering.
      const added = (
        workstreamId: WorkstreamId,
      ): Extract<PersonEffect, { kind: "participant_notification" }> => ({
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
        expect(record(workspace, effect, workstreamId)).toBe(effect.intentId);
      }
      expect(workspace.database.prepare(
        `SELECT COUNT(*) AS count FROM workstream_notification_intents
          WHERE recipient_user_id = ? AND notification_kind = 'participant_added'`,
      ).get(USER_ID)).toEqual({ count: 2 });
    } finally {
      workspace.database.close();
    }
  });

  it("skips a mention whose recipient stopped being a member, and names why", async () => {
    const database = seedAuthority();
    database.prepare(
      `UPDATE workspace_members SET status = 'suspended'
        WHERE workspace_id = ? AND user_id = ?`,
    ).run(WORKSPACE_ID, USER_ID);
    const workspace = workspaceSyncNamespace();
    const env = regionalEnv(database, workspace);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const mention = mentionEffect(":inactive");
    try {
      // Recorded as any mention is: membership is read at delivery, as it is then.
      record(workspace, mention);
      await expect(processWorkstreamNotificationIntent(env, WORKSPACE_ID, mention.intentId)).resolves.toBe("skipped");
      expect(info).toHaveBeenCalledWith(expect.objectContaining({
        event: "workstream_notification_terminal",
        recipient_user_id: USER_ID,
        outcome: "skipped",
        reason: "recipient_inactive_or_identity_missing",
      }));
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("logs when current directory policy makes a notification recipient unlistable", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace(false);
    const env = regionalEnv(database, workspace);
    const mention = mentionEffect(":unlistable");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      record(workspace, mention);
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
    const env = regionalEnv(database, workspace);
    try {
      const added: PersonEffect = {
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
      record(workspace, added);
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

describe("the activity Queue consumer's effect legs", () => {
  it("carries a child's effect to its work stream parent with the envelope inline", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace();
    const receiveChildEffects = vi.fn(async () => ({ accepted: [], notificationIntentIds: [] }));
    const env = regionalEnv(database, workspace, {
      workstreamReceive: receiveChildEffects,
    });
    const envelope = childMessage(directoryCommon(), {
      messageId: MESSAGE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
    });
    const { batch, ack, retry } = queued(envelope);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await consumeActivityQueue(batch, env);
      expect(receiveChildEffects).toHaveBeenCalledWith({ substreamId: "0", envelopes: [envelope] });
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
      // Nothing was loaded back from the sender and nothing acknowledged to it.
      expect(workspace.applyWorkstreamDirectoryEffects).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(expect.objectContaining({
        event: "conversation_effect_terminal",
        workspace_id: WORKSPACE_ID,
        parent_kind: "workstream",
        workstream_id: WORKSTREAM_ID,
        substream_id: "0",
        message_id: MESSAGE_ID,
        effect_kind: "directory_common",
        outcome: "applied",
        reason: "parent_accepted",
      }));
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("carries an automation run's effect to the Organization object that hosts its Sidekick", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace();
    const hostedReceive = vi.fn(async () => ({ accepted: [], notificationIntentIds: [] }));
    const env = regionalEnv(database, workspace, {
      workstreamReceive: hostedReceive,
    });
    const envelope = childMessage(directoryCommon("Run 1"), {
      messageId: `run:${RUN_ID}`,
      parentKind: "automation",
      parentId: AUTOMATION_ID,
      substreamId: RUN_ID,
    });
    const { batch, ack, retry } = queued(envelope);
    try {
      await consumeActivityQueue(batch, env);
      // One receiver for every parent; it dispatches on the envelope's kind.
      expect(hostedReceive).toHaveBeenCalledWith({ substreamId: RUN_ID, envelopes: [envelope] });
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("strips unknown directory fields before forwarding an effect to its parent", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace();
    const receiveChildEffects = vi.fn<(input: unknown) => Promise<unknown>>(async () => ({ accepted: [], notificationIntentIds: [] }));
    const env = regionalEnv(database, workspace, { workstreamReceive: receiveChildEffects });
    const envelope = childMessage(directoryCommon(), {
      messageId: MESSAGE_ID, parentKind: "workstream", parentId: WORKSTREAM_ID,
    });
    const { batch, ack, retry } = queued({ ...envelope, effect: { ...envelope.effect, futureField: [] } });
    try {
      await consumeActivityQueue(batch, env);
      expect(receiveChildEffects).toHaveBeenCalledOnce();
      expect(receiveChildEffects.mock.calls[0]?.[0]).toMatchObject({
        envelopes: [{ effect: { kind: "directory_common", title: "Queue-delivered state" } }],
      });
      expect(receiveChildEffects.mock.calls[0]?.[0]).not.toHaveProperty("envelopes.0.effect.futureField");
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("names the field of an effect this consumer's contract refuses, and acks it", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace();
    const receiveChildEffects = vi.fn(async () => ({ accepted: [], notificationIntentIds: [] }));
    const env = regionalEnv(database, workspace, { workstreamReceive: receiveChildEffects });
    // A declared field is still invalid even though unknown fields are stripped.
    const envelope = childMessage(directoryCommon(), {
      messageId: MESSAGE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
    });
    const { batch, ack, retry } = queued({ ...envelope, effect: { ...envelope.effect, title: [] } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await consumeActivityQueue(batch, env);
      expect(receiveChildEffects).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({
        event: "effect_queue_message_invalid",
        workspace_id: WORKSPACE_ID,
        message_id: MESSAGE_ID,
        code: "effect_queue_message_invalid:effect.title:invalid_type",
      }));
      expect(info).not.toHaveBeenCalledWith(expect.objectContaining({ reason: "legacy_message_after_cutover" }));
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("brings a child's effect back when its parent could not take it", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace();
    const receiveChildEffects = vi.fn(async () => { throw new Error("parent_unavailable"); });
    const env = regionalEnv(database, workspace, {
      workstreamReceive: receiveChildEffects,
    });
    const { batch, ack, retry } = queued(childMessage(directoryCommon(), {
      messageId: MESSAGE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
    }), 2);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await consumeActivityQueue(batch, env);
      expect(ack).not.toHaveBeenCalled();
      // Backing off on the attempt count: the second delivery waits ten seconds.
      expect(retry).toHaveBeenCalledWith({ delaySeconds: 10 });
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({
        event: "conversation_effect_processing_failed",
        message_id: MESSAGE_ID,
        reason: "parent_unavailable",
      }));
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("acknowledges a late Thread parent's mention or directory row by name, and records nothing", async () => {
    // Only the retired Thread host sent a `parent_effect` of these kinds; a
    // hosted parent records a mention where its conversation's effect lands.
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace();
    const env = regionalEnv(database, workspace);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      for (const envelope of [
        message(directoryCommon(), { messageId: MESSAGE_ID, partitionKey: "common", sourceVersion: 7 }),
        message(mentionEffect(":late"), { messageId: `notification:${MESSAGE_ID}`, partitionKey: "notification", sourceVersion: 3 }),
      ]) {
        const { batch, ack, retry } = queued(envelope);
        await consumeActivityQueue(batch, env);
        expect(ack).toHaveBeenCalledOnce();
        expect(retry).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledWith(expect.objectContaining({
          event: "conversation_effect_terminal", message_id: envelope.messageId,
          outcome: "ignored", reason: "parent_effect_producer_retired",
        }));
      }
      expect(workspace.applyWorkstreamDirectoryEffects).not.toHaveBeenCalled();
      expect(workspace.database.prepare(
        "SELECT COUNT(*) AS count FROM workstream_notification_intents",
      ).get()).toEqual({ count: 0 });
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("acknowledges a late Sidekick sidebar row from the deleted SidekickDO without applying it", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace();
    const env = regionalEnv(database, workspace);
    const envelope = message({
      kind: "directory_automation",
      automationId: AUTOMATION_ID,
      authorUserId: AUTHOR_ID,
      lifecycle: "active",
      scope: "personal",
      owningWorkstreamId: null,
      title: "Nightly digest",
      description: "Summarize the day.",
      nextRunAt: AT,
    }, {
      messageId: `automation:${AUTOMATION_ID}`,
      partitionKey: "automation",
      sourceVersion: 2,
      parentKind: "automation",
      parentId: AUTOMATION_ID,
    });
    const { batch, ack, retry } = queued(envelope);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await consumeActivityQueue(batch, env);
      expect(workspace.applyWorkstreamDirectoryEffects).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(expect.objectContaining({
        event: "conversation_effect_terminal",
        outcome: "ignored",
        reason: "sidekick_directory_producer_deleted",
      }));
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("delivers the mention a hosted parent recorded, and settles the intent", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace();
    const mention = mentionEffect(":consumed");
    // The parent step on real workerd is `canvas-conversation.test.ts`; here it
    // records the intent and names it, as `HostedConversation` answers.
    const env = regionalEnv(database, workspace, {
      workstreamReceive: async () => ({ accepted: [], notificationIntentIds: [record(workspace, mention)] }),
    });
    const { batch, ack, retry } = queued(personNotification(mention));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await consumeActivityQueue(batch, env);
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
      expect(workspace.database.prepare(
        `SELECT state, payload_json FROM workstream_notification_intents WHERE intent_id = ?`,
      ).get(mention.intentId)).toEqual({ state: "delivered", payload_json: null });
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("retries a notification whose intent another delivery is still holding", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace();
    const mention = mentionEffect(":busy");
    const env = regionalEnv(database, workspace, {
      workstreamReceive: async () => ({ accepted: [], notificationIntentIds: [record(workspace, mention)] }),
    });
    const envelope = personNotification(mention);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      // The first delivery created the intent and is still holding its lease
      // when the Queue redelivers the same effect.
      record(workspace, mention);
      const held = await workspace.claimWorkstreamNotificationIntent({
        workspaceId: WORKSPACE_ID,
        intentId: mention.intentId,
      });
      expect(held.outcome).toBe("claimed");

      const { batch, ack, retry } = queued(envelope, 2);
      await consumeActivityQueue(batch, env);

      // Neither dropped nor failed: the holder will settle it or the lease
      // will lapse, and either way the message has to come back to check.
      expect(ack).not.toHaveBeenCalled();
      expect(retry).toHaveBeenCalledWith({ delaySeconds: 30 });
      expect(info).toHaveBeenCalledWith(expect.objectContaining({
        event: "conversation_effect_deferred",
        message_id: envelope.messageId,
        notification_intent_id: mention.intentId,
        reason: "notification_busy",
      }));
      // Still the holder's: the redelivery neither settled nor failed it.
      expect(workspace.database.prepare(
        `SELECT state FROM workstream_notification_intents WHERE intent_id = ?`,
      ).get(mention.intentId)).toEqual({ state: "processing" });
    } finally {
      database.close();
      workspace.database.close();
    }
  });

  it("acknowledges an effect addressed to the other region without touching anything", async () => {
    const database = seedAuthority();
    const workspace = workspaceSyncNamespace();
    const receiveChildEffects = vi.fn(async () => ({ accepted: [], notificationIntentIds: [] }));
    const env = regionalEnv(database, workspace, {
      workstreamReceive: receiveChildEffects,
    });
    const envelope = childMessage(directoryCommon(), {
      messageId: MESSAGE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
    });
    const { batch, ack, retry } = queued({ ...envelope, region: "enterprise" });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await consumeActivityQueue(batch, env);
      expect(receiveChildEffects).not.toHaveBeenCalled();
      expect(workspace.applyWorkstreamDirectoryEffects).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
    } finally {
      database.close();
      workspace.database.close();
    }
  });
});

describe("the activity Queue consumer's connector ingress", () => {
  /** A synthetic event, shaped as the dev ingress and every adapter enqueue it. */
  async function ingressMessage() {
    return workspaceConnectorEventQueueMessage({
      connectorType: "generic_webhook",
      activity: {
        id: "00000000-0000-7000-8000-0000000000e1",
        workspaceId: WORKSPACE_ID,
        region: "global",
        connectionId: "00000000-0000-7000-8000-0000000000e2",
        connectionScope: "workspace",
        connectionOwnerUserId: null,
        provider: "generic_webhook",
        providerEventId: "evt-1",
        eventType: "deploy.finished",
        resourceType: null,
        providerResourceId: null,
        actor: {},
        subject: {},
        occurredAt: AT,
        receivedAt: AT,
        title: "Deploy finished",
        summary: "",
        textSnippet: "",
        payloadRef: null,
        visibility: { kind: "workspace" },
        targetUserIds: [],
        entityKeys: [],
        dedupeKey: "generic_webhook:evt-1",
        rawContentHash: null,
        metadata: {},
        externalPeople: [],
      },
    });
  }

  function refusingWorkspace(error: Error): Env["WORKSPACE_DOS"] {
    return createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
      idFromName: () => createTestDurableObjectId("workspace-ingress"),
      get: () => ({
        ingestConnectorEvent: async () => {
          throw error;
        },
      }),
    });
  }

  it("drops an event whose identity was already used for different content", async () => {
    const database = seedAuthority();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      APP_ENV: "test",
      WORKSPACE_DOS: refusingWorkspace(new Error("connector_event_identity_reused_with_different_content")),
    });
    const { batch, ack, retry } = queued(await ingressMessage());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // The ledger answers the same way on every delivery: the id belongs to
      // another payload. Retrying only repeats the refusal with backoff until
      // the Queue gives up, so the refusal is terminal on the first delivery.
      await consumeActivityQueue(batch, env);
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("still retries an admission that failed for any other reason", async () => {
    const database = seedAuthority();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      APP_ENV: "test",
      WORKSPACE_DOS: refusingWorkspace(new Error("Durable Object reset because its code was updated")),
    });
    const { batch, ack, retry } = queued(await ingressMessage());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await consumeActivityQueue(batch, env);
      expect(retry).toHaveBeenCalledOnce();
      expect(ack).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });
});
