import { CONVERSATION_CHILDREN_SCHEMA_STATEMENTS } from "./conversation-parent-object";
import { OBJECT_RETIREMENT_SCHEMA_STATEMENTS } from "./object-retirement";
import { SCHEDULED_ALARM_SCHEMA_STATEMENTS } from "./scheduled-alarms";
import { SCOPE_GRANT_SCHEMA_STATEMENTS } from "./scope-grant-storage";
import { SCOPE_INVITATION_SCHEMA_STATEMENTS } from "./scope-invitation-storage";
import type { DurableObjectSqliteMigration } from "./sqlite-migrations";
import { WORKSTREAM_ACCESS_SCHEMA_STATEMENTS } from "./workstream-access-storage";

/**
 * SpaceDO's append-only schema ledger, under its own component `space_do`.
 *
 * A Space is `WorkstreamDO` under a role, so it needs the same tables — the
 * class is the same code, and an inherited method that met a missing table
 * would fail at a request rather than at a deploy. What it does *not* need is
 * `workstream_do`'s seventeen versions: no Space object has ever existed, so
 * there is nothing to upgrade, and replaying a ledger that rebuilds
 * `durable_outbox` three times to reach its current shape would make every new
 * Space pay for history it never had.
 *
 * So this is one version rendering the shape that ledger *ends* at. The two are
 * held to that claim by `apps/api/test/space-do-schema.test.ts`, which applies
 * both against real migration runners and compares `sqlite_master` object for
 * object — the guard that matters, because the drift this file invites is a
 * column added to `workstream_do`'s next version and not to this one, and
 * nothing else in the tree would notice.
 *
 * A second component rather than sharing `workstream_do`: the migration runner
 * keys an object's ledger by component, and `forceMigration` refuses a command
 * whose `className` disagrees with the plan. Sharing one component would put
 * two classes with different version histories under one rollup and make the
 * tracker's per-component counts meaningless.
 *
 * **Version 1 is released and immutable like any other.** A change to the table
 * set lands as `workstream_do` version 18 *and* `space_do` version 2, and the
 * test above is what fails if only one of them is written.
 */
export const SPACE_DO_SCHEMA_MIGRATIONS: readonly DurableObjectSqliteMigration[] = [{
  version: 1,
  description: "space control-plane schema, rendered at the work-stream ledger's current shape",
  statements: [
    `PRAGMA foreign_keys = ON`,
    // `workstream_metadata` at its version-11 shape: `region` carries no CHECK,
    // so a configured deployment identifier is storable.
    `CREATE TABLE workstream_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL UNIQUE,
      region TEXT NOT NULL,
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
    // The outbox at its version-15 shape. A Space enqueues only
    // `directory_common` and `directory_user` — its role forwards nothing else
    // — but the CHECK is the work-stream one because the table is the same
    // table, and narrowing it here would be a second schema to keep in step for
    // a constraint the role already enforces in code.
    `CREATE TABLE durable_outbox (
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
    `CREATE INDEX durable_outbox_delivery_idx
      ON durable_outbox(state, not_before, created_at, message_id)`,
    // Never written: the Space role refuses a client socket upgrade before a
    // ticket is read. It exists because the method that consumes a ticket is
    // inherited, and a table missing under an inherited method is a runtime
    // failure rather than a compile one.
    `CREATE TABLE workstream_socket_ticket_receipts (
      ticket_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX workstream_socket_ticket_receipts_expiry_idx
      ON workstream_socket_ticket_receipts(expires_at, ticket_id)`,
    ...SCHEDULED_ALARM_SCHEMA_STATEMENTS,
    ...CONVERSATION_CHILDREN_SCHEMA_STATEMENTS,
    // The same `ALTER`s work-stream versions 7, 9, 10 and 14 applied, in the
    // order they applied them: the column order of a rebuilt table is part of
    // what the equality test compares.
    `ALTER TABLE conversation_children ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'
      CHECK (status IN ('reserved', 'ready', 'failed'))`,
    `ALTER TABLE conversation_children ADD COLUMN title TEXT`,
    `ALTER TABLE conversation_children ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE conversation_children
       ADD COLUMN archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0)`,
    `ALTER TABLE conversation_children ADD COLUMN lifecycle_version INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE conversation_children ADD COLUMN lifecycle_delivered_version INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE conversation_children ADD COLUMN lifecycle_not_before INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE conversation_children ADD COLUMN audience TEXT NOT NULL DEFAULT 'restricted'
      CHECK (audience IN ('restricted', 'inherits_workstream'))`,
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
    `ALTER TABLE private_child_preparations ADD COLUMN prepared_conversation_hash TEXT
      CHECK (prepared_conversation_hash IS NULL OR (length(prepared_conversation_hash) = 24 AND substr(prepared_conversation_hash, 1, 8) = 'fnv1a64:'))`,
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
    ...OBJECT_RETIREMENT_SCHEMA_STATEMENTS,
    `CREATE TABLE workstream_sidekick_attachments (sidekick_id TEXT PRIMARY KEY, attached_at INTEGER NOT NULL) STRICT`,
    // Grant rows are written on a Space exactly as they are on a Channel; what
    // the role suppresses is their *publication* to the shared grant directory.
    ...SCOPE_GRANT_SCHEMA_STATEMENTS,
    ...SCOPE_INVITATION_SCHEMA_STATEMENTS,
    `CREATE TABLE connector_participant_admissions (
      event_id TEXT PRIMARY KEY, request_json TEXT NOT NULL CHECK(json_valid(request_json))
    ) STRICT`,
  ],
}, {
  version: 2,
  description: "record the Space sources that reach a Channel and the readers each supplied",
  // The same array `workstream_do` 18 runs. A Space holds no Space sources of
  // its own — nothing adds a Space to a Space — but the class is the same code
  // and its ledgers converge on one schema, so the tables exist here and stay
  // empty.
  statements: [...WORKSTREAM_ACCESS_SCHEMA_STATEMENTS],
}];
