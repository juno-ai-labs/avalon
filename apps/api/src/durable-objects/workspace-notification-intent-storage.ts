import type { ActivityParentKind } from "@rally/contracts";
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
import { recordActivityItem, recordCollapsedActivityItem, type ActivityItemInput, type NoteActivity } from "./workspace-activity";

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
 * WorkspaceDO migration 150: admit the four notices a hosted parent records
 * for itself — a person's reply (`new_message`), a new version in a pinned
 * Canvas (`artifact_updated`), a request to open a Canvas (`access_request`)
 * and that request let in (`access_granted`) — on the same intent row and
 * push pointer the other four ride (`docs/push-notifications.md`). Rebuilt
 * as migration 145 rebuilt it; 145 stays as shipped.
 */
export const NOTIFICATION_INTENTS_PARENT_NOTICES_MIGRATION: readonly string[] = [
  `CREATE TABLE workstream_notification_intents_v150 (
    intent_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    workstream_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    source_generation INTEGER NOT NULL CHECK (source_generation > 0),
    source_version INTEGER NOT NULL CHECK (source_version > 0),
    required_directory_version INTEGER NOT NULL CHECK (required_directory_version > 0),
    notification_kind TEXT NOT NULL CHECK (notification_kind IN ('mention', 'participant_added', 'needs_input', 'run_finished',
      'new_message', 'artifact_updated', 'access_request', 'access_granted')),
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
  `INSERT INTO workstream_notification_intents_v150
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
  `ALTER TABLE workstream_notification_intents_v150 RENAME TO workstream_notification_intents`,
  `CREATE INDEX workstream_notification_intents_delivery_idx
    ON workstream_notification_intents(state, lease_expires_at, created_at, intent_id)`,
  `CREATE INDEX workstream_notification_intents_terminal_idx
    ON workstream_notification_intents(workstream_id, state, created_at)`,
  // A reply's cooldown asks for this person's last delivered reply notice in
  // one conversation.
  `CREATE INDEX workstream_notification_intents_recipient_kind_idx
    ON workstream_notification_intents(recipient_user_id, notification_kind, workstream_id, delivered_at)`,
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
 * WorkspaceDO migration 152: admit a declined request to open a Canvas
 * (`access_denied`), the notice its requester is now sent
 * (`docs/canvas-access-requests.md`). Rebuilt as migration 150 rebuilt it;
 * 150 stays as shipped.
 */
export const NOTIFICATION_INTENTS_ACCESS_DENIED_MIGRATION: readonly string[] = [
  `CREATE TABLE workstream_notification_intents_v152 (
    intent_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    workstream_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    source_generation INTEGER NOT NULL CHECK (source_generation > 0),
    source_version INTEGER NOT NULL CHECK (source_version > 0),
    required_directory_version INTEGER NOT NULL CHECK (required_directory_version > 0),
    notification_kind TEXT NOT NULL CHECK (notification_kind IN ('mention', 'participant_added', 'needs_input', 'run_finished',
      'new_message', 'artifact_updated', 'access_request', 'access_granted', 'access_denied')),
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
  `INSERT INTO workstream_notification_intents_v152
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
  `ALTER TABLE workstream_notification_intents_v152 RENAME TO workstream_notification_intents`,
  `CREATE INDEX workstream_notification_intents_delivery_idx
    ON workstream_notification_intents(state, lease_expires_at, created_at, intent_id)`,
  `CREATE INDEX workstream_notification_intents_terminal_idx
    ON workstream_notification_intents(workstream_id, state, created_at)`,
  // A reply's cooldown asks for this person's last delivered reply notice in
  // one conversation.
  `CREATE INDEX workstream_notification_intents_recipient_kind_idx
    ON workstream_notification_intents(recipient_user_id, notification_kind, workstream_id, delivered_at)`,
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
    runId: string; reply: string | null;
  },
  now: number,
  noteActivity: NoteActivity,
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
    // The recipient's Activity row, in the intent's transaction; the
    // Sidekick is who acted, and the run is the conversation it acted in.
    recordActivityItem(storage.sql, {
      itemId: intentId, workspaceId: input.workspaceId, recipientUserId, kind: input.kind,
      parentKind: "automation", parentId: input.sidekickId, substreamId: input.runId, messageId: null, runId: input.runId,
      actorKind: "sidekick", actorId: input.sidekickId, text: input.reply,
    }, now, noteActivity);
    return { recipientUserId, intentId };
  }));
}

/** One notice a hosted parent records about itself for one person, and the Activity row it writes. */
export interface ParentNoticeRecord {
  workspaceId: string;
  /** The Canvas or Sidekick: the intent's `workstream_id`, which delivery checks the person may still open. */
  parentId: string;
  generation: number;
  kind: "new_message" | "artifact_updated" | "access_request" | "access_granted" | "access_denied";
  recipientUserId: string;
  intentId: string;
  /** With the recipient and the kind, what makes a repeat one intent. */
  sourceId: string;
  payloadJson: string;
  payloadHash: string;
  /**
   * Recorded but not pushed, with this code as its reason: the intent is
   * `skipped` and has no `delivered_at`. The Activity row is written all the
   * same, since the feed is what happened, not what was pushed.
   */
  skipCode: string | null;
  activity: Omit<ActivityItemInput, "itemId" | "workspaceId" | "recipientUserId" | "kind">;
  /** Bring the person's unseen row about the same conversation up to this one, rather than add another. */
  collapse: boolean;
}

/**
 * Record a hosted parent's own notice for one person: a reply, a pinned
 * Canvas's new version, an access request or its grant. Like a run notice it
 * is written `delivered` (push is its only channel and the queue message is
 * its delivery, so there is no lease), unless `skipCode` says why it is not
 * pushed. The caller holds the transaction. The Activity row is written only
 * by the call that wrote the intent, so a retried caller moves nothing; the
 * answer says whether the intent is one to enqueue, on a retry too, which the
 * push receipts make harmless.
 */
export function recordParentNotice(storage: DurableObjectStorage, input: ParentNoticeRecord, now: number, noteActivity: NoteActivity): { intentId: string; push: boolean } {
  const at = new Date(now).toISOString();
  const written = storage.sql.exec<{ intent_id: string }>(
    `INSERT INTO workstream_notification_intents
       (intent_id, workspace_id, workstream_id, recipient_user_id, source_message_id, source_generation,
        source_version, required_directory_version, notification_kind, payload_json, payload_hash, state,
        attempts, last_error_code, created_at, updated_at, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, 0, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING
     RETURNING intent_id`,
    input.intentId, input.workspaceId, input.parentId, input.recipientUserId, input.sourceId, Math.max(1, input.generation),
    input.kind, input.payloadJson, input.payloadHash, input.skipCode === null ? "delivered" : "skipped", input.skipCode,
    at, at, input.skipCode === null ? at : null,
  ).toArray().length === 1;
  if (written) {
    const item: ActivityItemInput = {
      ...input.activity, itemId: input.intentId, workspaceId: input.workspaceId, recipientUserId: input.recipientUserId, kind: input.kind,
    };
    if (input.collapse) recordCollapsedActivityItem(storage.sql, item, now, noteActivity);
    else recordActivityItem(storage.sql, item, now, noteActivity);
  }
  const state = storage.sql.exec<{ state: string }>(
    `SELECT state FROM workstream_notification_intents WHERE intent_id = ?`, input.intentId,
  ).toArray()[0]?.state;
  return { intentId: input.intentId, push: state === "delivered" };
}

/**
 * A conversation's mention or add, as its hosted parent receives it: only a
 * Canvas or a Sidekick records one (`applyChildEnvelope` refuses an envelope
 * naming another kind before it gets here).
 */
export type PersonNotificationEnvelope = ConversationEffectEnvelope & {
  parentKind: ActivityParentKind;
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
  noteActivity: NoteActivity,
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
  // The recipient's Activity row, in the same transaction, so the push and
  // the feed cannot disagree (docs/activity.md). Only a hosted parent records
  // an intent, so the parent is a Canvas or a Sidekick.
  const mention = effect.kind === "mention_notification" ? effect : null;
  recordActivityItem(storage.sql, {
    itemId: effect.intentId, workspaceId: envelope.workspaceId, recipientUserId: effect.recipientUserId,
    kind: notificationKind, parentKind: envelope.parentKind,
    parentId: envelope.parentId, substreamId: effect.substreamId ?? envelope.substreamId,
    messageId: mention?.messageId ?? null, messageSequence: mention?.transcriptSequence ?? null, runId: null, actorKind: "person",
    actorId: mention ? mention.authorUserId : effect.kind === "participant_notification" ? effect.actorUserId : null,
    // What the push's body says: the message, or the objective of what they were added to.
    text: mention ? mention.messageText : effect.kind === "participant_notification" ? effect.workstreamObjectiveSnapshot ?? null : null,
    // The read cursor Activity compares against is the shared conversation's
    // ("0"). A mention or an add in any other conversation under the parent
    // (a Sidekick run's) has an ordinal in that conversation's own sequence,
    // which that cursor does not measure, so it carries none and clears only
    // by Mark all seen.
    ...((effect.substreamId ?? envelope.substreamId) !== "0" ? { attentionOrdinal: null }
      : mention ? { attentionOrdinal: mention.attentionOrdinal ?? null } : {}),
  }, now, noteActivity);
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
  notification_kind: "mention" | "participant_added" | "needs_input" | "run_finished"
    | "new_message" | "artifact_updated" | "access_request" | "access_granted" | "access_denied";
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
