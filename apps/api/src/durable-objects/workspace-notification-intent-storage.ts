import type { ConversationEffectEnvelope } from "@rally/contracts/conversation-effects";

import {
  WorkspaceNotificationIntentClaimResultSchema,
  WorkspaceNotificationIntentDeliverySchema,
  type WorkspaceNotificationIntentDelivery,
  WorkspaceNotificationIntentMaintenanceTargetSchema,
  WorkspaceNotificationIntentReapResultSchema,
  WorkspaceNotificationIntentTransitionResultSchema,
  type WorkspaceNotificationIntentClaimResult,
  type WorkspaceNotificationIntentMaintenanceTarget,
  type WorkspaceNotificationIntentReapResult,
  type WorkspaceNotificationIntentTransitionRequest,
  type WorkspaceNotificationIntentTransitionResult,
} from "./workspace-notification-intent-protocol";

/**
 * WorkspaceDO migration 145: admit a Sidekick run's two notices,
 * `needs_input` and `run_finished`, beside a mention and an add. Push stays
 * for a Canvas Chat mention, a run that needs input and a finished run (the
 * Canvases and Sidekicks PRD), and the run notices ride the same intent row
 * and push pointer a mention does, so the push consumer, its receipts and the
 * reaper serve all four. SQLite cannot alter a CHECK in place, so the table is
 * rebuilt as migration 9 rebuilt it: new table, copy, drop, rename, then the
 * indexes and identity-fence triggers the drop took with it. Migrations 1 and
 * 9 stay as shipped; their statements are hashed into every object's receipt.
 */
export const NOTIFICATION_INTENTS_RUN_KINDS_MIGRATION: readonly string[] = [
  `CREATE TABLE workstream_notification_intents_run_kinds (
    intent_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    workstream_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    source_generation INTEGER NOT NULL CHECK (source_generation > 0),
    source_version INTEGER NOT NULL CHECK (source_version > 0),
    required_directory_version INTEGER NOT NULL CHECK (required_directory_version > 0),
    notification_kind TEXT NOT NULL CHECK (notification_kind IN ('mention', 'participant_added', 'needs_input', 'run_finished')),
    payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
    payload_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'delivered', 'skipped', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_id TEXT,
    lease_expires_at TEXT,
    last_error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    delivered_at TEXT,
    UNIQUE (source_message_id, recipient_user_id, notification_kind)
  ) STRICT`,
  `INSERT INTO workstream_notification_intents_run_kinds
     (intent_id, workspace_id, workstream_id, recipient_user_id, source_message_id,
      source_generation, source_version, required_directory_version, notification_kind,
      payload_json, payload_hash, state, attempts, lease_id, lease_expires_at,
      last_error_code, created_at, updated_at, delivered_at)
   SELECT intent_id, workspace_id, workstream_id, recipient_user_id, source_message_id,
      source_generation, source_version, required_directory_version, notification_kind,
      payload_json, payload_hash, state, attempts, lease_id, lease_expires_at,
      last_error_code, created_at, updated_at, delivered_at
     FROM workstream_notification_intents`,
  `DROP TABLE workstream_notification_intents`,
  `ALTER TABLE workstream_notification_intents_run_kinds RENAME TO workstream_notification_intents`,
  `CREATE INDEX workstream_notification_intents_delivery_idx
    ON workstream_notification_intents(state, lease_expires_at, created_at, intent_id)`,
  `CREATE INDEX workstream_notification_intents_terminal_idx
    ON workstream_notification_intents(workstream_id, state, created_at)`,
  `CREATE TRIGGER workstream_notification_intents_workspace_identity_insert
    BEFORE INSERT ON workstream_notification_intents
    WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
    BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
  `CREATE TRIGGER workstream_notification_intents_workspace_identity_update
    BEFORE UPDATE OF workspace_id ON workstream_notification_intents
    WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
    BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
];

/**
 * Record a Sidekick run's notice for each recipient, already `delivered`:
 * push is its only channel and the queue message is its delivery, so there is
 * no lease to take (a mention's lease covers its Slack and email sends). The
 * source and kind make a repeat for the same recipient one row, so a retried
 * alarm records nothing twice; the returned ids are every recipient's, to
 * enqueue again, which the push receipts make harmless.
 */
export function recordSidekickRunNotices(
  storage: DurableObjectStorage,
  input: {
    workspaceId: string; sidekickId: string; sourceId: string; kind: "needs_input" | "run_finished";
    generation: number; payloadJson: string; payloadHash: string; recipientUserIds: readonly string[];
  },
  now: number,
): { recipientUserId: string; intentId: string }[] {
  const at = new Date(now).toISOString();
  return storage.transactionSync(() => input.recipientUserIds.map((recipientUserId) => {
    const intentId = `${input.sourceId}:${recipientUserId}`;
    storage.sql.exec(
      `INSERT INTO workstream_notification_intents
         (intent_id, workspace_id, workstream_id, recipient_user_id, source_message_id, source_generation,
          source_version, required_directory_version, notification_kind, payload_json, payload_hash, state,
          attempts, created_at, updated_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, 'delivered', 0, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      intentId, input.workspaceId, input.sidekickId, recipientUserId, input.sourceId, Math.max(1, input.generation),
      input.kind, input.payloadJson, input.payloadHash, at, at, at,
    );
    return { recipientUserId, intentId };
  }));
}

/** A conversation's mention or add, as its parent receives it. */
export type PersonNotificationEnvelope = ConversationEffectEnvelope & {
  effect: Extract<ConversationEffectEnvelope["effect"], { kind: "mention_notification" | "participant_notification" }>;
};

/**
 * Record one person's mention or add as a `pending` intent, for the activity
 * consumer to deliver by the id this returns. The caller holds the
 * transaction and the envelope's receipt; this writes the product row only.
 *
 * A mention is identified by the message that carried it; being added has no
 * message, so the effect names its own source. Both land in
 * `source_message_id`, which with the recipient and the kind makes a
 * re-emission of either one intent rather than two. The same identity under a
 * different intent id or payload is a producer bug, refused by name.
 *
 * Whether the recipient is still a member, may still open the parent, or is
 * the author is decided at delivery (`notificationDeliveryContext`), which
 * reads all three as they are then; recording asks none of them.
 */
export function recordPersonNotificationIntent(
  storage: DurableObjectStorage,
  envelope: PersonNotificationEnvelope,
  now: number,
): string {
  const effect = envelope.effect;
  const notificationKind = effect.kind === "mention_notification" ? "mention" : "participant_added";
  const sourceId = effect.kind === "mention_notification" ? effect.messageId : effect.sourceId;
  const existing = storage.sql.exec<{ intent_id: string; payload_hash: string }>(
    `SELECT intent_id, payload_hash FROM workstream_notification_intents
      WHERE intent_id = ?
         OR (source_message_id = ? AND recipient_user_id = ? AND notification_kind = ?)`,
    effect.intentId, sourceId, effect.recipientUserId, notificationKind,
  ).toArray()[0];
  if (existing) {
    if (existing.intent_id !== effect.intentId || existing.payload_hash !== envelope.payloadHash) {
      throw new Error("notification_intent_identity_conflict");
    }
    return effect.intentId;
  }
  const at = new Date(now).toISOString();
  storage.sql.exec(
    `INSERT INTO workstream_notification_intents
       (intent_id, workspace_id, workstream_id, recipient_user_id, source_message_id, source_generation,
        source_version, required_directory_version, notification_kind, payload_json, payload_hash, state,
        attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    effect.intentId, envelope.workspaceId, envelope.parentId, effect.recipientUserId, sourceId,
    envelope.generation, envelope.sourceVersion, envelope.requiredProjectionVersion ?? 1, notificationKind,
    JSON.stringify(effect), envelope.payloadHash, at, at,
  );
  return effect.intentId;
}

export const WORKSTREAM_NOTIFICATION_INTENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const WORKSTREAM_NOTIFICATION_INTENT_LEASE_MS = 5 * 60_000;

type NotificationIntentRow = Record<string, SqlStorageValue> & {
  intent_id: string;
  workspace_id: string;
  workstream_id: string;
  recipient_user_id: string;
  source_generation: number;
  required_directory_version: number;
  notification_kind: "mention" | "participant_added" | "needs_input" | "run_finished";
  payload_json: string | null;
  state: "pending" | "processing" | "delivered" | "skipped" | "failed";
};

function summary(row: NotificationIntentRow) {
  return {
    intentId: row.intent_id,
    workstreamId: row.workstream_id,
    recipientUserId: row.recipient_user_id,
    notificationKind: row.notification_kind,
    state: row.state,
  };
}

/** Claim one delivery intent and return the lease-bearing row as the domain witness. */
export function claimWorkspaceNotificationIntent(
  storage: DurableObjectStorage,
  input: { workspaceId: string; intentId: string },
  leaseId: string,
  now: number,
): WorkspaceNotificationIntentClaimResult {
  return storage.transactionSync(() => {
    const at = new Date(now).toISOString();
    const claimed = storage.sql.exec<NotificationIntentRow & { lease_id: string }>(
      `UPDATE workstream_notification_intents
          SET state = 'processing', attempts = attempts + 1, lease_id = ?,
              lease_expires_at = ?, last_error_code = NULL, updated_at = ?
        WHERE intent_id = ? AND workspace_id = ? AND payload_json IS NOT NULL
          AND (state IN ('pending', 'failed')
            OR (state = 'processing' AND COALESCE(lease_expires_at, '') <= ?))
        RETURNING intent_id, workspace_id, workstream_id, recipient_user_id,
                  source_generation, required_directory_version, notification_kind,
                  payload_json, state, lease_id`,
      leaseId,
      new Date(now + WORKSTREAM_NOTIFICATION_INTENT_LEASE_MS).toISOString(),
      at,
      input.intentId,
      input.workspaceId,
      at,
    ).toArray()[0];
    if (claimed?.lease_id === leaseId && claimed.payload_json !== null) {
      return WorkspaceNotificationIntentClaimResultSchema.parse({
        outcome: "claimed",
        leaseId,
        intent: {
          ...summary(claimed),
          workspaceId: claimed.workspace_id,
          sourceGeneration: claimed.source_generation,
          payloadJson: claimed.payload_json,
        },
      });
    }

    const current = storage.sql.exec<NotificationIntentRow>(
      `SELECT intent_id, workspace_id, workstream_id, recipient_user_id,
              source_generation, required_directory_version, notification_kind,
              payload_json, state
         FROM workstream_notification_intents
        WHERE intent_id = ? AND workspace_id = ?`,
      input.intentId,
      input.workspaceId,
    ).toArray()[0];
    if (!current) {
      return WorkspaceNotificationIntentClaimResultSchema.parse({ outcome: "missing" });
    }
    if (current.state === "delivered" || current.state === "skipped") {
      return WorkspaceNotificationIntentClaimResultSchema.parse({
        outcome: "terminal",
        intent: summary(current),
      });
    }
    return WorkspaceNotificationIntentClaimResultSchema.parse({
      outcome: "busy",
      intent: summary(current),
    });
  });
}

/** Apply a lease-fenced state transition without exposing SQLite counters. */
export function transitionWorkspaceNotificationIntent(
  storage: DurableObjectStorage,
  input: WorkspaceNotificationIntentTransitionRequest,
  now: number,
): WorkspaceNotificationIntentTransitionResult {
  return storage.transactionSync(() => {
    const at = new Date(now).toISOString();
    let applied: { intent_id: string } | undefined;
    if (input.transition === "settle") {
      applied = storage.sql.exec<{ intent_id: string }>(
        `UPDATE workstream_notification_intents
            SET state = ?, payload_json = CASE WHEN ? THEN payload_json ELSE NULL END, lease_id = NULL,
                lease_expires_at = NULL, last_error_code = NULL, updated_at = ?,
                delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE NULL END
          WHERE intent_id = ? AND workspace_id = ? AND lease_id = ?
          RETURNING intent_id`,
        input.state,
        input.state === "delivered" && input.retainPayload === true ? 1 : 0,
        at,
        input.state,
        at,
        input.intentId,
        input.workspaceId,
        input.leaseId,
      ).toArray()[0];
    } else {
      applied = storage.sql.exec<{ intent_id: string }>(
        `UPDATE workstream_notification_intents
            SET state = ?, lease_id = NULL, lease_expires_at = NULL,
                last_error_code = ?, updated_at = ?
          WHERE intent_id = ? AND workspace_id = ? AND lease_id = ?
          RETURNING intent_id`,
        input.transition === "defer" ? "pending" : "failed",
        input.errorCode,
        at,
        input.intentId,
        input.workspaceId,
        input.leaseId,
      ).toArray()[0];
    }
    if (applied?.intent_id === input.intentId) {
      return WorkspaceNotificationIntentTransitionResultSchema.parse({
        outcome: "applied",
        intentId: applied.intent_id,
      });
    }
    const current = storage.sql.exec<{ state: NotificationIntentRow["state"] }>(
      `SELECT state FROM workstream_notification_intents
        WHERE intent_id = ? AND workspace_id = ?`,
      input.intentId,
      input.workspaceId,
    ).toArray()[0];
    return WorkspaceNotificationIntentTransitionResultSchema.parse(
      current ? { outcome: "lease_lost", state: current.state } : { outcome: "missing" },
    );
  });
}

export function workspaceNotificationIntentMaintenanceTarget(
  storage: DurableObjectStorage,
  workspaceId: string,
): WorkspaceNotificationIntentMaintenanceTarget {
  const row = storage.sql.exec<{ due_at: string | null }>(
    `SELECT strftime('%Y-%m-%dT%H:%M:%SZ', MIN(updated_at), ?, '+1 second') AS due_at
       FROM workstream_notification_intents
      WHERE workspace_id = ? AND state IN ('delivered', 'skipped')`,
    `+${WORKSTREAM_NOTIFICATION_INTENT_RETENTION_MS / 1_000} seconds`,
    workspaceId,
  ).one();
  return WorkspaceNotificationIntentMaintenanceTargetSchema.parse({ dueAt: row.due_at });
}

export function reapSettledWorkspaceNotificationIntents(
  storage: DurableObjectStorage,
  input: { workspaceId: string; limit: number },
  now: number,
): WorkspaceNotificationIntentReapResult {
  const cutoff = new Date(now - WORKSTREAM_NOTIFICATION_INTENT_RETENTION_MS).toISOString();
  const rows = storage.sql.exec<{ intent_id: string }>(
    `DELETE FROM workstream_notification_intents
      WHERE intent_id IN (
        SELECT intent_id FROM workstream_notification_intents
         WHERE workspace_id = ? AND state IN ('delivered', 'skipped') AND updated_at < ?
         ORDER BY updated_at, intent_id LIMIT ?
      )
      RETURNING intent_id`,
    input.workspaceId,
    cutoff,
    input.limit,
  ).toArray();
  return WorkspaceNotificationIntentReapResultSchema.parse({
    reapedIntentIds: rows.map((row) => row.intent_id).sort(),
  });
}

export function readNotificationIntentForDelivery(storage: DurableObjectStorage, input: { workspaceId: string; intentId: string }): WorkspaceNotificationIntentDelivery | null {
  const row = storage.sql.exec<NotificationIntentRow>(`SELECT * FROM workstream_notification_intents
    WHERE workspace_id = ? AND intent_id = ? AND payload_json IS NOT NULL AND state <> 'skipped'`, input.workspaceId, input.intentId).toArray()[0];
  return row ? WorkspaceNotificationIntentDeliverySchema.parse({ intentId: row.intent_id, workstreamId: row.workstream_id, recipientUserId: row.recipient_user_id, notificationKind: row.notification_kind, workspaceId: row.workspace_id,
    sourceGeneration: row.source_generation,
    payloadJson: row.payload_json }) : null;
}
