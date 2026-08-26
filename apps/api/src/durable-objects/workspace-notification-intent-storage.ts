import {
  WorkspaceNotificationIntentClaimResultSchema,
  WorkspaceNotificationIntentMaintenanceTargetSchema,
  WorkspaceNotificationIntentReapResultSchema,
  WorkspaceNotificationIntentTransitionResultSchema,
  type WorkspaceNotificationIntentClaimResult,
  type WorkspaceNotificationIntentMaintenanceTarget,
  type WorkspaceNotificationIntentReapResult,
  type WorkspaceNotificationIntentTransitionRequest,
  type WorkspaceNotificationIntentTransitionResult,
} from "./workspace-notification-intent-protocol";

export const WORKSTREAM_NOTIFICATION_INTENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const WORKSTREAM_NOTIFICATION_INTENT_LEASE_MS = 5 * 60_000;

type NotificationIntentRow = Record<string, SqlStorageValue> & {
  intent_id: string;
  workspace_id: string;
  workstream_id: string;
  recipient_user_id: string;
  source_generation: number;
  required_directory_version: number;
  notification_kind: "mention" | "participant_added";
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
          requiredDirectoryVersion: claimed.required_directory_version,
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
            SET state = ?, payload_json = NULL, lease_id = NULL,
                lease_expires_at = NULL, last_error_code = NULL, updated_at = ?,
                delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE NULL END
          WHERE intent_id = ? AND workspace_id = ? AND lease_id = ?
          RETURNING intent_id`,
        input.state,
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
