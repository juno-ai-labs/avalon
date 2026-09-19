import { CONVERSATION_CHILDREN_SCHEMA_STATEMENTS } from "./conversation-parent-object";
import { OBJECT_RETIREMENT_SCHEMA_STATEMENTS } from "./object-retirement";
import { SCHEDULED_ALARM_SCHEMA_STATEMENTS } from "./scheduled-alarms";
import { SCOPE_GRANT_SCHEMA_STATEMENTS } from "./scope-grant-storage";
import { SCOPE_INVITATION_SCHEMA_STATEMENTS } from "./scope-invitation-storage";
import type { DurableObjectSqliteMigration } from "./sqlite-migrations";

/**
 * WorkstreamDO's append-only schema ledger.
 *
 * In its own module rather than beside the class because `SpaceDO` is the same
 * class under a different {@link ConversationParentRole}, and the role names
 * both ledgers. A role constant that imported this from `workstream-do.ts`
 * would close a cycle — `workstream-do.ts` imports the role — and the ledger
 * would be in its temporal dead zone at the moment the role was built.
 *
 * Every statement here is hashed into the `_sql_schema_migrations` receipt of
 * every deployed object, so nothing below may be edited; the next version is
 * appended instead. `space-do-schema.ts` renders the shape this ledger *ends*
 * at in one fresh version, and a Node test holds the two to the same schema.
 */
export const WORKSTREAM_DO_SCHEMA_MIGRATIONS: readonly DurableObjectSqliteMigration[] = [{
  version: 1,
  description: "workstream control-plane metadata, HyperSight coordination, and regional effects",
  statements: [
    `PRAGMA foreign_keys = ON`,
    `CREATE TABLE workstream_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL UNIQUE,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      revision INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      preview TEXT NOT NULL,
      email_address TEXT,
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      exact_state TEXT NOT NULL CHECK (exact_state IN (
        'scheduled', 'running', 'interrupting', 'preparing_context', 'waiting_capacity',
        'needs_input', 'completed', 'cancelled', 'failed', 'budget_exhausted',
        'idle', 'archived', 'deleting', 'restoring'
      )),
      origin_type TEXT NOT NULL DEFAULT 'ad_hoc'
        CHECK (origin_type IN ('ad_hoc', 'automation')),
      created_by_user_id TEXT,
      automation_subscription_id TEXT,
      automation_run_id TEXT,
      planned_for INTEGER CHECK (planned_for IS NULL OR planned_for >= 0),
      title_status TEXT NOT NULL DEFAULT 'settled'
        CHECK (title_status IN ('naming', 'automatic', 'settled')),
      system_kind TEXT CHECK (system_kind IS NULL OR system_kind = 'digest'),
      last_activity_at INTEGER NOT NULL CHECK (last_activity_at >= 0),
      completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
      archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0),
      latest_attention_ordinal INTEGER NOT NULL DEFAULT 0
        CHECK (latest_attention_ordinal >= 0),
      unread_tracking_start_ordinal INTEGER NOT NULL DEFAULT 0
        CHECK (unread_tracking_start_ordinal >= 0),
      next_wakeup_due_at INTEGER CHECK (next_wakeup_due_at IS NULL OR next_wakeup_due_at >= 0),
      next_wakeup_prompt TEXT,
      next_terminal_action_at INTEGER
        CHECK (next_terminal_action_at IS NULL OR next_terminal_action_at >= 0),
      source_created_at INTEGER NOT NULL DEFAULT 0 CHECK (source_created_at >= 0),
      source_updated_at INTEGER NOT NULL DEFAULT 0 CHECK (source_updated_at >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE substream_directory (
      substream_id TEXT PRIMARY KEY,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      payload_hash TEXT NOT NULL,
      effect_json TEXT NOT NULL CHECK (
        json_valid(effect_json) AND length(CAST(effect_json AS BLOB)) <= 1900000
      ),
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE substream_user_directory (
      substream_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      payload_hash TEXT NOT NULL,
      effect_json TEXT NOT NULL CHECK (
        json_valid(effect_json) AND length(CAST(effect_json AS BLOB)) <= 1900000
      ),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (substream_id, user_id)
    ) STRICT`,
    `CREATE INDEX substream_user_directory_user_idx
      ON substream_user_directory(user_id, substream_id)`,
    `CREATE TABLE child_effect_receipts (
      substream_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      PRIMARY KEY (substream_id, message_id)
    ) STRICT`,
    `CREATE TABLE projection_keys (
      projection_key TEXT PRIMARY KEY,
      next_version INTEGER NOT NULL CHECK (next_version > 0),
      last_payload_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE workstream_state_clock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      next_sequence INTEGER NOT NULL CHECK (next_sequence > 0),
      last_event_time INTEGER NOT NULL CHECK (last_event_time >= 0)
    ) STRICT`,
    `INSERT INTO workstream_state_clock(id, next_sequence, last_event_time)
      VALUES (1, 1, 0)`,
    `CREATE TABLE workstream_state_changes (
      sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
      state_key TEXT NOT NULL CHECK (length(state_key) BETWEEN 1 AND 180),
      waterline INTEGER NOT NULL CHECK (waterline > 0),
      event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND 180),
      payload_hash TEXT NOT NULL,
      state_json TEXT NOT NULL CHECK (json_valid(state_json) AND length(state_json) <= 262144),
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
      UNIQUE (state_key, waterline)
    ) STRICT`,
    `CREATE INDEX workstream_state_changes_latest_idx
      ON workstream_state_changes(state_key, waterline DESC)`,
    `CREATE TABLE durable_outbox (
      message_id TEXT PRIMARY KEY,
      partition_key TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      source_epoch INTEGER NOT NULL CHECK (source_epoch > 0),
      effect_kind TEXT NOT NULL CHECK (effect_kind IN (
        'directory_common', 'directory_user', 'suggestion_feedback',
        'activity_event', 'mention_notification'
      )),
      -- The payload budget matches the producing child outbox bound (just
      -- under the platform's 2 MB per-row BYTE ceiling, measured in bytes —
      -- length() on TEXT counts characters) so an envelope the child could
      -- commit is never one this parent must reject: a mid-chain rejection of
      -- an already durable effect is a permanent poison retry.
      payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 1900000
      ),
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'inflight')),
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX durable_outbox_delivery_idx
      ON durable_outbox(state, not_before, created_at, message_id)`,
    `CREATE TABLE workstream_socket_ticket_receipts (
      ticket_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX workstream_socket_ticket_receipts_expiry_idx
      ON workstream_socket_ticket_receipts(expires_at, ticket_id)`,
    `CREATE TABLE block_dashboard_configuration_versions (
      configuration_version_id TEXT PRIMARY KEY,
      version_number INTEGER NOT NULL UNIQUE CHECK (version_number > 0),
      blocks_json TEXT NOT NULL CHECK (json_valid(blocks_json) AND length(blocks_json) <= 262144),
      created_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE block_dashboard_block_runs (
      block_run_id TEXT PRIMARY KEY,
      configuration_version_id TEXT NOT NULL
        REFERENCES block_dashboard_configuration_versions(configuration_version_id) ON DELETE CASCADE,
      block_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      trigger_sequence INTEGER NOT NULL CHECK (trigger_sequence >= 0),
      harness_run_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'stopped')),
      markdown TEXT,
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      UNIQUE (configuration_version_id, block_id, trigger_sequence)
    ) STRICT`,
    `CREATE INDEX block_dashboard_block_runs_latest_idx
      ON block_dashboard_block_runs(block_id, trigger_sequence DESC, created_at DESC)`,
    `CREATE TABLE block_dashboard_user_preferences (
      user_id TEXT PRIMARY KEY,
      visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE block_dashboard_dispatch_outbox (
      block_run_id TEXT PRIMARY KEY REFERENCES block_dashboard_block_runs(block_run_id) ON DELETE CASCADE,
      block_id TEXT NOT NULL,
      dispatch_json TEXT NOT NULL CHECK (json_valid(dispatch_json) AND length(dispatch_json) <= 262144),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX block_dashboard_dispatch_outbox_due_idx
      ON block_dashboard_dispatch_outbox(not_before, created_at, block_run_id)`,
    `CREATE TABLE block_dashboard_block_result_receipts (
      block_run_id TEXT PRIMARY KEY REFERENCES block_dashboard_block_runs(block_run_id) ON DELETE CASCADE,
      block_id TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      payload_hash TEXT NOT NULL,
      received_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE block_dashboard_source_refresh_outbox (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      trigger_sequence INTEGER NOT NULL CHECK (trigger_sequence >= 0),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
  ],
}, {
  version: 2,
  description: "shared multi-alarm index behind this object's single alarm",
  statements: [...SCHEDULED_ALARM_SCHEMA_STATEMENTS],
}, {
  version: 3,
  description: "carry the participant-added notification through this object's outbox",
  statements: [
    // The outbox enumerates the effect kinds it will hold, and a person being
    // added to a work stream is a new one. Enumerating them is worth keeping:
    // this row is what a poison delivery would be stuck on, and a kind nobody
    // downstream handles should fail here rather than in a Queue consumer.
    //
    // SQLite cannot widen a CHECK in place, so the table is rebuilt. Version 1
    // still creates the narrow shape and must — its statements are hashed into
    // every deployed object's `_sql_schema_migrations` receipt, and editing
    // them throws `workstream_do_schema_hash_mismatch:1` in the constructor of
    // every work stream that ran an earlier release.
    `CREATE TABLE durable_outbox_kinds (
      message_id TEXT PRIMARY KEY,
      partition_key TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      source_epoch INTEGER NOT NULL CHECK (source_epoch > 0),
      effect_kind TEXT NOT NULL CHECK (effect_kind IN (
        'directory_common', 'directory_user', 'suggestion_feedback',
        'activity_event', 'mention_notification', 'participant_notification'
      )),
      payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 1900000
      ),
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'inflight')),
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    // An effect mid-flight keeps its place in the queue rather than being
    // dropped and rediscovered: this runs in the constructor, before the
    // object serves anything, so the copy is of a settled table.
    `INSERT INTO durable_outbox_kinds
       (message_id, partition_key, source_version, source_epoch, effect_kind,
        payload_json, payload_hash, state, attempts, not_before, created_at)
     SELECT message_id, partition_key, source_version, source_epoch, effect_kind,
        payload_json, payload_hash, state, attempts, not_before, created_at
       FROM durable_outbox`,
    `DROP TABLE durable_outbox`,
    `ALTER TABLE durable_outbox_kinds RENAME TO durable_outbox`,
    `CREATE INDEX durable_outbox_delivery_idx
      ON durable_outbox(state, not_before, created_at, message_id)`,
  ],
}, {
  version: 4,
  description: "retire context-suggestion deliveries from the durable outbox",
  statements: [
    `CREATE TABLE durable_outbox_without_suggestions (
      message_id TEXT PRIMARY KEY,
      partition_key TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      source_epoch INTEGER NOT NULL CHECK (source_epoch > 0),
      effect_kind TEXT NOT NULL CHECK (effect_kind IN (
        'directory_common', 'directory_user', 'activity_event',
        'mention_notification', 'participant_notification'
      )),
      payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 1900000
      ),
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'inflight')),
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `INSERT INTO durable_outbox_without_suggestions
       (message_id, partition_key, source_version, source_epoch, effect_kind,
        payload_json, payload_hash, state, attempts, not_before, created_at)
     SELECT message_id, partition_key, source_version, source_epoch, effect_kind,
            payload_json, payload_hash, state, attempts, not_before, created_at
       FROM durable_outbox WHERE effect_kind != 'suggestion_feedback'`,
    `DROP TABLE durable_outbox`,
    `ALTER TABLE durable_outbox_without_suggestions RENAME TO durable_outbox`,
    `CREATE INDEX durable_outbox_delivery_idx
      ON durable_outbox(state, not_before, created_at, message_id)`,
  ],
}, {
  version: 5,
  description: "remove retired block dashboard product state and pending deliveries",
  statements: [
    `DROP TABLE IF EXISTS block_dashboard_source_refresh_outbox`,
    `DROP TABLE IF EXISTS block_dashboard_dispatch_outbox`,
    `DROP TABLE IF EXISTS block_dashboard_block_result_receipts`,
    `DROP TABLE IF EXISTS block_dashboard_block_runs`,
    `DROP TABLE IF EXISTS block_dashboard_configuration_versions`,
    `DROP TABLE IF EXISTS block_dashboard_user_preferences`,
  ],
}, {
  version: 6,
  description: "register a child conversation before its first effect arrives",
  statements: [
    // Until now a child existed here only once its first `directory_common`
    // effect landed. Creation now reserves the main conversation before the
    // child object is initialized, and a run or side conversation is reserved
    // the same way, so the parent can list its children without waiting for
    // each to say something. The projection tables keep their shape; this is
    // the registry beside them.
    ...CONVERSATION_CHILDREN_SCHEMA_STATEMENTS,
  ],
}, {
  version: 7,
  description: "make private work-stream children parent-owned and retryable",
  statements: [
    `ALTER TABLE conversation_children ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'
      CHECK (status IN ('reserved', 'ready', 'failed'))`,
    `ALTER TABLE conversation_children ADD COLUMN title TEXT`,
    `ALTER TABLE conversation_children ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`,
    `CREATE TABLE private_child_preparations (
      operation_id TEXT PRIMARY KEY,
      substream_id TEXT NOT NULL UNIQUE REFERENCES conversation_children(substream_id) ON DELETE CASCADE,
      creator_user_id TEXT NOT NULL,
      request_json TEXT NOT NULL CHECK (json_valid(request_json)),
      capture_json TEXT CHECK (capture_json IS NULL OR json_valid(capture_json)),
      completed_parts_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(completed_parts_json)),
      prepared_context_json TEXT CHECK (prepared_context_json IS NULL OR json_valid(prepared_context_json)),
      status TEXT NOT NULL CHECK (status IN ('preparing', 'prepared', 'confirming', 'ready', 'failed')),
      error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE private_child_memberships (
      substream_id TEXT NOT NULL REFERENCES conversation_children(substream_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      version INTEGER NOT NULL CHECK (version > 0),
      added_by_user_id TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      removed_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (substream_id, user_id)
    ) STRICT`,
    `CREATE INDEX private_child_memberships_user_idx
      ON private_child_memberships(user_id, active, substream_id)`,
    `CREATE TABLE private_child_membership_effects (
      operation_id TEXT PRIMARY KEY,
      substream_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      membership_version INTEGER NOT NULL CHECK (membership_version > 0),
      state TEXT NOT NULL CHECK (state IN ('pending', 'inflight', 'delivered')),
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX private_child_membership_effects_due_idx
      ON private_child_membership_effects(state, not_before, created_at, operation_id)`,
  ],
}, {
  version: 8,
  description: "record a permanent retirement tombstone",
  statements: [
    // A retired workspace never reopens, and the fence in front of every
    // method here reads this table. It lives in the object rather than D1
    // because the gate answers during constructor recovery, before anything
    // else this object could consult is admitted.
    ...OBJECT_RETIREMENT_SCHEMA_STATEMENTS,
  ],
}, {
  version: 9,
  description: "let a private child be archived the way its work stream can be",
  statements: [
    // Archive is independent of creation readiness. Adding a timestamp preserves
    // the existing child roster and preparation rows without rebuilding their parent.
    `ALTER TABLE conversation_children
       ADD COLUMN archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0)`,
  ],
}, {
  version: 10,
  description: "durably deliver private child archive state to its executing room",
  statements: [
    `ALTER TABLE conversation_children ADD COLUMN lifecycle_version INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE conversation_children ADD COLUMN lifecycle_delivered_version INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE conversation_children ADD COLUMN lifecycle_not_before INTEGER NOT NULL DEFAULT 0`,
  ],
}, { version: 11, description: "allow configured deployment identifiers", statements: [
  "PRAGMA defer_foreign_keys = ON",
  "CREATE TABLE \"_region_copy_workstream_metadata\" AS SELECT * FROM \"workstream_metadata\"",
  "DELETE FROM \"workstream_metadata\"",
  "DROP TABLE \"workstream_metadata\"",
  "CREATE TABLE workstream_metadata (\n      id INTEGER PRIMARY KEY CHECK (id = 1),\n      workspace_id TEXT NOT NULL,\n      workstream_id TEXT NOT NULL UNIQUE,\n      region TEXT NOT NULL,\n      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),\n      revision INTEGER NOT NULL DEFAULT 0,\n      title TEXT NOT NULL,\n      description TEXT NOT NULL,\n      preview TEXT NOT NULL,\n      email_address TEXT,\n      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),\n      exact_state TEXT NOT NULL CHECK (exact_state IN (\n        'scheduled', 'running', 'interrupting', 'preparing_context', 'waiting_capacity',\n        'needs_input', 'completed', 'cancelled', 'failed', 'budget_exhausted',\n        'idle', 'archived', 'deleting', 'restoring'\n      )),\n      origin_type TEXT NOT NULL DEFAULT 'ad_hoc'\n        CHECK (origin_type IN ('ad_hoc', 'automation')),\n      created_by_user_id TEXT,\n      automation_subscription_id TEXT,\n      automation_run_id TEXT,\n      planned_for INTEGER CHECK (planned_for IS NULL OR planned_for >= 0),\n      title_status TEXT NOT NULL DEFAULT 'settled'\n        CHECK (title_status IN ('naming', 'automatic', 'settled')),\n      system_kind TEXT CHECK (system_kind IS NULL OR system_kind = 'digest'),\n      last_activity_at INTEGER NOT NULL CHECK (last_activity_at >= 0),\n      completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),\n      archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0),\n      latest_attention_ordinal INTEGER NOT NULL DEFAULT 0\n        CHECK (latest_attention_ordinal >= 0),\n      unread_tracking_start_ordinal INTEGER NOT NULL DEFAULT 0\n        CHECK (unread_tracking_start_ordinal >= 0),\n      next_wakeup_due_at INTEGER CHECK (next_wakeup_due_at IS NULL OR next_wakeup_due_at >= 0),\n      next_wakeup_prompt TEXT,\n      next_terminal_action_at INTEGER\n        CHECK (next_terminal_action_at IS NULL OR next_terminal_action_at >= 0),\n      source_created_at INTEGER NOT NULL DEFAULT 0 CHECK (source_created_at >= 0),\n      source_updated_at INTEGER NOT NULL DEFAULT 0 CHECK (source_updated_at >= 0),\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    ) STRICT",
  "INSERT INTO \"workstream_metadata\" SELECT * FROM \"_region_copy_workstream_metadata\"",
  "DROP TABLE \"_region_copy_workstream_metadata\"",
  "PRAGMA defer_foreign_keys = OFF"
]
}, {
  version: 12, description: "freeze private child historical content before publication", statements: [
    // Previously claimed operations had no prepared-history input. Null keeps their replay semantics.
    `ALTER TABLE private_child_preparations ADD COLUMN prepared_conversation_hash TEXT
      CHECK (prepared_conversation_hash IS NULL OR (length(prepared_conversation_hash) = 24 AND substr(prepared_conversation_hash, 1, 8) = 'fnv1a64:'))`,
  ],
}, {
  version: 13,
  description: "workspace Sidekicks recommended for a workstream",
  statements: [
    `CREATE TABLE workstream_sidekick_attachments (sidekick_id TEXT PRIMARY KEY, attached_at INTEGER NOT NULL) STRICT`,
  ],
}, {
  version: 14,
  description: "store versioned scope grants and preserve restricted child audiences",
  statements: [
    ...SCOPE_GRANT_SCHEMA_STATEMENTS,
    ...SCOPE_INVITATION_SCHEMA_STATEMENTS,
    `ALTER TABLE conversation_children ADD COLUMN audience TEXT NOT NULL DEFAULT 'restricted'
      CHECK (audience IN ('restricted', 'inherits_workstream'))`,
  ],
}, {
  version: 15,
  description: "deliver scope grant discovery through the parent outbox",
  statements: [
    `CREATE TABLE durable_outbox_with_scope_grants (
      message_id TEXT PRIMARY KEY,
      partition_key TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      source_epoch INTEGER NOT NULL CHECK (source_epoch > 0),
      effect_kind TEXT NOT NULL CHECK (effect_kind IN (
        'directory_common', 'directory_user', 'activity_event',
        'mention_notification', 'participant_notification', 'scope_grant_directory'
      )),
      payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 1900000
      ),
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'inflight')),
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `INSERT INTO durable_outbox_with_scope_grants
       SELECT * FROM durable_outbox`,
    `DROP TABLE durable_outbox`,
    `ALTER TABLE durable_outbox_with_scope_grants RENAME TO durable_outbox`,
    `CREATE INDEX durable_outbox_delivery_idx
      ON durable_outbox(state, not_before, created_at, message_id)`,
  ],
}, {
  version: 16,
  description: "receipt connector audience admission under grant authority",
  statements: [
    `CREATE TABLE connector_participant_admissions (
      event_id TEXT PRIMARY KEY, request_json TEXT NOT NULL CHECK(json_valid(request_json))
    ) STRICT`,
  ],
}, {
  version: 17,
  description: "retire intermediate grant discovery deliveries",
  statements: ["DELETE FROM scope_grant_deliveries WHERE delivered_at IS NOT NULL"],
}];
