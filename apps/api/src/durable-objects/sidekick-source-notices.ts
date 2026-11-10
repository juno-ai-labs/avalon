import type { SidekickSourceRequest } from "@rally/contracts";
import { sourceConnectorName } from "@rally/contracts/sidekick-source-words";
import { truncateUtf16Safe } from "@rally/contracts/text";

import type { Env } from "../env";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { sha256 } from "../lib/crypto";
import { enqueueNotice } from "../services/push-delivery-service";
import { NAME_SNAPSHOT_CHARACTERS } from "./canvas-access-requests";
import { chosenChannels } from "./member-preferences";
import type { ParentNotice } from "./workspace-notification-intent-protocol";
import { recordParentNotice } from "./workspace-notification-intent-storage";

/**
 * Part of WorkspaceDO migration 145: what a Sidekick source request tells
 * people. It runs after `SIDEKICK_SOURCE_SCHEMA_STATEMENTS`, which makes
 * `sidekick_source_requests`.
 *
 * The notification intents and Activity each admit three more kinds:
 * `source_request` (a person was asked), `source_approved` and
 * `source_declined` (the person asked answered, told to whoever asked).
 * SQLite cannot alter a CHECK in place, so each table is rebuilt once, as
 * migration 138 rebuilt the intents: new table, copy, drop, rename, then the
 * indexes and identity-fence triggers the drop took with it. Neither table is
 * a foreign-key parent or child, and no view or trigger elsewhere names
 * either. Migrations 138 and 140 stay as shipped.
 *
 * `person_name` is the asked person's name as it stood when they answered, so
 * the requester's Activity row names them without a read of D1; null until
 * they answer, and for a request cancelled by a newer one.
 *
 * `docs/activity.md` and `docs/push-notifications.md` own the kinds.
 */
export const SIDEKICK_SOURCE_NOTICE_SCHEMA_STATEMENTS: readonly string[] = [
  `ALTER TABLE sidekick_source_requests ADD COLUMN person_name TEXT`,
  `CREATE TABLE workstream_notification_intents_v145 (
    intent_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    workstream_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    source_generation INTEGER NOT NULL CHECK (source_generation > 0),
    source_version INTEGER NOT NULL CHECK (source_version > 0),
    required_directory_version INTEGER NOT NULL CHECK (required_directory_version > 0),
    notification_kind TEXT NOT NULL CHECK (notification_kind IN ('mention', 'participant_added', 'needs_input', 'run_finished',
      'new_message', 'artifact_updated', 'access_request', 'access_granted', 'access_denied',
      'source_request', 'source_approved', 'source_declined')),
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
  `INSERT INTO workstream_notification_intents_v145
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
  `ALTER TABLE workstream_notification_intents_v145 RENAME TO workstream_notification_intents`,
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
  `CREATE TABLE workspace_activity_items_v145 (
    item_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('mention', 'participant_added', 'needs_input', 'run_finished',
      'new_message', 'artifact_updated', 'access_request', 'access_granted', 'access_denied',
      'source_request', 'source_approved', 'source_declined')),
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
  `INSERT INTO workspace_activity_items_v145
     (item_id, workspace_id, recipient_user_id, kind, parent_kind, parent_id, substream_id, message_id,
      message_sequence, run_id, actor_kind, actor_id, preview, attention_ordinal, created_at, subject_id)
   SELECT item_id, workspace_id, recipient_user_id, kind, parent_kind, parent_id, substream_id, message_id,
      message_sequence, run_id, actor_kind, actor_id, preview, attention_ordinal, created_at, subject_id
     FROM workspace_activity_items`,
  `DROP TABLE workspace_activity_items`,
  `ALTER TABLE workspace_activity_items_v145 RENAME TO workspace_activity_items`,
  `CREATE INDEX workspace_activity_items_recipient_idx
    ON workspace_activity_items(recipient_user_id, created_at DESC)`,
  `CREATE INDEX workspace_activity_items_parent_idx
    ON workspace_activity_items(recipient_user_id, parent_id)`,
];

/** What a request's notices need from the Organization object that holds the Sidekick. */
export interface SidekickSourceNoticeHost {
  env: Env;
  storage: DurableObjectStorage;
  /** The asked person's or the requester's Activity moved: publish their list. */
  noteActivityChanged(userId: string): void;
}

/** One notice, serialized and hashed before the transaction that records it. */
export interface PreparedSourceNotice {
  kind: "source_request" | "source_approved" | "source_declined";
  /** What the push body and the Activity row's preview say: the events, and the condition when there is one. */
  text: string;
  payloadJson: string;
  payloadHash: string;
}

/** An intent recorded for one person, to enqueue once its transaction has committed. */
export interface RecordedSourceNotice {
  kind: PreparedSourceNotice["kind"];
  recipientUserId: string;
  intentId: string;
  push: boolean;
}

/** What was asked, as a notice names it. */
export interface SourceNoticeAsk {
  sidekickId: string;
  sidekickName: string;
  connectorType: string;
  eventTypes: readonly string[];
  condition: string | null;
}

/**
 * What a source request's notice says under its title, for a push's body, an
 * email's quote and an Activity row's preview alike: which events, and the
 * person's condition when one was asked. Pure, so its words are tested as
 * words.
 */
export function sourceNoticeText(ask: { eventLabels: readonly string[]; condition: string | null }): string {
  const events = ask.eventLabels.length > 0 ? `Events: ${ask.eventLabels.join(", ")}` : "";
  const condition = ask.condition ? `Only when: ${ask.condition}` : "";
  return [events, condition].filter((part) => part !== "").join(". ");
}

/**
 * The connector and its events by the names its manifest gives them, the
 * connector as a person calls the product those events belong to ("Gmail" for
 * Google's mail events, `sourceConnectorName`). A connector or event this
 * deployment no longer declares is named by its type, which is what the
 * request stored.
 */
export function sourceNoticeNames(env: Env, connectorType: string, eventTypes: readonly string[]): { connectorName: string; eventLabels: string[] } {
  const manifest = connectorRegistryForEnv(env).list().find((candidate) => candidate.type === connectorType);
  const labels = new Map(manifest?.activityTriggers.map((trigger) => [trigger.eventType, trigger.label]));
  return {
    connectorName: sourceConnectorName(connectorType, eventTypes, manifest?.displayName ?? connectorType),
    eventLabels: eventTypes.map((eventType) => labels.get(eventType) ?? eventType),
  };
}

async function prepare(notice: Extract<ParentNotice, { kind: PreparedSourceNotice["kind"] }>): Promise<PreparedSourceNotice> {
  const payloadJson = JSON.stringify(notice);
  return { kind: notice.kind, text: sourceNoticeText(notice), payloadJson, payloadHash: await sha256(payloadJson) };
}

function asked(env: Env, ask: SourceNoticeAsk, requestId: string) {
  return {
    parentId: ask.sidekickId, parentTitle: ask.sidekickName, requestId, connectorType: ask.connectorType,
    ...sourceNoticeNames(env, ask.connectorType, ask.eventTypes), condition: ask.condition,
  };
}

/**
 * The `source_request` notice for each request about to be made, by request
 * id. Taken before the transaction that makes the requests, because hashing
 * yields and a transaction may not.
 */
export async function prepareSourceRequestNotices(env: Env, ask: SourceNoticeAsk & { requesterName: string; requestIds: readonly string[] }): Promise<Map<string, PreparedSourceNotice>> {
  const requesterName = truncateUtf16Safe(ask.requesterName, NAME_SNAPSHOT_CHARACTERS);
  return new Map(await Promise.all(ask.requestIds.map(async (requestId) =>
    [requestId, await prepare({ kind: "source_request", ...asked(env, ask, requestId), requesterName })] as const)));
}

/**
 * The notice that tells whoever asked how the person answered. Taken before
 * the transaction that settles the request, from the request as it stands.
 */
export async function prepareSourceAnswerNotice(env: Env, input: {
  request: SidekickSourceRequest; sidekickName: string; state: "approved" | "declined"; personName: string;
}): Promise<PreparedSourceNotice> {
  const { request } = input;
  return prepare({
    kind: input.state === "approved" ? "source_approved" : "source_declined",
    ...asked(env, { sidekickId: request.sidekickId, sidekickName: input.sidekickName, connectorType: request.connectorType,
      eventTypes: request.eventTypes, condition: request.condition }, request.requestId),
    personName: truncateUtf16Safe(input.personName, NAME_SNAPSHOT_CHARACTERS),
  });
}

/**
 * A person was asked: one notice intent and one Activity row for them, whose
 * parent is the Sidekick and whose subject is the request. The caller holds
 * the transaction that made the request. The row is the request's actions
 * while it waits, so no read clears it: it is seen once the request is
 * settled, or by Mark all seen.
 */
export function recordSourceRequestAsked(host: SidekickSourceNoticeHost, input: {
  workspaceId: string; generation: number; request: SidekickSourceRequest; notice: PreparedSourceNotice; now: number;
}): RecordedSourceNotice[] {
  const { request, notice } = input;
  return [{
    kind: notice.kind, recipientUserId: request.userId,
    ...recordParentNotice(host.storage, {
      workspaceId: input.workspaceId, parentId: request.sidekickId, generation: input.generation, kind: notice.kind,
      recipientUserId: request.userId, intentId: `${notice.kind}:${request.requestId}`, sourceId: `${notice.kind}:${request.requestId}`,
      payloadJson: notice.payloadJson, payloadHash: notice.payloadHash, skipCode: null, collapse: false,
      activity: {
        parentKind: "automation", parentId: request.sidekickId, substreamId: "0", messageId: null, runId: null,
        actorKind: "person", actorId: request.requestedByUserId, text: notice.text, attentionOrdinal: null, subjectId: request.requestId,
      },
    }, input.now, (userId) => host.noteActivityChanged(userId)),
  }];
}

/**
 * A request stopped waiting: approved, declined, or cancelled because a newer
 * ask replaced it. The asked person's row reads as settled and seen from the
 * request's own state, so their list is published again. An approval or a
 * decline (`answer`) also names the person on the request and tells whoever
 * asked, with one intent and one Activity row; a cancel (`answer` null) tells
 * nobody, and neither does a person answering their own ask. The caller holds
 * the transaction that settled the request.
 */
export function recordSourceRequestSettled(host: SidekickSourceNoticeHost, input: {
  workspaceId: string; generation: number; request: SidekickSourceRequest;
  answer: { notice: PreparedSourceNotice; personName: string } | null; now: number;
}): RecordedSourceNotice[] {
  const { request, answer } = input;
  for (const row of host.storage.sql.exec<{ recipient_user_id: string }>(
    `SELECT recipient_user_id FROM workspace_activity_items WHERE kind = 'source_request' AND subject_id = ?`, request.requestId,
  ).toArray()) host.noteActivityChanged(row.recipient_user_id);
  if (answer === null) return [];
  host.storage.sql.exec(`UPDATE sidekick_source_requests SET person_name = ? WHERE request_id = ?`,
    truncateUtf16Safe(answer.personName, NAME_SNAPSHOT_CHARACTERS), request.requestId);
  if (request.requestedByUserId === request.userId) return [];
  const { notice } = answer;
  return [{
    kind: notice.kind, recipientUserId: request.requestedByUserId,
    ...recordParentNotice(host.storage, {
      workspaceId: input.workspaceId, parentId: request.sidekickId, generation: input.generation, kind: notice.kind,
      recipientUserId: request.requestedByUserId, intentId: `${notice.kind}:${request.requestId}`,
      sourceId: `${notice.kind}:${request.requestId}`, payloadJson: notice.payloadJson, payloadHash: notice.payloadHash,
      skipCode: null, collapse: false,
      // Cleared as a grant is: by a read of the Sidekick's conversation after it, or by Mark all seen.
      activity: {
        parentKind: "automation", parentId: request.sidekickId, substreamId: "0", messageId: null, runId: null,
        actorKind: "person", actorId: request.userId, text: notice.text, subjectId: request.requestId,
      },
    }, input.now, (userId) => host.noteActivityChanged(userId)),
  }];
}

/** After the commit: queue each recorded notice for the sinks its recipient chose. */
export async function enqueueSourceNotices(host: SidekickSourceNoticeHost, workspaceId: string, notices: readonly RecordedSourceNotice[]): Promise<void> {
  for (const notice of notices) {
    if (!notice.push) continue;
    await enqueueNotice(host.env, { workspaceId, recipientUserId: notice.recipientUserId, intentId: notice.intentId },
      chosenChannels(host.storage.sql, notice.recipientUserId, notice.kind));
  }
}
