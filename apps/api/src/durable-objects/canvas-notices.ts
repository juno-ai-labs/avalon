import type { CanvasNoticesView, NotificationChannel } from "@rally/contracts";
import { truncateUtf16Safe } from "@rally/contracts/text";

import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import { logInfo } from "../observability/logger";
import { enqueueNotice } from "../services/push-delivery-service";
import { NAME_SNAPSHOT_CHARACTERS } from "./canvas-access-requests";
import { chosenChannels } from "./member-preferences";
import type { NoteActivity } from "./workspace-activity";
import type { ParentNotice } from "./workspace-notification-intent-protocol";
import { recordParentNotice } from "./workspace-notification-intent-storage";

/**
 * A Canvas's notices: an agent working on a Canvas tells its participants that
 * something happened, by the channels each chose. The Canvas turns them on
 * once with a sentence saying what it will notify about
 * (`canvas_notice_registrations`, one row per Canvas), and each participant
 * may choose other channels for this Canvas or mute it
 * (`canvas_notification_choices`, a row only for someone who changed it).
 * docs/PRDs/2026-11-14_canvas-notices owns the design;
 * `docs/push-notifications.md` owns delivery.
 *
 * Part of WorkspaceDO migration 150, which also admits the `canvas_notice`
 * kind on the notification intents and Activity. SQLite cannot alter a CHECK
 * in place, so each table is rebuilt as migration 146 rebuilt them, with every
 * index and trigger the drop took; 146 stays as shipped. The rebuild drops the
 * kind lists from both CHECKs: the kinds grow with the product, every one
 * before this cost both tables a full copy in every Organization, and the
 * contracts' kind enums already refuse an unknown kind on write and on read.
 */
export const CANVAS_NOTICE_KIND_STATEMENTS: readonly string[] = [
  `CREATE TABLE workstream_notification_intents_v149 (
    intent_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    workstream_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    source_generation INTEGER NOT NULL CHECK (source_generation > 0),
    source_version INTEGER NOT NULL CHECK (source_version > 0),
    required_directory_version INTEGER NOT NULL CHECK (required_directory_version > 0),
    notification_kind TEXT NOT NULL CHECK (length(notification_kind) > 0),
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
  `INSERT INTO workstream_notification_intents_v149
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
  `ALTER TABLE workstream_notification_intents_v149 RENAME TO workstream_notification_intents`,
  `CREATE INDEX workstream_notification_intents_delivery_idx
    ON workstream_notification_intents(state, lease_expires_at, created_at, intent_id)`,
  `CREATE INDEX workstream_notification_intents_terminal_idx
    ON workstream_notification_intents(workstream_id, state, created_at)`,
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
  `CREATE TABLE workspace_activity_items_v149 (
    item_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (length(kind) > 0),
    parent_kind TEXT NOT NULL CHECK (parent_kind IN ('canvas', 'automation')),
    parent_id TEXT NOT NULL,
    substream_id TEXT,
    message_id TEXT,
    message_sequence INTEGER CHECK (message_sequence IS NULL OR message_sequence > 0),
    run_id TEXT,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('person', 'rally', 'sidekick')),
    actor_id TEXT,
    preview TEXT,
    attention_ordinal INTEGER CHECK (attention_ordinal IS NULL OR attention_ordinal >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    subject_id TEXT
  ) STRICT`,
  `INSERT INTO workspace_activity_items_v149
     (item_id, workspace_id, recipient_user_id, kind, parent_kind, parent_id, substream_id, message_id,
      message_sequence, run_id, actor_kind, actor_id, preview, attention_ordinal, created_at, subject_id)
   SELECT item_id, workspace_id, recipient_user_id, kind, parent_kind, parent_id, substream_id, message_id,
      message_sequence, run_id, actor_kind, actor_id, preview, attention_ordinal, created_at, subject_id
     FROM workspace_activity_items`,
  `DROP TABLE workspace_activity_items`,
  `ALTER TABLE workspace_activity_items_v149 RENAME TO workspace_activity_items`,
  `CREATE INDEX workspace_activity_items_recipient_idx
    ON workspace_activity_items(recipient_user_id, created_at DESC)`,
  `CREATE INDEX workspace_activity_items_parent_idx
    ON workspace_activity_items(recipient_user_id, parent_id)`,
];

export const CANVAS_NOTICES_SCHEMA_STATEMENTS: readonly string[] = [
  ...CANVAS_NOTICE_KIND_STATEMENTS,
  `CREATE TABLE canvas_notice_registrations (
    canvas_id TEXT PRIMARY KEY,
    purpose TEXT NOT NULL CHECK (length(purpose) > 0),
    registered_by_kind TEXT NOT NULL CHECK (registered_by_kind IN ('rally', 'sidekick')),
    registered_by_id TEXT,
    registered_by_name TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    record_message_id TEXT,
    registered_at INTEGER NOT NULL CHECK (registered_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT`,
  `CREATE TABLE canvas_notice_operations (
    operation_id TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0)
  ) STRICT`,
  `CREATE INDEX canvas_notice_operations_canvas_idx ON canvas_notice_operations(canvas_id)`,
  `CREATE TABLE canvas_notification_choices (
    canvas_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    channels_json TEXT NOT NULL CHECK (json_valid(channels_json) AND json_type(channels_json) = 'array'),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    PRIMARY KEY (canvas_id, user_id)
  ) STRICT`,
];

interface RegistrationRow extends Record<string, SqlStorageValue> {
  purpose: string;
  registered_by_kind: "rally" | "sidekick";
  registered_by_id: string | null;
  registered_by_name: string;
  revision: number;
  /** The Chat's record of this registration, once it has landed. */
  record_message_id: string | null;
  updated_at: number;
}

/** Who turned a Canvas's notices on, or sends one: Rally in its Chat, or a Sidekick. */
export interface CanvasNoticeAgent {
  kind: "rally" | "sidekick";
  id: string | null;
  name: string;
}

/** The Canvas's registration, or `undefined` while its notices are off. */
export function canvasNoticeRegistration(sql: SqlStorage, canvasId: string): RegistrationRow | undefined {
  return sql.exec<RegistrationRow>(
    `SELECT purpose, registered_by_kind, registered_by_id, registered_by_name, revision, record_message_id, updated_at
       FROM canvas_notice_registrations WHERE canvas_id = ?`, canvasId,
  ).toArray()[0];
}

/**
 * Record that a Canvas's notices are on, as a new revision, for the register
 * call `operationId`, before its record is written to the Chat: a screen that
 * sees the record then always finds the registration. Its record lands after.
 */
export function writeCanvasNoticeRegistration(sql: SqlStorage, input: {
  canvasId: string; purpose: string; agent: CanvasNoticeAgent; revision: number; operationId: string; now: number;
}): void {
  sql.exec(
    `INSERT INTO canvas_notice_registrations
       (canvas_id, purpose, registered_by_kind, registered_by_id, registered_by_name, revision, record_message_id, registered_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(canvas_id) DO UPDATE SET purpose = excluded.purpose, registered_by_kind = excluded.registered_by_kind,
       registered_by_id = excluded.registered_by_id, registered_by_name = excluded.registered_by_name,
       revision = excluded.revision, record_message_id = NULL, updated_at = excluded.updated_at`,
    input.canvasId, input.purpose, input.agent.kind, input.agent.id,
    truncateUtf16Safe(input.agent.name, NAME_SNAPSHOT_CHARACTERS), input.revision, input.now, input.now,
  );
  sql.exec(`INSERT INTO canvas_notice_operations (operation_id, canvas_id, revision) VALUES (?, ?, ?)`,
    input.operationId, input.canvasId, input.revision);
}

/** The revision a register call wrote, or `undefined` if it never wrote one. */
export function canvasNoticeOperationRevision(sql: SqlStorage, operationId: string): number | undefined {
  return sql.exec<{ revision: number }>(`SELECT revision FROM canvas_notice_operations WHERE operation_id = ?`, operationId)
    .toArray()[0]?.revision;
}

/** Note the Chat's record of a revision, unless a newer revision has replaced it since. */
export function noteCanvasNoticeRecord(sql: SqlStorage, canvasId: string, revision: number, messageId: string): void {
  sql.exec(`UPDATE canvas_notice_registrations SET record_message_id = ? WHERE canvas_id = ? AND revision = ?`,
    messageId, canvasId, revision);
}

/** The channels this person chose for this Canvas's notices, or `undefined` while they follow Settings. */
export function canvasNoticeOverride(sql: SqlStorage, canvasId: string, userId: string): NotificationChannel[] | undefined {
  const row = sql.exec<{ channels_json: string }>(
    `SELECT channels_json FROM canvas_notification_choices WHERE canvas_id = ? AND user_id = ?`, canvasId, userId,
  ).toArray()[0];
  if (!row) return undefined;
  return (JSON.parse(row.channels_json) as unknown[]).filter((channel): channel is NotificationChannel =>
    channel === "push" || channel === "email");
}

/** Choose this person's channels for this Canvas, or follow Settings again with `null`; an empty list mutes it. */
export function writeCanvasNoticeChoice(sql: SqlStorage, input: {
  canvasId: string; userId: string; channels: readonly NotificationChannel[] | null; now: number;
}): void {
  if (input.channels === null) {
    sql.exec(`DELETE FROM canvas_notification_choices WHERE canvas_id = ? AND user_id = ?`, input.canvasId, input.userId);
    return;
  }
  sql.exec(
    `INSERT INTO canvas_notification_choices (canvas_id, user_id, channels_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(canvas_id, user_id) DO UPDATE SET channels_json = excluded.channels_json, updated_at = excluded.updated_at`,
    input.canvasId, input.userId, JSON.stringify([...new Set(input.channels)]), input.now,
  );
}

/** A Canvas's notices as one viewer sees them, or `null` while they are off. */
export function canvasNoticesView(sql: SqlStorage, canvasId: string, userId: string,
  participant: () => boolean): CanvasNoticesView | null {
  const registration = canvasNoticeRegistration(sql, canvasId);
  // Most Canvases send no notices; they pay one primary-key read.
  if (!registration) return null;
  return {
    purpose: registration.purpose,
    registeredBy: { kind: registration.registered_by_kind, name: registration.registered_by_name },
    participant: participant(),
    channels: canvasNoticeOverride(sql, canvasId, userId) ?? null,
    updatedAt: registration.updated_at,
  };
}

export interface CanvasNoticeHost {
  env: Env;
  storage: DurableObjectStorage;
  noteActivityChanged: NoteActivity;
}

/**
 * Tell a Canvas's participants that something happened: its creator and
 * everyone on its list, less anyone who muted it. One `canvas_notice` intent
 * and Activity row each, keyed on the send (`sourceId`), so a retried send
 * records nothing twice and enqueues again, which the push receipts make
 * harmless. Each person's channels are their choice for this Canvas, else
 * their Settings; both channels together send a push when one can be queued
 * and email otherwise. Answers how many people it was recorded for.
 */
export async function tellCanvasParticipants(host: CanvasNoticeHost, input: {
  workspaceId: string; canvasId: string; canvasTitle: string; generation: number; createdByUserId: string;
  sender: CanvasNoticeAgent; title: string; body: string; sourceId: string;
}): Promise<number> {
  const sql = host.storage.sql;
  const listed = new Set<string>([input.createdByUserId, ...sql.exec<{ user_id: string }>(
    `SELECT user_id FROM canvas_participants WHERE canvas_id = ?`, input.canvasId,
  ).toArray().map((row) => row.user_id)]);
  // Each person's own choice for this Canvas, read once: a mute leaves them out.
  const overrides = new Map([...listed].map((userId) => [userId, canvasNoticeOverride(sql, input.canvasId, userId)]));
  const recipients = [...listed].filter((userId) => overrides.get(userId)?.length !== 0);
  if (recipients.length === 0) return 0;
  const notice: ParentNotice = {
    kind: "canvas_notice", parentId: input.canvasId, parentTitle: input.canvasTitle,
    senderKind: input.sender.kind, senderName: truncateUtf16Safe(input.sender.name, NAME_SNAPSHOT_CHARACTERS), title: input.title, body: input.body,
  };
  const payloadJson = JSON.stringify(notice);
  const payloadHash = await sha256(payloadJson);
  const now = Date.now();
  const recorded = host.storage.transactionSync(() => recipients.map((recipientUserId) => ({
    recipientUserId,
    ...recordParentNotice(host.storage, {
      workspaceId: input.workspaceId, parentId: input.canvasId, generation: input.generation, kind: "canvas_notice",
      recipientUserId, intentId: `${input.sourceId}:${recipientUserId}`, sourceId: input.sourceId, payloadJson, payloadHash,
      skipCode: null, collapse: false,
      activity: {
        parentKind: "canvas", parentId: input.canvasId, substreamId: "0", messageId: null, runId: null,
        actorKind: input.sender.kind, actorId: input.sender.id, text: input.title, subjectId: null,
      },
    }, now, host.noteActivityChanged),
  })));
  // Each recipient's queueing is independent; the agent waits on all of them.
  await Promise.all(recorded.filter((intent) => intent.push).map((intent) => enqueueNotice(host.env,
    { workspaceId: input.workspaceId, recipientUserId: intent.recipientUserId, intentId: intent.intentId },
    overrides.get(intent.recipientUserId) ?? chosenChannels(sql, intent.recipientUserId, "canvas_notice"), { pushElseEmail: true })));
  logInfo(host.env, "canvas_notice_recorded", { canvas_id: input.canvasId, recipients: recorded.length });
  return recorded.length;
}
