import { SUBSTREAM_PERSONAL_SYSTEM_PROMPT_MIGRATION } from "./personal-system-prompt";
import { CONVERSATION_LINK_SEARCH_SCHEMA } from './conversation-link-search';
import { TOOL_PAGE_SCHEMA, TOOL_PAGE_CONSUMER_INDEX } from './tool-page-storage';
import { PARTICIPANT_AUTHORITY_TRANSFER_SCHEMA } from "./participant-authority-transfer";
import { CONVERSATION_DISPLAY_SEARCH_MIGRATION_STATEMENTS, CONVERSATION_SEARCH_AUDIENCE_MIGRATION_STATEMENTS, CONVERSATION_SEARCH_REPROJECTION_MIGRATION_STATEMENTS, TRANSCRIPT_SEARCH_MIGRATION_STATEMENTS } from './search-projection-outbox';
/**
 * Object-local SQL schema for the existing one-room-per-work-stream namespace.
 *
 * The existing namespace migrates through `preparing` and becomes the
 * authoritative work-stream product store only after a maintenance-window
 * import verifies every normalized table. Regional D1 retains the route and
 * workspace authorization; WorkspaceDO owns cross-work-stream serving state.
 */

import { RESOURCE_RELATIONSHIP_TYPES } from "@rally/contracts";
import { SCHEDULED_ALARM_SCHEMA_STATEMENTS } from "./scheduled-alarms";
import { ORDERED_TRANSCRIPT_SCHEMA_V1 } from "./ordered-transcript-sqlite/schema-v1";
import { WORKSTREAM_RUNTIME_COMPAT_SCHEMA } from "./workstream-runtime-compat-schema";
import { AUTHORIZATION_PROJECTION_MIGRATION, AUTHORIZATION_PROJECTION_TIMING_MIGRATION } from './authorization-projection';
import { OBJECT_RETIREMENT_SCHEMA_STATEMENTS } from "./object-retirement";
import {
  applyDurableObjectSqliteMigrations,
  durableObjectMigrationHash,
  type DurableObjectSqliteMigration,
} from "./sqlite-migrations";

export const WORKSTREAM_OBJECT_CONTRACT_VERSION = 1;
export const WORKSTREAM_OBJECT_SCHEMA_VERSION = 77;

export type WorkstreamObjectSchemaMigration = DurableObjectSqliteMigration;

// Frozen for the v1 and v31 migration hashes. The current vocabulary no longer
// contains `suggested_activity`; migration 35 rebuilds the live table with the
// current contract after preserving accepted links as ordinary attachments.
const LEGACY_RESOURCE_RELATIONSHIP_TYPES = [
  "attachment",
  "message_attachment",
  "origin",
  "generated",
  "suggested_activity",
  "inbound_email",
  "context",
] as const;
const RESOURCE_RELATIONSHIP_CHECK_VALUES = LEGACY_RESOURCE_RELATIONSHIP_TYPES
  .map((relationshipType) => `'${relationshipType}'`)
  .join(", ");
const CURRENT_RESOURCE_RELATIONSHIP_CHECK_VALUES = RESOURCE_RELATIONSHIP_TYPES
  .map((relationshipType) => `'${relationshipType}'`)
  .join(", ");

const WORKSTREAM_SCHEMA_V1 = [
  `PRAGMA foreign_keys = ON`,
  `CREATE TABLE IF NOT EXISTS object_versions (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    worker_version_id TEXT NOT NULL,
    contract_version INTEGER NOT NULL CHECK (contract_version > 0),
    schema_version INTEGER NOT NULL CHECK (schema_version > 0),
    data_version INTEGER NOT NULL CHECK (data_version >= 0),
    projection_version INTEGER NOT NULL CHECK (projection_version >= 0),
    restore_generation INTEGER NOT NULL CHECK (restore_generation >= 0),
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS durable_outbox (
    message_id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    destination_kind TEXT NOT NULL CHECK (
      destination_kind IN ('durable_object', 'workflow', 'queue', 'regional_service')
    ),
    destination_id TEXT NOT NULL,
    partition_key TEXT NOT NULL,
    source_version INTEGER NOT NULL,
    source_epoch INTEGER NOT NULL,
    contract_version INTEGER NOT NULL,
    payload_json TEXT,
    payload_ref TEXT,
    payload_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'inflight', 'acked', 'superseded', 'dead')),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    not_before INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    acked_at INTEGER,
    CHECK ((payload_json IS NULL) != (payload_ref IS NULL)),
    CHECK (payload_json IS NULL OR json_valid(payload_json)),
    -- Matches the receiving parent's payload bound (just under the platform's
    -- 2 MB SQL row ceiling — a per-row BYTE limit, so the guard measures
    -- bytes; length() on TEXT counts characters and undercounts multibyte
    -- JSON). An effect too large for the parent must fail HERE, in the
    -- producing transaction, where the producer can shrink it — not at the
    -- parent, where the committed outbox row would retry the same oversized
    -- envelope forever.
    CHECK (payload_json IS NULL OR length(CAST(payload_json AS BLOB)) <= 1900000)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS durable_outbox_delivery_idx
     ON durable_outbox(state, not_before, created_at)`,
  `CREATE INDEX IF NOT EXISTS durable_outbox_destination_idx
     ON durable_outbox(channel, destination_kind, destination_id, partition_key, source_version)`,
  `CREATE TABLE IF NOT EXISTS durable_inbox_receipts (
    channel TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('durable_object', 'workflow', 'regional_service')),
    source_id TEXT NOT NULL,
    source_generation INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    partition_key TEXT NOT NULL,
    source_version INTEGER NOT NULL,
    source_epoch INTEGER NOT NULL,
    request_hash TEXT NOT NULL,
    result_code TEXT NOT NULL,
    result_hash TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (channel, source_kind, source_id, source_generation, message_id)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS durable_inbox_source_version_idx
     ON durable_inbox_receipts(
       channel, source_kind, source_id, partition_key, source_version DESC
     )`,
  `CREATE TABLE IF NOT EXISTS due_work (
    job_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    epoch INTEGER NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    last_error_code TEXT,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS due_work_due_idx ON due_work(due_at, job_key)`,
  `CREATE TABLE IF NOT EXISTS _data_migrations (
    campaign_id TEXT PRIMARY KEY,
    target_version INTEGER NOT NULL,
    phase TEXT NOT NULL,
    cursor TEXT,
    source_fence TEXT,
    source_hash TEXT,
    result_hash TEXT,
    pitr_bookmark TEXT,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    last_error_code TEXT,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS _migration_command_receipts (
    command_id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    command_kind TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result_hash TEXT NOT NULL,
    result_code TEXT NOT NULL,
    completed_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS workstream (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    workstream_key TEXT NOT NULL UNIQUE,
    parent_workspace_key TEXT NOT NULL,
    parent_do_id TEXT,
    parent_generation INTEGER NOT NULL DEFAULT 0 CHECK (parent_generation >= 0),
    region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
    authority_mode TEXT NOT NULL CHECK (
      authority_mode IN ('preparing', 'authoritative', 'quarantined')
    ),
    authority_generation INTEGER NOT NULL DEFAULT 0 CHECK (authority_generation >= 0),
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    preview TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
    exact_state TEXT NOT NULL CHECK (exact_state IN (
      'scheduled', 'running', 'interrupting', 'preparing_context', 'waiting_capacity',
      'needs_input', 'completed', 'cancelled', 'failed', 'budget_exhausted',
      'idle', 'archived', 'deleting', 'restoring'
    )),
    state_reason_code TEXT NOT NULL,
    next_sequence_number INTEGER NOT NULL CHECK (next_sequence_number > 0),
    next_attention_ordinal INTEGER NOT NULL CHECK (next_attention_ordinal > 0),
    unread_tracking_start_ordinal INTEGER NOT NULL DEFAULT 0
      CHECK (unread_tracking_start_ordinal >= 0),
    authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
    scope_epoch INTEGER NOT NULL CHECK (scope_epoch >= 0),
    source_authorization_floor INTEGER NOT NULL CHECK (source_authorization_floor >= 0),
    listing_epoch INTEGER NOT NULL CHECK (listing_epoch >= 0),
    deletion_epoch INTEGER NOT NULL CHECK (deletion_epoch >= 0),
    run_revision INTEGER NOT NULL CHECK (run_revision >= 0),
    created_at INTEGER NOT NULL,
    last_people_activity_at INTEGER NOT NULL,
    state_changed_at INTEGER NOT NULL,
    completed_at INTEGER,
    archived_at INTEGER,
    origin_type TEXT NOT NULL DEFAULT 'ad_hoc',
    created_by_user_id TEXT,
    automation_subscription_id TEXT,
    automation_run_id TEXT,
    planned_for INTEGER,
    email_address TEXT,
    email_route_status TEXT NOT NULL DEFAULT 'pending',
    created_from_opportunity_id TEXT,
    opportunity_version INTEGER,
    opportunity_display_prompt_hash TEXT,
    opportunity_execution_prompt_hash TEXT,
    description_source TEXT NOT NULL DEFAULT 'derived' CHECK (
      description_source IN ('authored', 'derived')
    ),
    system_kind TEXT,
    title_status TEXT NOT NULL DEFAULT 'settled' CHECK (
      title_status IN ('naming', 'automatic', 'settled')
    ),
    model_override TEXT,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS participants (
    user_id TEXT PRIMARY KEY,
    participation_reason TEXT NOT NULL CHECK (
      participation_reason IN ('creator', 'explicit', 'message', 'elicitation', 'action')
    ),
    added_by_user_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'removed')),
    participant_epoch INTEGER NOT NULL CHECK (participant_epoch >= 0),
    added_at INTEGER NOT NULL,
    removed_at INTEGER,
    updated_at INTEGER NOT NULL,
    CHECK ((status = 'active' AND removed_at IS NULL) OR (status = 'removed' AND removed_at IS NOT NULL))
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS participants_status_idx
     ON participants(status, participation_reason, user_id)`,
  `CREATE TABLE IF NOT EXISTS content_refs (
    content_ref_id TEXT PRIMARY KEY,
    storage_kind TEXT NOT NULL CHECK (storage_kind = 'r2'),
    regional_key TEXT NOT NULL UNIQUE,
    media_type TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    sha256 TEXT NOT NULL,
    authorization_scope_hash TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    fallback_summary TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('staging', 'ready', 'revoked', 'deleting', 'deleted')),
    retain_until INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS content_refs_retention_idx
     ON content_refs(status, retain_until)`,
  `CREATE INDEX IF NOT EXISTS content_refs_authorization_idx
     ON content_refs(authorization_scope_hash, status)`,
  `CREATE TABLE IF NOT EXISTS substreams (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('main', 'chat', 'agent')),
    inherit_mode TEXT NOT NULL CHECK (inherit_mode IN ('none', 'fork', 'document')),
    inherit_from_substream_id TEXT REFERENCES substreams(id),
    inherit_fence_seq INTEGER,
    depth INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 4),
    return_mode TEXT NOT NULL CHECK (return_mode IN ('none', 'tool_result')),
    origin_part_id TEXT REFERENCES parts(id),
    owner_user_id TEXT,
    audience TEXT NOT NULL CHECK (audience IN ('owner', 'workspace', 'system')),
    tool_policy TEXT NOT NULL CHECK (tool_policy IN ('none', 'read_only', 'full')),
    status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    created_at INTEGER NOT NULL,
    closed_at INTEGER,
    CHECK ((status = 'open' AND closed_at IS NULL) OR (status = 'closed' AND closed_at IS NOT NULL)),
    CHECK (inherit_from_substream_id IS NULL OR inherit_from_substream_id != id),
    CHECK (
      (inherit_mode = 'none' AND inherit_from_substream_id IS NULL AND inherit_fence_seq IS NULL)
      OR (inherit_mode = 'fork' AND inherit_from_substream_id IS NOT NULL
          AND inherit_fence_seq IS NOT NULL AND inherit_fence_seq >= 0)
      OR (inherit_mode = 'document' AND inherit_from_substream_id IS NOT NULL
          AND (inherit_fence_seq IS NULL OR inherit_fence_seq >= 0))
    ),
    CHECK (audience != 'owner' OR owner_user_id IS NOT NULL),
    CHECK (
      (id = '0' AND kind = 'main' AND inherit_mode = 'none' AND depth = 0
        AND return_mode = 'none' AND owner_user_id IS NULL AND audience = 'workspace'
        AND tool_policy = 'full' AND origin_part_id IS NULL
        AND inherit_from_substream_id IS NULL AND inherit_fence_seq IS NULL
        AND status = 'open' AND closed_at IS NULL)
      OR (id != '0' AND kind != 'main')
    )
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS substreams_kind_status_idx ON substreams(kind, status, id)`,
  `CREATE INDEX IF NOT EXISTS substreams_owner_idx
     ON substreams(owner_user_id, status, id) WHERE owner_user_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS substreams_parent_idx
     ON substreams(inherit_from_substream_id, id) WHERE inherit_from_substream_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS substreams_origin_part_uq
     ON substreams(origin_part_id) WHERE origin_part_id IS NOT NULL`,
  // `input_fence_seq` is the canonical transcript sequence of the participant
  // turn that admitted a root run; zero means the run has no participant input
  // (delegated/system work). It is not the room event or legacy message
  // sequence. Keep this comment outside the shipped v1 SQL fingerprint.
  `CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    substream_id TEXT NOT NULL REFERENCES substreams(id),
    workflow_instance_id TEXT UNIQUE,
    status TEXT NOT NULL CHECK (
      status IN ('admitted', 'running', 'waiting', 'steering', 'needs_input', 'completed', 'failed', 'cancelled')
    ),
    budget TEXT NOT NULL CHECK (json_valid(budget)),
    attempt_epoch INTEGER NOT NULL CHECK (attempt_epoch >= 0),
    model_iteration INTEGER NOT NULL CHECK (model_iteration >= 0),
    next_action_cursor TEXT NOT NULL,
    input_fence_seq INTEGER NOT NULL CHECK (input_fence_seq >= 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    started_at INTEGER NOT NULL,
    active_elapsed_ms INTEGER NOT NULL CHECK (active_elapsed_ms >= 0),
    idle_elapsed_ms INTEGER NOT NULL CHECK (idle_elapsed_ms >= 0),
    step_count INTEGER NOT NULL CHECK (step_count >= 0),
    subrequest_count INTEGER NOT NULL CHECK (subrequest_count >= 0),
    retry_count INTEGER NOT NULL CHECK (retry_count >= 0),
    tool_count INTEGER NOT NULL CHECK (tool_count >= 0),
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    cost_micros INTEGER NOT NULL CHECK (cost_micros >= 0),
    output_bytes INTEGER NOT NULL CHECK (output_bytes >= 0),
    terminal_reason TEXT,
    origin TEXT NOT NULL DEFAULT 'user_message',
    execution_principal_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(execution_principal_json)),
    parent_run_id TEXT,
    parent_tool_call_id TEXT,
    chain_root_run_id TEXT,
    chain_depth INTEGER NOT NULL DEFAULT 0 CHECK (chain_depth >= 0),
    model TEXT,
    usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    legacy_attempt_id TEXT,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    heartbeat_at INTEGER,
    cancellation_requested_at INTEGER,
    cancellation_reason TEXT,
    final_part_id TEXT,
    terminalized_at INTEGER,
    delegated_task_hash TEXT,
    inherited_scope_hash TEXT,
    child_result_json TEXT CHECK (child_result_json IS NULL OR json_valid(child_result_json)),
    child_result_hash TEXT,
    trigger_part_id TEXT,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS runs_substream_idx ON runs(substream_id, updated_at)`,
  // Detail reads walk runs newest-first (latest run, background-task page);
  // without these the walk is a full scan + sort that grows with run history.
  `CREATE INDEX IF NOT EXISTS runs_recency_idx ON runs(created_at DESC, run_id DESC)`,
  `CREATE INDEX IF NOT EXISTS runs_started_idx ON runs(started_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS runs_mutating_substream_uq
     ON runs(substream_id)
     WHERE status IN ('running', 'waiting', 'steering')`,
  `CREATE TABLE IF NOT EXISTS run_scopes (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL,
    execution_principal_json TEXT NOT NULL CHECK (json_valid(execution_principal_json)),
    eligible_connection_ids_json TEXT NOT NULL CHECK (json_valid(eligible_connection_ids_json)),
    eligible_capabilities_json TEXT NOT NULL CHECK (json_valid(eligible_capabilities_json)),
    eligible_connection_capabilities_json TEXT NOT NULL CHECK (json_valid(eligible_connection_capabilities_json)),
    trigger_policy_json TEXT NOT NULL CHECK (json_valid(trigger_policy_json)),
    routing_policy_version TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    tool_surface_hash TEXT NOT NULL,
    limits_json TEXT NOT NULL CHECK (json_valid(limits_json)),
    scope_hash TEXT NOT NULL,
    memory_context_hash TEXT,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS run_memory_contexts (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL,
    memory_scope_ids_json TEXT NOT NULL CHECK (json_valid(memory_scope_ids_json)),
    query_text TEXT NOT NULL,
    retrieval_mode TEXT NOT NULL,
    results_json TEXT NOT NULL CHECK (json_valid(results_json)),
    memory_context_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS run_plugin_activations (
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    tool_surface_hash TEXT NOT NULL,
    authorized_at INTEGER NOT NULL,
    activated_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, plugin_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS run_lifecycle_events (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL,
    event_key TEXT NOT NULL,
    event_type TEXT NOT NULL,
    status TEXT,
    member_safe_payload_json TEXT NOT NULL CHECK (json_valid(member_safe_payload_json)),
    created_at INTEGER NOT NULL,
    UNIQUE (run_id, event_key)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS run_lifecycle_events_run_idx
     ON run_lifecycle_events(run_id, created_at, event_id)`,
  `CREATE TABLE IF NOT EXISTS inference_attempts (
    inference_attempt_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    endpoint_attempt INTEGER NOT NULL CHECK (endpoint_attempt > 0),
    fallback_attempt INTEGER NOT NULL CHECK (fallback_attempt >= 0),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    credential_source_hash TEXT,
    workspace_identity_hash TEXT NOT NULL,
    routing_decision_json TEXT NOT NULL CHECK (json_valid(routing_decision_json)),
    outcome TEXT NOT NULL CHECK (
      outcome IN ('success', 'retry', 'defect', 'fallback', 'failed', 'cancelled')
    ),
    failure_classification TEXT,
    latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
    ttft_ms INTEGER CHECK (ttft_ms IS NULL OR ttft_ms >= 0),
    input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
    reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
    cached_tokens INTEGER CHECK (cached_tokens IS NULL OR cached_tokens >= 0),
    cost_micros INTEGER CHECK (cost_micros IS NULL OR cost_micros >= 0),
    response_bytes INTEGER CHECK (response_bytes IS NULL OR response_bytes >= 0),
    started_at INTEGER NOT NULL,
    completed_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS inference_attempts_run_idx
     ON inference_attempts(run_id, created_at, inference_attempt_id)`,
  `CREATE TABLE IF NOT EXISTS parts (
    id TEXT PRIMARY KEY,
    substream_id TEXT NOT NULL REFERENCES substreams(id),
    sequence_number INTEGER NOT NULL UNIQUE CHECK (sequence_number > 0),
    attention_ordinal INTEGER UNIQUE CHECK (attention_ordinal IS NULL OR attention_ordinal > 0),
    turn_id TEXT,
    turn_open_sequence INTEGER CHECK (turn_open_sequence IS NULL OR turn_open_sequence > 0),
    part_index INTEGER CHECK (part_index IS NULL OR part_index >= 0),
    role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool', 'note')),
    kind TEXT NOT NULL CHECK (kind IN (
      'text', 'tool_call', 'tool_result', 'attachment', 'terminal', 'steer_request',
      'input_admission', 'input_cancelled', 'compaction_start', 'compaction_complete'
    )),
    author_type TEXT NOT NULL CHECK (author_type IN ('member', 'agent', 'connector', 'system', 'external')),
    author_user_id TEXT,
    external_actor_json TEXT CHECK (
      external_actor_json IS NULL
      OR (json_valid(external_actor_json) AND length(external_actor_json) <= 16384)
    ),
    content TEXT CHECK (content IS NULL OR length(CAST(content AS BLOB)) <= 262144),
    content_ref_id TEXT REFERENCES content_refs(content_ref_id),
    content_bytes INTEGER CHECK (content_bytes IS NULL OR content_bytes > 0),
    content_hash TEXT,
    answers_part_id TEXT REFERENCES parts(id),
    input_part_ids_json TEXT CHECK (
      input_part_ids_json IS NULL
      OR (json_valid(input_part_ids_json) AND json_type(input_part_ids_json) = 'array'
          AND length(input_part_ids_json) <= 262144)
    ),
    client_message_id TEXT,
    effect_intent_id TEXT,
    occurrence_key TEXT,
    produced_by_run_id TEXT REFERENCES runs(run_id),
    attempt_epoch INTEGER,
    executor_event_seq INTEGER,
    model_turn_id TEXT,
    tool_position INTEGER,
    delivery_intent TEXT CHECK (delivery_intent IN ('queue', 'steer')),
    input_batch_id TEXT,
    admission_cut_seq INTEGER,
    tool_name TEXT,
    tool_mode TEXT CHECK (tool_mode IN ('read', 'write')),
    tool_status TEXT CHECK (tool_status IN ('pending', 'completed', 'failed', 'ambiguous')),
    compacts_through_sequence INTEGER,
    compacts_through_turn_id TEXT,
    projected_input_hash TEXT,
    projection_key TEXT,
    authorization_revisions_json TEXT CHECK (
      authorization_revisions_json IS NULL
      OR (json_valid(authorization_revisions_json)
          AND length(authorization_revisions_json) <= 262144)
    ),
    lineage_fences_json TEXT CHECK (
      lineage_fences_json IS NULL
      OR (json_valid(lineage_fences_json) AND length(lineage_fences_json) <= 262144)
    ),
    terminal_reason TEXT CHECK (terminal_reason IN (
      'completed', 'needs_input', 'failed', 'cancelled', 'budget', 'superseded_active_output'
    )),
    visibility TEXT NOT NULL CHECK (visibility IN ('people', 'model', 'both', 'system')),
    pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
    message_type TEXT NOT NULL DEFAULT 'text',
    structured_content_json TEXT CHECK (
      structured_content_json IS NULL
      OR (json_valid(structured_content_json) AND length(structured_content_json) <= 262144)
    ),
    edited_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
      (content IS NULL) != (content_ref_id IS NULL)
      OR (content IS NULL AND content_ref_id IS NULL AND kind IN (
        'input_admission', 'input_cancelled', 'compaction_start', 'compaction_complete'
      ))
    ),
    CHECK (content_ref_id IS NULL OR (content IS NULL AND content_bytes IS NOT NULL
      AND content_hash IS NOT NULL)),
    CHECK (attention_ordinal IS NULL OR (
      substream_id = '0' AND visibility IN ('people', 'both')
      AND kind NOT IN ('input_admission', 'input_cancelled', 'compaction_start', 'compaction_complete')
    )),
    CHECK (
      (author_type = 'member' AND author_user_id IS NOT NULL AND external_actor_json IS NULL)
      OR (author_type = 'external' AND author_user_id IS NULL AND external_actor_json IS NOT NULL)
      OR (author_type IN ('agent', 'connector', 'system')
          AND author_user_id IS NULL AND external_actor_json IS NULL)
    ),
    CHECK (kind NOT IN ('tool_call', 'tool_result') OR (
      tool_name IS NOT NULL AND tool_mode IS NOT NULL AND tool_status IS NOT NULL
    )),
    CHECK (kind != 'tool_call' OR (role = 'assistant' AND answers_part_id IS NULL)),
    CHECK (kind != 'tool_result' OR (
      role = 'tool' AND answers_part_id IS NOT NULL AND tool_status != 'pending'
    )),
    CHECK (
      kind IN ('tool_call', 'tool_result')
      OR (tool_name IS NULL AND tool_mode IS NULL AND tool_status IS NULL)
    ),
    CHECK (
      kind IN ('input_admission', 'input_cancelled')
      OR (input_part_ids_json IS NULL AND input_batch_id IS NULL AND admission_cut_seq IS NULL)
    ),
    CHECK (kind NOT IN ('input_admission', 'input_cancelled') OR (
      role = 'system' AND input_part_ids_json IS NOT NULL
      AND input_batch_id IS NOT NULL AND admission_cut_seq IS NOT NULL
    )),
    CHECK (
      kind IN ('compaction_start', 'compaction_complete')
      OR (compacts_through_sequence IS NULL AND compacts_through_turn_id IS NULL
          AND projected_input_hash IS NULL AND projection_key IS NULL
          AND authorization_revisions_json IS NULL AND lineage_fences_json IS NULL)
    ),
    CHECK (kind != 'terminal' OR terminal_reason IS NOT NULL),
    CHECK (kind = 'terminal' OR terminal_reason IS NULL),
    CHECK (delivery_intent IS NULL OR (role = 'user' AND kind = 'text')),
    CHECK (updated_at >= created_at),
    CHECK ((turn_id IS NULL AND turn_open_sequence IS NULL AND part_index IS NULL)
      OR (turn_id IS NOT NULL AND turn_open_sequence IS NOT NULL AND part_index IS NOT NULL)),
    UNIQUE (turn_id, part_index),
    UNIQUE (produced_by_run_id, attempt_epoch, executor_event_seq)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS parts_substream_sequence_idx
     ON parts(substream_id, sequence_number)`,
  `CREATE INDEX IF NOT EXISTS parts_content_ref_idx
     ON parts(content_ref_id) WHERE content_ref_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS parts_people_transcript_idx
     ON parts(substream_id, visibility, sequence_number)`,
  `CREATE INDEX IF NOT EXISTS parts_pending_input_idx
     ON parts(substream_id, sequence_number)
     WHERE role = 'user' AND turn_id IS NULL`,
  // Historical derived-content refreshes asked for the earliest pending tool
  // call on each source. Migration 38 removes this retired partial index.
  `CREATE INDEX IF NOT EXISTS parts_pending_tool_fence_idx
     ON parts(substream_id, sequence_number)
     WHERE kind = 'tool_call' AND tool_status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS parts_compaction_idx
     ON parts(substream_id, projection_key, compacts_through_sequence)
     WHERE kind = 'compaction_complete'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS parts_client_message_uq
     ON parts(client_message_id) WHERE client_message_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS parts_effect_intent_uq
     ON parts(effect_intent_id) WHERE effect_intent_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS parts_occurrence_uq
     ON parts(occurrence_key) WHERE occurrence_key IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS parts_answer_uq
     ON parts(answers_part_id) WHERE answers_part_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS part_attachments (
    part_id TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
    resource_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    attachment_json TEXT NOT NULL CHECK (
      json_valid(attachment_json) AND length(attachment_json) <= 262144
    ),
    PRIMARY KEY (part_id, resource_id),
    UNIQUE (part_id, position)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS part_attachments_resource_idx
     ON part_attachments(resource_id, part_id)`,
  `CREATE TABLE IF NOT EXISTS part_mentions (
    part_id TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
    mention_index INTEGER NOT NULL CHECK (mention_index >= 0),
    mention_kind TEXT NOT NULL CHECK (mention_kind IN ('person', 'connector')),
    target_user_id TEXT,
    connector_type TEXT,
    start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
    end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
    attention_ordinal INTEGER NOT NULL,
    PRIMARY KEY (part_id, mention_index),
    CHECK (
      (mention_kind = 'person' AND target_user_id IS NOT NULL AND connector_type IS NULL)
      OR (mention_kind = 'connector' AND target_user_id IS NULL AND connector_type IS NOT NULL)
    )
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS part_mentions_user_attention_idx
     ON part_mentions(target_user_id, attention_ordinal)`,
  `CREATE TABLE IF NOT EXISTS member_attention (
    user_id TEXT PRIMARY KEY,
    unread_tracking_start_ordinal INTEGER NOT NULL,
    seen_attention_ordinal INTEGER NOT NULL,
    manual_unread_from_ordinal INTEGER,
    latest_mention_attention_ordinal INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 0),
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS tool_effects (
    effect_intent_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    attempt_epoch INTEGER NOT NULL,
    tool_position INTEGER NOT NULL,
    occurrence_key TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('read', 'write')),
    request_hash TEXT NOT NULL,
    authority_revision TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('admitted', 'executing', 'completed', 'failed', 'ambiguous')),
    result_part_id TEXT REFERENCES parts(id),
    provider_operation_id TEXT,
    started_at INTEGER,
    settled_at INTEGER,
    result_hash TEXT,
    tool_call_id TEXT NOT NULL,
    connection_id TEXT,
    input_json TEXT NOT NULL CHECK (json_valid(input_json)),
    output_ref TEXT,
    output_summary TEXT,
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    execution_plan_hash TEXT,
    execution_plan_json TEXT CHECK (execution_plan_json IS NULL OR json_valid(execution_plan_json)),
    provider_idempotency_key TEXT,
    checkpoint_index INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_index >= 0),
    UNIQUE (run_id, attempt_epoch, tool_position)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS tool_effects_status_idx ON tool_effects(status, started_at)`,
  `CREATE TABLE IF NOT EXISTS tool_effect_checkpoints (
    checkpoint_id TEXT PRIMARY KEY,
    effect_intent_id TEXT NOT NULL REFERENCES tool_effects(effect_intent_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL,
    checkpoint_index INTEGER NOT NULL CHECK (checkpoint_index >= 0),
    phase TEXT NOT NULL,
    member_safe_payload_json TEXT NOT NULL CHECK (json_valid(member_safe_payload_json)),
    created_at INTEGER NOT NULL,
    UNIQUE (effect_intent_id, checkpoint_index)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS tool_effect_checkpoints_run_idx
     ON tool_effect_checkpoints(run_id, created_at, checkpoint_id)`,
  `CREATE TABLE IF NOT EXISTS plugin_activation_hints (
    plugin_id TEXT PRIMARY KEY,
    activated_at INTEGER NOT NULL,
    last_authorized_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS terminal_workspace (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    provider TEXT NOT NULL CHECK (provider = 'daytona'),
    sandbox_id TEXT,
    lifecycle_state TEXT NOT NULL CHECK (
      lifecycle_state IN (
        'absent', 'starting', 'running', 'stopping', 'stopped', 'archiving',
        'archived', 'restoring', 'expiring', 'expired', 'failed'
      )
    ),
    authority_epoch INTEGER NOT NULL,
    last_command_at INTEGER,
    idle_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
    stable_name TEXT,
    applied_network_revision INTEGER NOT NULL DEFAULT 0 CHECK (applied_network_revision >= 0),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    lifecycle_json TEXT CHECK (lifecycle_json IS NULL OR json_valid(lifecycle_json)),
    CHECK (lifecycle_state != 'absent' OR sandbox_id IS NULL)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS terminal_commands (
    command_id TEXT PRIMARY KEY,
    effect_intent_id TEXT NOT NULL UNIQUE REFERENCES tool_effects(effect_intent_id),
    sandbox_id TEXT NOT NULL,
    provider_command_id TEXT,
    request_hash TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1 AND 900000),
    status TEXT NOT NULL CHECK (
      status IN ('starting', 'running', 'completed', 'failed', 'timed_out', 'cancelled', 'ambiguous')
    ),
    stdout_ref TEXT,
    stderr_ref TEXT,
    exit_code INTEGER,
    result_hash TEXT,
    started_at INTEGER NOT NULL,
    settled_at INTEGER
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS terminal_commands_status_idx
     ON terminal_commands(status, started_at)`,
  `CREATE INDEX IF NOT EXISTS terminal_commands_provider_idx
     ON terminal_commands(sandbox_id, provider_command_id)`,
  `CREATE TABLE IF NOT EXISTS terminal_tasks (
    task_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    effect_intent_id TEXT NOT NULL UNIQUE REFERENCES tool_effects(effect_intent_id) ON DELETE CASCADE,
    sandbox_generation INTEGER NOT NULL CHECK (sandbox_generation >= 1),
    provider_task_name TEXT NOT NULL UNIQUE,
    provider_task_id TEXT,
    state TEXT NOT NULL CHECK (
      state IN ('planned', 'submitting', 'running', 'completed', 'failed', 'timed_out', 'cancelled')
    ),
    command_sha256 TEXT NOT NULL,
    command_deadline_at INTEGER NOT NULL,
    exit_code INTEGER,
    termination_reason TEXT CHECK (
      termination_reason IS NULL OR termination_reason IN (
        'exited', 'timed_out', 'cancelled', 'output_limit_exceeded'
      )
    ),
    stdout_head TEXT NOT NULL,
    stdout_tail TEXT NOT NULL,
    stderr_head TEXT NOT NULL,
    stderr_tail TEXT NOT NULL,
    stdout_bytes INTEGER NOT NULL CHECK (stdout_bytes >= 0),
    stderr_bytes INTEGER NOT NULL CHECK (stderr_bytes >= 0),
    output_resource_id TEXT,
    continuation_emitted_at INTEGER,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS terminal_tasks_state_idx
     ON terminal_tasks(state, command_deadline_at, task_id)`,
  `CREATE TABLE IF NOT EXISTS terminal_imported_resources (
    sandbox_generation INTEGER NOT NULL CHECK (sandbox_generation >= 1),
    resource_id TEXT NOT NULL,
    destination_path TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    state TEXT NOT NULL CHECK (state IN ('planned', 'completed')),
    imported_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (sandbox_generation, resource_id, destination_path)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS terminal_publication_grants (
    grant_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    source_part_id TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
    principal_key TEXT NOT NULL,
    repository_full_name TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    head_ref TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_by_effect_intent_id TEXT REFERENCES tool_effects(effect_intent_id) ON DELETE SET NULL,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (run_id, source_part_id, repository_full_name)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS terminal_publication_grants_expiry_idx
     ON terminal_publication_grants(expires_at, consumed_at)`,
  `CREATE TABLE IF NOT EXISTS terminal_repository (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    connection_id TEXT NOT NULL,
    repository_id INTEGER NOT NULL CHECK (repository_id > 0),
    repository_full_name TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    head_ref TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('selected', 'revoked')),
    bootstrapped_sandbox_generation INTEGER,
    read_token_expires_at INTEGER,
    selected_by_user_id TEXT NOT NULL,
    remote_access TEXT NOT NULL DEFAULT 'full_access'
      CHECK (remote_access IN ('read_only', 'full_access')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS repository_publications (
    publication_id TEXT PRIMARY KEY,
    effect_intent_id TEXT NOT NULL UNIQUE REFERENCES tool_effects(effect_intent_id) ON DELETE CASCADE,
    grant_id TEXT NOT NULL REFERENCES terminal_publication_grants(grant_id) ON DELETE RESTRICT,
    repository_full_name TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    head_ref TEXT NOT NULL,
    expected_old_sha TEXT,
    requested_commit_sha TEXT NOT NULL,
    published_sha TEXT,
    state TEXT NOT NULL CHECK (
      state IN ('planned', 'validating', 'publishing', 'completed', 'failed', 'ambiguous')
    ),
    pull_request_number INTEGER,
    pull_request_url TEXT,
    pull_request_state TEXT CHECK (
      pull_request_state IS NULL OR pull_request_state IN ('open', 'closed', 'merged')
    ),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    failure_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS repository_publications_target_idx
     ON repository_publications(repository_full_name, base_ref, head_ref, state)`,
  `CREATE TABLE IF NOT EXISTS active_output_turns (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
    attempt_epoch INTEGER NOT NULL,
    turn_id TEXT NOT NULL,
    substream_id TEXT NOT NULL REFERENCES substreams(id),
    status TEXT NOT NULL CHECK (status IN ('streaming', 'finalizing', 'resetting')),
    durable_event_seq INTEGER NOT NULL,
    durable_through_frame_seq INTEGER NOT NULL,
    next_chunk_index INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    seen_turn_ids_json TEXT NOT NULL CHECK (json_valid(seen_turn_ids_json)),
    turn_start_offset INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    checkpointed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (run_id, attempt_epoch),
    UNIQUE (turn_id, attempt_epoch)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS active_output_chunks (
    run_id TEXT NOT NULL,
    attempt_epoch INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    first_frame_seq INTEGER NOT NULL,
    through_frame_seq INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, attempt_epoch, chunk_index),
    FOREIGN KEY (run_id, attempt_epoch)
      REFERENCES active_output_turns(run_id, attempt_epoch) ON DELETE CASCADE
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS active_output_turns_substream_idx
     ON active_output_turns(substream_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS compaction_jobs (
    job_id TEXT PRIMARY KEY,
    substream_id TEXT NOT NULL REFERENCES substreams(id),
    projection_key TEXT NOT NULL,
    source_fence_seq INTEGER NOT NULL,
    through_turn_id TEXT NOT NULL,
    projected_input_hash TEXT NOT NULL,
    authorization_revision_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'invalidated', 'failed')),
    start_part_id TEXT NOT NULL UNIQUE REFERENCES parts(id),
    completion_part_id TEXT UNIQUE REFERENCES parts(id),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS compaction_jobs_active_uq
     ON compaction_jobs(substream_id, projection_key)
     WHERE status IN ('pending', 'running')`,
  `CREATE INDEX IF NOT EXISTS compaction_jobs_substream_idx
     ON compaction_jobs(substream_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS compaction_checkpoints (
    projection_key TEXT NOT NULL,
    execution_principal_key TEXT NOT NULL,
    resource_visibility_fingerprint TEXT NOT NULL,
    checkpoint_template_version INTEGER NOT NULL CHECK (checkpoint_template_version > 0),
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    compacted_through_sequence INTEGER NOT NULL CHECK (compacted_through_sequence >= 0),
    messages_json TEXT NOT NULL CHECK (
      json_valid(messages_json) AND length(messages_json) <= 262144
    ),
    summary TEXT NOT NULL CHECK (length(CAST(summary AS BLOB)) <= 262144),
    model TEXT NOT NULL,
    context_tokens_before_compaction INTEGER NOT NULL CHECK (context_tokens_before_compaction >= 0),
    context_window_tokens INTEGER NOT NULL CHECK (context_window_tokens > 0),
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    cost_micros INTEGER NOT NULL CHECK (cost_micros >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    PRIMARY KEY (projection_key, run_id, compacted_through_sequence)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS compaction_checkpoints_fence_idx
     ON compaction_checkpoints(
       execution_principal_key, resource_visibility_fingerprint,
       compacted_through_sequence DESC, updated_at DESC
     )`,
  `CREATE TABLE IF NOT EXISTS workstream_wakeups (
    wakeup_id TEXT PRIMARY KEY,
    created_by_run_id TEXT REFERENCES runs(run_id) ON DELETE CASCADE,
    execution_principal_json TEXT NOT NULL CHECK (json_valid(execution_principal_json)),
    prompt TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'fired', 'cancelled')),
    idempotency_key TEXT NOT NULL UNIQUE,
    fired_at INTEGER,
    cancelled_at INTEGER,
    version INTEGER NOT NULL CHECK (version >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS workstream_wakeups_due_idx
     ON workstream_wakeups(status, due_at, wakeup_id)`,
  `CREATE TABLE IF NOT EXISTS description_refresh_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    evaluated_at INTEGER,
    rest_until INTEGER NOT NULL,
    consecutive_keeps INTEGER NOT NULL CHECK (consecutive_keeps >= 0),
    evaluated_through_sequence INTEGER NOT NULL CHECK (evaluated_through_sequence >= 0),
    window_message_count INTEGER NOT NULL CHECK (window_message_count >= 0),
    decision TEXT,
    rejection_code TEXT,
    confidence REAL,
    model TEXT,
    previous_description TEXT,
    description TEXT,
    reasoning TEXT,
    version INTEGER NOT NULL CHECK (version >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS workstream_resource_links (
    resource_id TEXT PRIMARY KEY,
    attached_by_user_id TEXT,
    watch_enabled INTEGER NOT NULL CHECK (watch_enabled IN (0, 1)),
    relationship_type TEXT NOT NULL,
    resource_json TEXT NOT NULL CHECK (json_valid(resource_json)),
    attached_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS workstream_resource_links_relation_idx
     ON workstream_resource_links(relationship_type, attached_at, resource_id)`,
  `CREATE TABLE IF NOT EXISTS resource_inventory_revision (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS elicitation_requests (
    elicitation_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    prompt TEXT NOT NULL,
    response_type TEXT NOT NULL,
    options_json TEXT NOT NULL CHECK (json_valid(options_json)),
    minimum_selections INTEGER NOT NULL CHECK (minimum_selections >= 0),
    maximum_selections INTEGER,
    target_user_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'cancelled')),
    answer_json TEXT CHECK (answer_json IS NULL OR json_valid(answer_json)),
    answered_by_user_id TEXT,
    external_actor_json TEXT CHECK (external_actor_json IS NULL OR json_valid(external_actor_json)),
    created_at INTEGER NOT NULL,
    answered_at INTEGER
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS elicitation_requests_status_idx
     ON elicitation_requests(status, target_user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS block_dashboard_configuration_versions (
    configuration_version_id TEXT PRIMARY KEY,
    version_number INTEGER NOT NULL CHECK (version_number > 0),
    blocks_json TEXT NOT NULL CHECK (json_valid(blocks_json)),
    created_by_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (version_number)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS block_dashboard_block_runs (
    block_run_id TEXT PRIMARY KEY,
    configuration_version_id TEXT NOT NULL
      REFERENCES block_dashboard_configuration_versions(configuration_version_id) ON DELETE CASCADE,
    block_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    trigger_sequence INTEGER NOT NULL CHECK (trigger_sequence >= 0),
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'stopped')),
    markdown TEXT,
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS block_dashboard_block_runs_status_idx
     ON block_dashboard_block_runs(status, created_at, block_run_id)`,
  `CREATE TABLE IF NOT EXISTS block_dashboard_user_preferences (
    user_id TEXT PRIMARY KEY,
    visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS suggested_actions (
    action_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    source_activity_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL UNIQUE,
    audience_kind TEXT NOT NULL CHECK (audience_kind IN ('user', 'workstream')),
    audience_user_id TEXT,
    provenance_ref TEXT NOT NULL CHECK (length(provenance_ref) <= 2048),
    authorization_selector_hash TEXT NOT NULL CHECK (length(authorization_selector_hash) <= 512),
    source_revisions_json TEXT NOT NULL CHECK (
      json_valid(source_revisions_json) AND length(source_revisions_json) <= 262144
    ),
    source_authorization_epoch INTEGER NOT NULL CHECK (source_authorization_epoch >= 0),
    display_title TEXT NOT NULL CHECK (length(display_title) <= 2048),
    display_body TEXT NOT NULL CHECK (length(display_body) <= 16384),
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'dismissed', 'retracted', 'expired')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    resolved_at INTEGER,
    retracted_at INTEGER,
    resolved_by_user_id TEXT,
    resolution_client_id TEXT,
    share_intent_json TEXT CHECK (
      share_intent_json IS NULL
      OR (json_valid(share_intent_json) AND length(share_intent_json) <= 262144)
    ),
    authored_part_id TEXT REFERENCES parts(id),
    feedback_message_id TEXT UNIQUE,
    PRIMARY KEY (action_id, version),
    CHECK (
      (audience_kind = 'user' AND audience_user_id IS NOT NULL)
      OR (audience_kind = 'workstream' AND audience_user_id IS NULL)
    ),
    CHECK (expires_at >= created_at),
    CHECK (
      (status = 'pending' AND resolved_at IS NULL AND retracted_at IS NULL
        AND resolved_by_user_id IS NULL AND resolution_client_id IS NULL)
      OR (status IN ('accepted', 'dismissed') AND resolved_at IS NOT NULL
        AND retracted_at IS NULL AND resolved_by_user_id IS NOT NULL
        AND resolution_client_id IS NOT NULL)
      OR (status = 'retracted' AND resolved_at IS NULL AND retracted_at IS NOT NULL
        AND resolved_by_user_id IS NULL AND resolution_client_id IS NULL)
      OR (status = 'expired' AND resolved_at IS NULL AND retracted_at IS NULL
        AND resolved_by_user_id IS NULL AND resolution_client_id IS NULL)
    )
  ) STRICT`,
  `CREATE TRIGGER IF NOT EXISTS suggested_actions_terminal_status_immutable
     BEFORE UPDATE OF status ON suggested_actions
     WHEN OLD.status != 'pending' AND NEW.status != OLD.status
     BEGIN
       SELECT RAISE(ABORT, 'suggested_action_terminal_status_immutable');
     END`,
  `CREATE UNIQUE INDEX IF NOT EXISTS suggested_actions_resolution_uq
     ON suggested_actions(action_id, resolution_client_id)
     WHERE resolution_client_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS suggested_actions_audience_idx
     ON suggested_actions(audience_kind, audience_user_id, status, expires_at)`,
  `CREATE INDEX IF NOT EXISTS suggested_actions_source_idx
     ON suggested_actions(source_activity_id, version DESC)`,
  `CREATE INDEX IF NOT EXISTS suggested_actions_expiry_idx
     ON suggested_actions(status, expires_at)`,
  `CREATE INDEX IF NOT EXISTS suggested_actions_authored_part_idx
     ON suggested_actions(authored_part_id) WHERE authored_part_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS projection_keys (
    projection_key TEXT PRIMARY KEY,
    next_version INTEGER NOT NULL CHECK (next_version > 0),
    last_payload_hash TEXT NOT NULL,
    last_enqueued_message_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (projection_key = 'common' OR projection_key GLOB 'user:*')
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS realtime_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    event_sequence INTEGER NOT NULL CHECK (event_sequence >= 0),
    updated_at INTEGER NOT NULL
  ) STRICT`,
] as const;

const WORKSTREAM_SUBSTREAM_AGENT_SCHEMA = [
  // Admitted rows are the durable FIFO. Only an executing row holds the
  // single-mutator fence for the local substream.
  `CREATE TABLE IF NOT EXISTS run_steering (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
    steering_part_id TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
    requested_at INTEGER NOT NULL,
    boundaries_observed INTEGER NOT NULL DEFAULT 0 CHECK (boundaries_observed >= 0),
    max_boundaries INTEGER NOT NULL DEFAULT 2 CHECK (max_boundaries BETWEEN 1 AND 2),
    consumed_at INTEGER
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS run_steering_pending_idx
     ON run_steering(consumed_at, requested_at) WHERE consumed_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS substream_agent_identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    external_substream_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS agent_run_dispatches (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
    input_json TEXT NOT NULL CHECK (json_valid(input_json)),
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed')),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    available_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    last_error_code TEXT,
    terminal_outcome_json TEXT
      CHECK (terminal_outcome_json IS NULL OR json_valid(terminal_outcome_json)),
    settled_at INTEGER,
    last_settlement_error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS agent_run_dispatches_ready_idx
     ON agent_run_dispatches(state, available_at, created_at, run_id)`,
  // One SubstreamAgent owns one independently ordered loop. This singleton is
  // only the reconnect-safe activity indicator; immutable compaction history
  // remains in compaction_checkpoints.
  `CREATE TABLE IF NOT EXISTS active_agent_compaction (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL,
    compaction_index INTEGER NOT NULL CHECK (compaction_index > 0),
    trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'auto')),
    started_at INTEGER NOT NULL CHECK (started_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= started_at)
  ) STRICT`,
] as const;

/**
 * Temporarily removes the live triggers whose SQL names a table rebuilt by
 * migration v33. SQLite validates trigger bodies on every schema change, so a
 * standard create-copy-drop-rename rebuild must remove these dependents for
 * the two statements in which the old name is absent. They are restored from
 * their canonical definitions immediately after every table name is back.
 */
function canonicalTurnRelationTriggerDrops(): string[] {
  return [
    `DROP TRIGGER _runtime_harness_runs_insert`,
    `DROP TRIGGER suggested_actions_terminal_status_immutable`,
    `DROP TRIGGER accepted_suggestion_source_audience_immutable`,
    `DROP TRIGGER accepted_suggestion_source_audience_retained`,
    `DROP TRIGGER participants_restricted_content_insert`,
    `DROP TRIGGER participants_restricted_content_reactivate`,
    `DROP TRIGGER workstream_restricted_content_scope`,
  ];
}

function canonicalTurnRelationTriggerRecreates(): string[] {
  const harnessRunsInsert = WORKSTREAM_RUNTIME_COMPAT_SCHEMA.find((statement) =>
    statement.includes("CREATE TRIGGER IF NOT EXISTS _runtime_harness_runs_insert"));
  if (!harnessRunsInsert) throw new Error("harness runs insert trigger not found in compat schema");
  return [
    // julianday() is floating point. Round its millisecond conversion instead
    // of truncating a representation such as 999.999999 to the prior
    // millisecond; the physical INTEGER timestamps already use nearest-ms time.
    harnessRunsInsert
      .replaceAll("origin_part_id", "origin_message_id")
      .replaceAll("* 86400000 AS INTEGER", "* 86400000 + 0.5 AS INTEGER"),
    `CREATE TRIGGER IF NOT EXISTS suggested_actions_terminal_status_immutable
       BEFORE UPDATE OF status ON suggested_actions
       WHEN OLD.status != 'pending' AND NEW.status != OLD.status
       BEGIN
         SELECT RAISE(ABORT, 'suggested_action_terminal_status_immutable');
       END`,
    ...acceptedSuggestionAudienceTriggers(),
  ];
}

/**
 * Migration v1 is hashed, shipped history and retains its old public
 * spellings. Once v34 renames the physical columns, recreate only the live run
 * compatibility surface with canonical turn vocabulary.
 */
function finalTurnHarnessRunContract(): string[] {
  const statements = WORKSTREAM_RUNTIME_COMPAT_SCHEMA.filter((statement) =>
    statement.includes("CREATE VIEW IF NOT EXISTS _runtime_harness_runs")
    || statement.includes("CREATE TRIGGER IF NOT EXISTS _runtime_harness_runs_insert")
    || statement.includes("CREATE TRIGGER IF NOT EXISTS _runtime_harness_runs_update"));
  if (statements.length !== 3) throw new Error("harness run compatibility contract incomplete");
  // See canonicalTurnRelationTriggerRecreates: every recreated run contract
  // rounds julianday's floating-point result to the nearest stored millisecond.
  return statements.map((statement) => statement
    .replaceAll("origin_part_id", "origin_message_id")
    .replaceAll("final_message_id", "final_turn_id")
    .replaceAll("final_part_id", "final_turn_id")
    .replaceAll("* 86400000 AS INTEGER", "* 86400000 + 0.5 AS INTEGER"));
}

export const WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS: readonly WorkstreamObjectSchemaMigration[] = [
  {
    version: 1,
    description: "normalized SubstreamAgent product, runtime, and execution authority",
    statements: [
      ...WORKSTREAM_SCHEMA_V1,
      ...WORKSTREAM_RUNTIME_COMPAT_SCHEMA,
      ...WORKSTREAM_SUBSTREAM_AGENT_SCHEMA,
    ],
  },
  {
    version: 2,
    description: "lease agent run dispatches so an abandoned run stays discoverable",
    statements: [
      // Before this, `state = 'running'` was a claim with no expiry, so a run
      // interrupted by an eviction or a cancelled invocation was
      // indistinguishable from one still executing — and the scheduler had no
      // durable time at which to look again. The lease supplies that time.
      `ALTER TABLE agent_run_dispatches ADD COLUMN lease_token TEXT`,
      `ALTER TABLE agent_run_dispatches ADD COLUMN lease_expires_at INTEGER`,
      `CREATE INDEX IF NOT EXISTS agent_run_dispatches_lease_idx
         ON agent_run_dispatches(state, lease_expires_at, available_at)`,
      // Objects that carried a run through the upgrade have no lease on it. A
      // null lease reads as immediately reclaimable, which is the recovering
      // direction: the harness attempt claim in D1 turns away a reclaim that
      // races a run still genuinely in flight.
    ],
  },
  {
    version: 3,
    description: "round trigger timestamp conversion so ISO round-trips are exact",
    statements: roundedCompatTriggerRebuilds(),
  },
  {
    version: 4,
    description: "qualify the resources view columns so the view is selectable",
    statements: [
      // `_runtime_resources` read bare `updated_at` over
      // `workstream_resource_links CROSS JOIN workstream`, and both tables
      // carry that column. SQLite validates a view body on first use, not at
      // CREATE, so v1 shipped this latent: nothing selected the view until
      // the runtime router was fixed to send transcript reads here, at which
      // point every harness run failed on it. The schema test now selects
      // from every view, so an unselectable view cannot ship again.
      `DROP VIEW IF EXISTS _runtime_resources`,
      `CREATE VIEW IF NOT EXISTS _runtime_resources AS
         SELECT json_extract(link.resource_json, '$.id') AS id,
                root.parent_workspace_key AS workspace_id,
                json_extract(link.resource_json, '$.connectionId') AS connection_id,
                json_extract(link.resource_json, '$.type') AS resource_type,
                json_extract(link.resource_json, '$.provider') AS provider,
                json_extract(link.resource_json, '$.providerResourceId') AS provider_resource_id,
                json_extract(link.resource_json, '$.title') AS title,
                json_extract(link.resource_json, '$.mimeType') AS mime_type,
                json_extract(link.resource_json, '$.contentRef') AS content_ref,
                NULL AS content_sha256,
                NULL AS model_content_ref,
                NULL AS model_mime_type,
                NULL AS model_content_sha256,
                NULL AS model_metadata_json,
                'ready' AS model_content_status,
                NULL AS model_content_error_code,
                json_extract(link.resource_json, '$.canonicalUrl') AS canonical_url,
                json_extract(link.resource_json, '$.metadata') AS metadata_json,
                strftime('%Y-%m-%dT%H:%M:%fZ', link.attached_at / 1000.0, 'unixepoch') AS created_at,
                strftime('%Y-%m-%dT%H:%M:%fZ', link.updated_at / 1000.0, 'unixepoch') AS updated_at
           FROM workstream_resource_links link CROSS JOIN workstream root WHERE root.id = 1`,
    ],
  },
  {
    version: 5,
    description: "absorb replayed durable message writes inside the insert trigger",
    statements: rebuiltMessagesInsertTrigger(),
  },
  {
    version: 6,
    description: "keep the description-refresh ratchet across claims",
    statements: rebuiltDescriptionRefreshInsertTrigger(),
  },
  {
    version: 7,
    description: "one child run per parent tool call",
    statements: [
      // D1 enforced `harness_runs_parent_tool_call_idx` (0027) and the inline
      // child admission depends on it: its INSERT ends in ON CONFLICT DO
      // NOTHING, and the zero-change result is what routes a replayed
      // admission to the re-read branch that reuses the existing child — and
      // its settled result. Without the index, a retried admission with a
      // fresh child id simply inserted a second child through the port.
      // Existing duplicates cannot be deleted here (tool_effects,
      // elicitation_requests, and parts provenance reference runs without
      // cascade), so every non-newest duplicate has its tool-call binding
      // suffixed out of the way instead: the newest row is the id the
      // parent's last admission returned, and a suffixed row still reads as
      // an inline child, so the parent-loss reaper retires it normally. The
      // newest row of each group is never rewritten, so the correlated scan
      // is stable while the UPDATE walks the table.
      `UPDATE runs SET parent_tool_call_id = parent_tool_call_id || ':superseded:' || run_id
        WHERE parent_run_id IS NOT NULL AND parent_tool_call_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM runs newer
             WHERE newer.parent_run_id = runs.parent_run_id
               AND newer.parent_tool_call_id = runs.parent_tool_call_id
               AND newer.run_id != runs.run_id
               AND (newer.created_at > runs.created_at
                 OR (newer.created_at = runs.created_at AND newer.run_id > runs.run_id))
          )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS runs_parent_tool_call_uq
         ON runs(parent_run_id, parent_tool_call_id)
         WHERE parent_run_id IS NOT NULL AND parent_tool_call_id IS NOT NULL`,
    ],
  },
  {
    version: 8,
    description: "carry the replan columns through the tool-invocations update trigger",
    statements: rebuiltToolInvocationsUpdateTrigger(),
  },
  {
    version: 9,
    description: "exempt block-dashboard runs from the single-mutating-run constraint",
    statements: [
      // The harness claim deliberately admits a block-dashboard run beside a
      // running interactive run — its claim UPDATE skips the NOT EXISTS fence
      // entirely for that origin — but both top-level runs sit on substream
      // '0', so `runs_mutating_substream_uq` turned the second claim into a
      // UNIQUE violation thrown through the port instead of the zero-change
      // result the claim's busy branch is written to absorb. The index now
      // encodes the same exemption the claim SQL does; block runs' own
      // concurrency stays governed by the claim predicates, as it was on D1
      // (which had no equivalent index at all).
      `DROP INDEX IF EXISTS runs_mutating_substream_uq`,
      `CREATE UNIQUE INDEX IF NOT EXISTS runs_mutating_substream_uq
         ON runs(substream_id)
         WHERE status IN ('running', 'waiting', 'steering')
           AND origin != 'block_dashboard_block'`,
    ],
  },
  {
    version: 10,
    description: "preserve a stopped top-level run in the workstream projection",
    statements: rebuiltWorkstreamsStoppedProjection(),
  },
  {
    version: 11,
    description: "settle same-id tool transcript writes before replay deduplication",
    statements: [
      ...repairStrandedToolTranscriptParts(),
      ...rebuiltMessagesInsertTriggerForToolSettlement(),
    ],
  },
  {
    version: 12,
    description: "drop the four tables the cutover left without a reader or writer",
    statements: [
      // v1 still creates these, and it must: its statements are hashed into
      // `_sql_schema_migrations`, so editing them warns with
      // `substream_agent_do_schema_hash_mismatch:1` without converging existing
      // schemas. A new object therefore creates them and drops them in the same
      // bootstrap transaction, which is the cost of an append-only history and
      // is paid once.
      //
      // `terminal_commands` was provisioned for per-command receipts during
      // the D1 retirement, but the Terminal runtime settles every command
      // through `terminal_tasks` — the durable task carries the command hash,
      // deadline, exit, termination reason, byte counts, and head/tail that
      // this table duplicates. Nothing ever wrote it.
      `DROP TABLE IF EXISTS terminal_commands`,
      // `compaction_jobs` modelled compaction as a claimable job row. The
      // agent instead keeps `active_agent_compaction` as the singleton
      // activity indicator and `compaction_checkpoints` as the immutable
      // history; both are read and written, this third table never was. The
      // comment above `active_agent_compaction` still points at it and is
      // corrected in this change.
      `DROP TABLE IF EXISTS compaction_jobs`,
      // Bookkeeping for the one-time D1 authority cutover campaign. The code
      // that drove it was removed in "Retire the authority cutover campaign
      // machinery"; the tables outlived their driver. A future campaign gets
      // its own schema rather than inheriting a shape nothing has exercised.
      `DROP TABLE IF EXISTS _migration_command_receipts`,
      `DROP TABLE IF EXISTS _data_migrations`,
      // Deliberately kept: `content_refs`. It has no reader either, but
      // `parts.content_ref_id` carries a foreign key, two CHECK constraints,
      // and a partial index pointing at it, so retiring it means rebuilding
      // the transcript's hottest table. That is its own change.
    ],
  },
  {
    version: 13,
    description: "give the Terminal lifecycle real columns and retire its compatibility views",
    statements: terminalAuthorityPromotion(),
  },
  {
    version: 14,
    description: "project receipt-only tool settlement into the visible transcript row",
    statements: [
      ...repairStrandedToolTranscriptParts(),
      ...rebuiltToolInvocationsUpdateTriggerForTranscriptSettlement(),
    ],
  },
  {
    version: 15,
    description: "index this object's wake-ups in the shared multi-alarm table",
    statements: [
      ...SCHEDULED_ALARM_SCHEMA_STATEMENTS,
      // Every pending wake-up already in this object becomes an entry in the
      // same transaction that creates the table. Without the backfill, a timer
      // scheduled before this deploy is reachable only by whatever next writes
      // `workstream_wakeups` and re-syncs the index — for a work stream whose
      // last run ended, nothing ever does, and the wake-up the run promised a
      // person is silently lost.
      `INSERT INTO _internal_durable_alarms
         (kind, alarm_key, due_at, repeat_every_ms, retry_at, attempt, payload_json,
          created_at, updated_at)
       SELECT 'agent_timer', wakeup_id, due_at, NULL, 0, 0, NULL,
              unixepoch() * 1000, unixepoch() * 1000
         FROM workstream_wakeups
        WHERE status = 'pending'`,
    ],
  },
  {
    version: 16,
    description: "allocate tool_position from a high-water mark so a deleted receipt cannot wedge a run",
    statements: rebuiltToolInvocationsInsertTriggerForPositionAllocation(),
  },
  {
    version: 17,
    description: "adopt the tool-receipt objects the compat schema owns, then retire its receipt views",
    statements: toolReceiptAuthorityPromotion(),
  },
  {
    version: 18,
    description: "retire the block-dashboard compatibility views and their triggers",
    statements: blockDashboardAuthorityPromotion(),
  },
  {
    version: 19,
    description: "record when a participant first opened the work stream, so being added is visible",
    statements: [
      // Being put in a room and never having looked at it was expressible
      // nowhere: `member_attention` only exists once somebody has been read to
      // or mentioned, and its absence cannot be told apart from a row this
      // migration would have to invent. The membership row is the one thing
      // every participant has, from the instant they are added.
      `ALTER TABLE participants ADD COLUMN first_opened_at INTEGER`,
      // Everybody already in a room has had the chance to open it, and a
      // release that turned every existing membership into an unread-looking
      // dot would be indistinguishable from a bug. `added_at` is the honest
      // stand-in: it is when they could first have opened it.
      `UPDATE participants SET first_opened_at = added_at WHERE first_opened_at IS NULL`,
      // The column has to survive the two paths this object does not own.
      ...participantCompatTriggersResettingFirstOpened(),
    ],
  },
  {
    version: 20,
    description: "retire the wake-up, compaction, description-refresh and plugin-hint views",
    statements: schedulingAuthorityPromotion(),
  },
  {
    version: 21,
    description: "retire the resource-attachment, resource-projection and revision views",
    statements: resourceAuthorityPromotion(),
  },
  {
    version: 22,
    description: "prevent accepted restricted suggestions from outliving their reader audience",
    statements: acceptedSuggestionAudienceTriggers(),
  },
  {
    version: 23,
    description: "retire the run-scope, plugin-activation and memory-context views",
    statements: harnessRunAuthorityPromotion(),
  },
  {
    version: 24,
    description: "retire the run lifecycle-event view now the final message is an object write",
    statements: runLifecycleAuthorityPromotion(),
  },
  {
    version: 25,
    description: "retire the elicitation view now both of its writers are object operations",
    statements: elicitationAuthorityPromotion(),
  },
  {
    version: 26,
    description: "retire the identity and participant views, the last two compatibility objects",
    statements: identityAuthorityPromotion(),
  },
  {
    version: 27,
    description: "add canonical ordered transcript and lossless Bind-loop projections",
    statements: ORDERED_TRANSCRIPT_SCHEMA_V1,
  },
  {
    version: 28,
    description: "record the one-time legacy transcript projection backfill",
    statements: [
      `CREATE TABLE legacy_transcript_backfills (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        operator_run_id TEXT NOT NULL,
        cutover_version INTEGER NOT NULL CHECK (cutover_version = 27),
        cutover_applied_at INTEGER NOT NULL,
        pre_backfill_bookmark TEXT NOT NULL,
        source_part_count INTEGER NOT NULL CHECK (source_part_count >= 0),
        source_checkpoint_count INTEGER NOT NULL CHECK (source_checkpoint_count >= 0),
        source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
        participant_turn_count INTEGER NOT NULL CHECK (participant_turn_count >= 0),
        checkpoint_projection_count INTEGER NOT NULL CHECK (checkpoint_projection_count >= 0),
        bind_history_status TEXT NOT NULL CHECK (
          bind_history_status = 'not_reconstructable_from_legacy_aggregate_rows'
        ),
        completed_at INTEGER NOT NULL
      ) STRICT`,
    ],
  },
  {
    version: 29,
    description: "record pre-cutover run cleanup before transcript backfill",
    statements: [
      `CREATE TABLE legacy_transcript_cleanup_receipts (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        operator_run_id TEXT NOT NULL,
        cutover_version INTEGER NOT NULL CHECK (cutover_version = 27),
        cutover_applied_at INTEGER NOT NULL,
        abandoned_run_count INTEGER NOT NULL CHECK (abandoned_run_count >= 0),
        completed_at INTEGER NOT NULL
      ) STRICT`,
    ],
  },
  {
    version: 30,
    description: "stage canonical ownership for legacy transcript payloads",
    statements: [
      `CREATE TABLE workstream_message_records (
        message_id TEXT PRIMARY KEY,
        substream_id TEXT NOT NULL REFERENCES substreams(id),
        sequence_number INTEGER NOT NULL UNIQUE CHECK (sequence_number > 0),
        attention_ordinal INTEGER UNIQUE CHECK (attention_ordinal IS NULL OR attention_ordinal > 0),
        fact_id TEXT NOT NULL REFERENCES transcript_facts(fact_id),
        turn_id TEXT,
        turn_open_sequence INTEGER CHECK (turn_open_sequence IS NULL OR turn_open_sequence > 0),
        part_index INTEGER CHECK (part_index IS NULL OR part_index >= 0),
        role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool', 'note')),
        kind TEXT NOT NULL,
        author_type TEXT NOT NULL CHECK (author_type IN ('member', 'agent', 'connector', 'system', 'external')),
        author_user_id TEXT,
        external_actor_json TEXT CHECK (external_actor_json IS NULL OR json_valid(external_actor_json)),
        content_ref_id TEXT REFERENCES content_refs(content_ref_id),
        content_bytes INTEGER CHECK (content_bytes IS NULL OR content_bytes > 0),
        content_hash TEXT,
        answers_message_id TEXT,
        input_message_ids_json TEXT CHECK (input_message_ids_json IS NULL OR json_valid(input_message_ids_json)),
        client_message_id TEXT,
        effect_intent_id TEXT,
        occurrence_key TEXT,
        produced_by_run_id TEXT REFERENCES runs(run_id),
        attempt_epoch INTEGER,
        executor_event_seq INTEGER,
        model_turn_id TEXT,
        tool_position INTEGER,
        delivery_intent TEXT CHECK (delivery_intent IN ('queue', 'steer')),
        input_batch_id TEXT,
        admission_cut_seq INTEGER,
        tool_name TEXT,
        tool_mode TEXT CHECK (tool_mode IN ('read', 'write')),
        tool_status TEXT CHECK (tool_status IN ('pending', 'completed', 'failed', 'ambiguous')),
        compacts_through_sequence INTEGER,
        compacts_through_turn_id TEXT,
        projected_input_hash TEXT,
        projection_key TEXT,
        authorization_revisions_json TEXT CHECK (
          authorization_revisions_json IS NULL OR json_valid(authorization_revisions_json)
        ),
        lineage_fences_json TEXT CHECK (lineage_fences_json IS NULL OR json_valid(lineage_fences_json)),
        terminal_reason TEXT,
        visibility TEXT NOT NULL CHECK (visibility IN ('people', 'model', 'both', 'system')),
        pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
        message_type TEXT NOT NULL,
        edited_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        UNIQUE(turn_id, part_index),
        UNIQUE(produced_by_run_id, attempt_epoch, executor_event_seq)
      ) STRICT`,
      `CREATE UNIQUE INDEX workstream_message_records_client_message_uq
         ON workstream_message_records(client_message_id) WHERE client_message_id IS NOT NULL`,
      `CREATE UNIQUE INDEX workstream_message_records_effect_intent_uq
         ON workstream_message_records(effect_intent_id) WHERE effect_intent_id IS NOT NULL`,
      `CREATE UNIQUE INDEX workstream_message_records_occurrence_uq
         ON workstream_message_records(occurrence_key) WHERE occurrence_key IS NOT NULL`,
      `CREATE INDEX workstream_message_records_sequence_idx
         ON workstream_message_records(substream_id, sequence_number)`,
      `CREATE INDEX workstream_message_records_attention_idx
         ON workstream_message_records(attention_ordinal) WHERE attention_ordinal IS NOT NULL`,
      `CREATE TABLE workstream_message_attachments (
        message_id TEXT NOT NULL REFERENCES workstream_message_records(message_id) ON DELETE CASCADE,
        resource_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        attachment_json TEXT NOT NULL CHECK (
          json_valid(attachment_json) AND length(attachment_json) <= 262144
        ),
        PRIMARY KEY(message_id, resource_id),
        UNIQUE(message_id, position)
      ) STRICT`,
      `CREATE INDEX workstream_message_attachments_resource_idx
         ON workstream_message_attachments(resource_id, message_id)`,
      `CREATE TABLE workstream_message_mentions (
        message_id TEXT NOT NULL REFERENCES workstream_message_records(message_id) ON DELETE CASCADE,
        mention_index INTEGER NOT NULL CHECK (mention_index >= 0),
        mention_kind TEXT NOT NULL CHECK (mention_kind IN ('person', 'connector')),
        target_user_id TEXT,
        connector_type TEXT,
        start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
        end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
        attention_ordinal INTEGER NOT NULL,
        PRIMARY KEY(message_id, mention_index),
        CHECK (
          (mention_kind = 'person' AND target_user_id IS NOT NULL AND connector_type IS NULL)
          OR (mention_kind = 'connector' AND target_user_id IS NULL AND connector_type IS NOT NULL)
        )
      ) STRICT`,
      `CREATE INDEX workstream_message_mentions_user_attention_idx
         ON workstream_message_mentions(target_user_id, attention_ordinal)`,
      `CREATE TABLE legacy_transcript_payload_transfers (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        operator_run_id TEXT NOT NULL,
        pre_transfer_bookmark TEXT NOT NULL,
        source_part_count INTEGER NOT NULL CHECK (source_part_count >= 0),
        source_attachment_count INTEGER NOT NULL CHECK (source_attachment_count >= 0),
        source_mention_count INTEGER NOT NULL CHECK (source_mention_count >= 0),
        source_checkpoint_count INTEGER NOT NULL CHECK (source_checkpoint_count >= 0),
        source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
        message_record_count INTEGER NOT NULL CHECK (message_record_count >= 0),
        checkpoint_projection_count INTEGER NOT NULL CHECK (checkpoint_projection_count >= 0),
        completed_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE TRIGGER workstream_message_attachments_mirror_insert
         AFTER INSERT ON part_attachments BEGIN
           INSERT INTO workstream_message_attachments(message_id, resource_id, position, attachment_json)
           SELECT NEW.part_id, NEW.resource_id, NEW.position, NEW.attachment_json
            WHERE EXISTS (SELECT 1 FROM workstream_message_records WHERE message_id = NEW.part_id)
           ON CONFLICT(message_id, resource_id) DO UPDATE SET
             position = excluded.position, attachment_json = excluded.attachment_json;
         END`,
      `CREATE TRIGGER workstream_message_mentions_mirror_insert
         AFTER INSERT ON part_mentions BEGIN
           INSERT INTO workstream_message_mentions(
             message_id, mention_index, mention_kind, target_user_id, connector_type,
             start_offset, end_offset, attention_ordinal
           ) SELECT NEW.part_id, NEW.mention_index, NEW.mention_kind, NEW.target_user_id,
                    NEW.connector_type, NEW.start_offset, NEW.end_offset, NEW.attention_ordinal
              WHERE EXISTS (SELECT 1 FROM workstream_message_records WHERE message_id = NEW.part_id)
           ON CONFLICT(message_id, mention_index) DO UPDATE SET
             mention_kind = excluded.mention_kind,
             target_user_id = excluded.target_user_id,
             connector_type = excluded.connector_type,
             start_offset = excluded.start_offset,
             end_offset = excluded.end_offset,
             attention_ordinal = excluded.attention_ordinal;
         END`,
    ],
  },
  {
    version: 31,
    description: "constrain resource relationships to the source and artifact direction vocabulary",
    statements: [
      `CREATE TABLE workstream_resource_links_v31 (
        resource_id TEXT PRIMARY KEY,
        attached_by_user_id TEXT,
        watch_enabled INTEGER NOT NULL CHECK (watch_enabled IN (0, 1)),
        relationship_type TEXT NOT NULL CHECK (
          relationship_type IN (${RESOURCE_RELATIONSHIP_CHECK_VALUES})
        ),
        resource_json TEXT NOT NULL CHECK (json_valid(resource_json)),
        attached_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT`,
      `INSERT INTO workstream_resource_links_v31
         (resource_id, attached_by_user_id, watch_enabled, relationship_type,
          resource_json, attached_at, updated_at)
       SELECT resource_id, attached_by_user_id, watch_enabled, relationship_type,
              resource_json, attached_at, updated_at
         FROM workstream_resource_links`,
      `DROP TABLE workstream_resource_links`,
      `ALTER TABLE workstream_resource_links_v31 RENAME TO workstream_resource_links`,
      `CREATE INDEX workstream_resource_links_relation_idx
         ON workstream_resource_links(relationship_type, attached_at, resource_id)`,
    ],
  },
  {
    version: 32,
    description: "retire legacy transcript payload storage",
    foreignKeys: "disabled_during_rebuild",
    legacyHashWithoutExecutionMode: true,
    statements: [
      `CREATE TABLE transcript_payload_retirement_guard (
        id INTEGER PRIMARY KEY CHECK (id = 1)
      ) STRICT`,
      ...transcriptPayloadRetirementGuards(),
      `INSERT INTO transcript_payload_retirement_guard(id) VALUES (1)`,
      ...transcriptPayloadRetirementGuardDrops(),
      `DROP TABLE transcript_payload_retirement_guard`,
      ...transcriptCompatibilityRetirement(),
      `DROP TRIGGER workstream_message_attachments_mirror_insert`,
      `DROP TRIGGER workstream_message_mentions_mirror_insert`,
      `UPDATE participant_transcript_turns
          SET root_fact_id = (
            SELECT fact_id FROM workstream_message_records
             WHERE message_id = participant_transcript_turns.turn_id
          )
        WHERE entry_kind = 'conversation'
          AND EXISTS (
            SELECT 1 FROM workstream_message_records
             WHERE message_id = participant_transcript_turns.turn_id
          )`,
      `UPDATE participant_transcript_blocks
          SET fact_id = (
            SELECT fact_id FROM workstream_message_records
             WHERE message_id = participant_transcript_blocks.turn_id
          )
        WHERE EXISTS (
          SELECT 1 FROM workstream_message_records
           WHERE message_id = participant_transcript_blocks.turn_id
        )`,
      `DROP TABLE part_attachments`,
      `DROP TABLE part_mentions`,
      `ALTER TABLE workstream_message_records RENAME COLUMN message_id TO id`,
      `PRAGMA legacy_alter_table = ON`,
      `ALTER TABLE parts RENAME TO retired_transcript_parts`,
      `ALTER TABLE workstream_message_records RENAME TO parts`,
      `DROP TABLE retired_transcript_parts`,
      `PRAGMA legacy_alter_table = OFF`,
      `ALTER TABLE parts RENAME TO retired_transcript_parts`,
      `ALTER TABLE retired_transcript_parts RENAME TO workstream_message_records`,
      `DROP INDEX substreams_origin_part_uq`,
      `ALTER TABLE substreams RENAME COLUMN origin_part_id TO origin_message_id`,
      `CREATE UNIQUE INDEX substreams_origin_message_uq
         ON substreams(origin_message_id) WHERE origin_message_id IS NOT NULL`,
      `ALTER TABLE tool_effects RENAME COLUMN result_part_id TO result_message_id`,
      `ALTER TABLE terminal_publication_grants
         RENAME COLUMN source_part_id TO source_message_id`,
      `DROP INDEX suggested_actions_authored_part_idx`,
      `ALTER TABLE suggested_actions RENAME COLUMN authored_part_id TO authored_message_id`,
      `CREATE INDEX suggested_actions_authored_message_idx
         ON suggested_actions(authored_message_id) WHERE authored_message_id IS NOT NULL`,
      `ALTER TABLE run_steering RENAME COLUMN steering_part_id TO steering_message_id`,
      `DROP TABLE compaction_checkpoints`,
      `DROP TABLE legacy_transcript_backfills`,
      `DROP TABLE legacy_transcript_cleanup_receipts`,
      `DROP TABLE legacy_transcript_payload_transfers`,
      `CREATE VIEW workstream_message_details AS
         SELECT record.id, record.substream_id, record.sequence_number,
                record.attention_ordinal, record.turn_id, record.turn_open_sequence,
                record.part_index, record.role, record.kind, record.author_type,
                record.author_user_id, record.external_actor_json,
                json_extract(payload.payload_json, '$.content') AS content,
                record.content_ref_id, record.content_bytes, record.content_hash,
                record.answers_message_id, record.input_message_ids_json,
                record.client_message_id, record.effect_intent_id, record.occurrence_key,
                record.produced_by_run_id, record.attempt_epoch, record.executor_event_seq,
                record.model_turn_id, record.tool_position, record.delivery_intent,
                record.input_batch_id, record.admission_cut_seq, record.tool_name,
                record.tool_mode, record.tool_status, record.compacts_through_sequence,
                record.compacts_through_turn_id, record.projected_input_hash,
                record.projection_key, record.authorization_revisions_json,
                record.lineage_fences_json, record.terminal_reason, record.visibility,
                record.pinned, record.message_type,
                CASE WHEN json_type(payload.payload_json, '$.structuredContent') = 'null'
                  THEN NULL
                  ELSE json_extract(payload.payload_json, '$.structuredContent')
                END AS structured_content_json,
                record.edited_at, record.created_at, record.updated_at
           FROM workstream_message_records record
           JOIN transcript_facts fact ON fact.fact_id = record.fact_id
            JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id`,
    ],
  },
  {
    version: 33,
    description: "one persistent loop per substream over a canonical ordered transcript",
    // One forward-only cutover from shipped v32. This entry is the exact
    // concatenation of the eight interim revisions the cutover went through
    // while it was being built (33–40); none of them shipped, they always ran
    // as one same-mode execution group, and eight receipts for one decision
    // were only history of the branch, not of the schema. Interior churn — a
    // later section replacing a table an earlier one creates — is retained
    // verbatim rather than hand-merged: the statements are proven equivalent
    // to the interim chain by full schema-and-data dump equality over the
    // populated-v32 upgrade fixture, and a hand merge would forfeit that
    // proof for cosmetics.
    statements: [
      // ── formerly v33: delete the message compatibility projection and key all relations to canonical turns

      `ALTER TABLE participant_transcript_turns ADD COLUMN client_message_id TEXT`,
      `ALTER TABLE participant_transcript_turns ADD COLUMN author_name_snapshot TEXT`,
      `ALTER TABLE participant_transcript_turns ADD COLUMN author_avatar_url_snapshot TEXT`,
      `ALTER TABLE participant_transcript_turns ADD COLUMN external_actor_json TEXT
         CHECK (external_actor_json IS NULL OR json_valid(external_actor_json))`,
      `ALTER TABLE participant_transcript_turns ADD COLUMN message_type TEXT NOT NULL DEFAULT 'text'`,
      `UPDATE participant_transcript_turns
          SET author_name_snapshot = CASE
                WHEN actor = 'human' THEN 'A workspace member' ELSE NULL
              END,
              author_avatar_url_snapshot = NULL,
              client_message_id = (
                SELECT client_message_id FROM workstream_message_records
                 WHERE id = participant_transcript_turns.turn_id
              ),
              external_actor_json = (
                SELECT external_actor_json FROM workstream_message_records
                 WHERE id = participant_transcript_turns.turn_id
              ),
              message_type = COALESCE((
                SELECT message_type FROM workstream_message_records
                 WHERE id = participant_transcript_turns.turn_id
              ), 'text')`,
      `CREATE UNIQUE INDEX participant_transcript_client_message_uq
         ON participant_transcript_turns(client_message_id)
         WHERE client_message_id IS NOT NULL`,
      `DROP VIEW workstream_message_details`,
      `CREATE TABLE substreams_v33 (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('main', 'chat', 'agent')),
        inherit_mode TEXT NOT NULL CHECK (inherit_mode IN ('none', 'fork', 'document')),
        inherit_from_substream_id TEXT REFERENCES substreams_v33(id),
        inherit_fence_seq INTEGER,
        depth INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 4),
        return_mode TEXT NOT NULL CHECK (return_mode IN ('none', 'tool_result')),
        origin_message_id TEXT REFERENCES participant_transcript_turns(turn_id),
        owner_user_id TEXT,
        audience TEXT NOT NULL CHECK (audience IN ('owner', 'workspace', 'system')),
        tool_policy TEXT NOT NULL CHECK (tool_policy IN ('none', 'read_only', 'full')),
        status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
        created_at INTEGER NOT NULL,
        closed_at INTEGER,
        CHECK ((status = 'open' AND closed_at IS NULL) OR (status = 'closed' AND closed_at IS NOT NULL)),
        CHECK (inherit_from_substream_id IS NULL OR inherit_from_substream_id != id),
        CHECK (
          (inherit_mode = 'none' AND inherit_from_substream_id IS NULL AND inherit_fence_seq IS NULL)
          OR (inherit_mode = 'fork' AND inherit_from_substream_id IS NOT NULL
              AND inherit_fence_seq IS NOT NULL AND inherit_fence_seq >= 0)
          OR (inherit_mode = 'document' AND inherit_from_substream_id IS NOT NULL
              AND (inherit_fence_seq IS NULL OR inherit_fence_seq >= 0))
        ),
        CHECK (audience != 'owner' OR owner_user_id IS NOT NULL),
        CHECK (
          (id = '0' AND kind = 'main' AND inherit_mode = 'none' AND depth = 0
            AND return_mode = 'none' AND owner_user_id IS NULL AND audience = 'workspace'
            AND tool_policy = 'full' AND origin_message_id IS NULL
            AND inherit_from_substream_id IS NULL AND inherit_fence_seq IS NULL
            AND status = 'open' AND closed_at IS NULL)
          OR (id != '0' AND kind != 'main')
        )
      ) STRICT`,
      `INSERT INTO substreams_v33 SELECT * FROM substreams`,
      // V32 operational rows belong to the per-message run model retired by
      // this cutover. Preserve canonical participant history, but do not carry
      // active execution/tool state across the new transcript authority.
      `UPDATE workstream_message_records SET produced_by_run_id = NULL`,
      `DELETE FROM repository_publications`,
      `DELETE FROM attachment_tool_receipts`,
      `DELETE FROM terminal_tasks`,
      `DELETE FROM tool_effect_checkpoints`,
      `DELETE FROM terminal_publication_grants`,
      `DELETE FROM tool_effects`,
      `DELETE FROM elicitation_requests`,
      `DELETE FROM runs`,
      `CREATE TABLE tool_effects_v33 (
        effect_intent_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        attempt_epoch INTEGER NOT NULL,
        tool_position INTEGER NOT NULL,
        occurrence_key TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('read', 'write')),
        request_hash TEXT NOT NULL,
        authority_revision TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('admitted', 'executing', 'completed', 'failed', 'ambiguous')),
        result_message_id TEXT REFERENCES participant_transcript_turns(turn_id),
        provider_operation_id TEXT,
        started_at INTEGER,
        settled_at INTEGER,
        result_hash TEXT,
        tool_call_id TEXT NOT NULL,
        connection_id TEXT,
        input_json TEXT NOT NULL CHECK (json_valid(input_json)),
        output_ref TEXT,
        output_summary TEXT,
        error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
        execution_plan_hash TEXT,
        execution_plan_json TEXT CHECK (execution_plan_json IS NULL OR json_valid(execution_plan_json)),
        provider_idempotency_key TEXT,
        checkpoint_index INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_index >= 0),
        UNIQUE (run_id, attempt_epoch, tool_position)
      ) STRICT`,
      `INSERT INTO tool_effects_v33 SELECT * FROM tool_effects`,
      `CREATE TABLE attachment_tool_receipts_v33 (
        workspace_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        tool_invocation_id TEXT NOT NULL
          REFERENCES tool_effects_v33(effect_intent_id) ON DELETE CASCADE,
        derivative_sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (resource_id, tool_invocation_id)
      ) STRICT`,
      `INSERT INTO attachment_tool_receipts_v33 SELECT * FROM attachment_tool_receipts`,
      `CREATE TABLE tool_effect_checkpoints_v33 (
        checkpoint_id TEXT PRIMARY KEY,
        effect_intent_id TEXT NOT NULL REFERENCES tool_effects_v33(effect_intent_id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL,
        checkpoint_index INTEGER NOT NULL CHECK (checkpoint_index >= 0),
        phase TEXT NOT NULL,
        member_safe_payload_json TEXT NOT NULL CHECK (json_valid(member_safe_payload_json)),
        created_at INTEGER NOT NULL,
        UNIQUE (effect_intent_id, checkpoint_index)
      ) STRICT`,
      `INSERT INTO tool_effect_checkpoints_v33 SELECT * FROM tool_effect_checkpoints`,
      `CREATE TABLE terminal_tasks_v33 (
        task_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        effect_intent_id TEXT NOT NULL UNIQUE REFERENCES tool_effects_v33(effect_intent_id) ON DELETE CASCADE,
        sandbox_generation INTEGER NOT NULL CHECK (sandbox_generation >= 1),
        provider_task_name TEXT NOT NULL UNIQUE,
        provider_task_id TEXT,
        state TEXT NOT NULL CHECK (
          state IN ('planned', 'submitting', 'running', 'completed', 'failed', 'timed_out', 'cancelled')
        ),
        command_sha256 TEXT NOT NULL,
        command_deadline_at INTEGER NOT NULL,
        exit_code INTEGER,
        termination_reason TEXT CHECK (
          termination_reason IS NULL OR termination_reason IN (
            'exited', 'timed_out', 'cancelled', 'output_limit_exceeded'
          )
        ),
        stdout_head TEXT NOT NULL,
        stdout_tail TEXT NOT NULL,
        stderr_head TEXT NOT NULL,
        stderr_tail TEXT NOT NULL,
        stdout_bytes INTEGER NOT NULL CHECK (stdout_bytes >= 0),
        stderr_bytes INTEGER NOT NULL CHECK (stderr_bytes >= 0),
        output_resource_id TEXT,
        continuation_emitted_at INTEGER,
        started_at INTEGER,
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT`,
      `INSERT INTO terminal_tasks_v33 SELECT * FROM terminal_tasks`,
      `CREATE TABLE terminal_publication_grants_v33 (
        grant_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        source_message_id TEXT NOT NULL REFERENCES participant_transcript_turns(turn_id) ON DELETE CASCADE,
        principal_key TEXT NOT NULL,
        repository_full_name TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        head_ref TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_by_effect_intent_id TEXT REFERENCES tool_effects_v33(effect_intent_id) ON DELETE SET NULL,
        consumed_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (run_id, source_message_id, repository_full_name)
      ) STRICT`,
      `INSERT INTO terminal_publication_grants_v33 SELECT * FROM terminal_publication_grants`,
      `CREATE TABLE repository_publications_v33 (
        publication_id TEXT PRIMARY KEY,
        effect_intent_id TEXT NOT NULL UNIQUE REFERENCES tool_effects_v33(effect_intent_id) ON DELETE CASCADE,
        grant_id TEXT NOT NULL REFERENCES terminal_publication_grants_v33(grant_id) ON DELETE RESTRICT,
        repository_full_name TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        head_ref TEXT NOT NULL,
        expected_old_sha TEXT,
        requested_commit_sha TEXT NOT NULL,
        published_sha TEXT,
        state TEXT NOT NULL CHECK (
          state IN ('planned', 'validating', 'publishing', 'completed', 'failed', 'ambiguous')
        ),
        pull_request_number INTEGER,
        pull_request_url TEXT,
        pull_request_state TEXT CHECK (
          pull_request_state IS NULL OR pull_request_state IN ('open', 'closed', 'merged')
        ),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        failure_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      ) STRICT`,
      `INSERT INTO repository_publications_v33 SELECT * FROM repository_publications`,
      `CREATE TABLE suggested_actions_v33 (
        action_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        source_activity_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL UNIQUE,
        audience_kind TEXT NOT NULL CHECK (audience_kind IN ('user', 'workstream')),
        audience_user_id TEXT,
        provenance_ref TEXT NOT NULL CHECK (length(provenance_ref) <= 2048),
        authorization_selector_hash TEXT NOT NULL CHECK (length(authorization_selector_hash) <= 512),
        source_revisions_json TEXT NOT NULL CHECK (
          json_valid(source_revisions_json) AND length(source_revisions_json) <= 262144
        ),
        source_authorization_epoch INTEGER NOT NULL CHECK (source_authorization_epoch >= 0),
        display_title TEXT NOT NULL CHECK (length(display_title) <= 2048),
        display_body TEXT NOT NULL CHECK (length(display_body) <= 16384),
        status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'dismissed', 'retracted', 'expired')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        resolved_at INTEGER,
        retracted_at INTEGER,
        resolved_by_user_id TEXT,
        resolution_client_id TEXT,
        share_intent_json TEXT CHECK (
          share_intent_json IS NULL
          OR (json_valid(share_intent_json) AND length(share_intent_json) <= 262144)
        ),
        authored_message_id TEXT REFERENCES participant_transcript_turns(turn_id),
        feedback_message_id TEXT UNIQUE,
        PRIMARY KEY (action_id, version),
        CHECK (
          (audience_kind = 'user' AND audience_user_id IS NOT NULL)
          OR (audience_kind = 'workstream' AND audience_user_id IS NULL)
        ),
        CHECK (expires_at >= created_at),
        CHECK (
          (status = 'pending' AND resolved_at IS NULL AND retracted_at IS NULL
            AND resolved_by_user_id IS NULL AND resolution_client_id IS NULL)
          OR (status IN ('accepted', 'dismissed') AND resolved_at IS NOT NULL
            AND retracted_at IS NULL AND resolved_by_user_id IS NOT NULL
            AND resolution_client_id IS NOT NULL)
          OR (status = 'retracted' AND resolved_at IS NULL AND retracted_at IS NOT NULL
            AND resolved_by_user_id IS NULL AND resolution_client_id IS NULL)
          OR (status = 'expired' AND resolved_at IS NULL AND retracted_at IS NULL
            AND resolved_by_user_id IS NULL AND resolution_client_id IS NULL)
        )
      ) STRICT`,
      `INSERT INTO suggested_actions_v33 SELECT * FROM suggested_actions`,
      `CREATE TABLE run_steering_v33 (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
        steering_message_id TEXT NOT NULL REFERENCES participant_transcript_turns(turn_id) ON DELETE CASCADE,
        requested_at INTEGER NOT NULL,
        boundaries_observed INTEGER NOT NULL DEFAULT 0 CHECK (boundaries_observed >= 0),
        max_boundaries INTEGER NOT NULL DEFAULT 2 CHECK (max_boundaries BETWEEN 1 AND 2),
        consumed_at INTEGER
      ) STRICT`,
      `INSERT INTO run_steering_v33 SELECT * FROM run_steering`,
      `CREATE TABLE participant_transcript_attachments (
        turn_id TEXT NOT NULL REFERENCES participant_transcript_turns(turn_id) ON DELETE CASCADE,
        resource_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        attachment_json TEXT NOT NULL CHECK (
          json_valid(attachment_json) AND length(attachment_json) <= 262144
        ),
        PRIMARY KEY(turn_id, resource_id),
        UNIQUE(turn_id, position)
      ) STRICT`,
      `INSERT INTO participant_transcript_attachments(turn_id, resource_id, position, attachment_json)
       SELECT message_id, resource_id, position, attachment_json FROM workstream_message_attachments`,
      `CREATE TABLE participant_transcript_mentions (
        turn_id TEXT NOT NULL REFERENCES participant_transcript_turns(turn_id) ON DELETE CASCADE,
        mention_index INTEGER NOT NULL CHECK (mention_index >= 0),
        mention_kind TEXT NOT NULL CHECK (mention_kind IN ('person', 'connector')),
        target_user_id TEXT,
        connector_type TEXT,
        start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
        end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
        attention_ordinal INTEGER NOT NULL,
        PRIMARY KEY(turn_id, mention_index),
        CHECK (
          (mention_kind = 'person' AND target_user_id IS NOT NULL AND connector_type IS NULL)
          OR (mention_kind = 'connector' AND target_user_id IS NULL AND connector_type IS NOT NULL)
        )
      ) STRICT`,
      `INSERT INTO participant_transcript_mentions(
         turn_id, mention_index, mention_kind, target_user_id, connector_type,
         start_offset, end_offset, attention_ordinal)
       SELECT message_id, mention_index, mention_kind, target_user_id, connector_type,
              start_offset, end_offset, attention_ordinal FROM workstream_message_mentions`,
      `UPDATE substreams SET origin_message_id = NULL WHERE origin_message_id IS NOT NULL`,
      `UPDATE suggested_actions
          SET authored_message_id = NULL WHERE authored_message_id IS NOT NULL`,
      `DELETE FROM workstream_message_records`,
      ...canonicalTurnRelationTriggerDrops(),
      `DROP TABLE run_steering`,
      `ALTER TABLE run_steering_v33 RENAME TO run_steering`,
      `DROP TABLE suggested_actions`,
      `ALTER TABLE suggested_actions_v33 RENAME TO suggested_actions`,
      `DROP TABLE repository_publications`,
      `DROP TABLE terminal_publication_grants`,
      `DROP TABLE terminal_tasks`,
      `DROP TABLE tool_effect_checkpoints`,
      `DROP TABLE attachment_tool_receipts`,
      `DROP TABLE tool_effects`,
      `ALTER TABLE tool_effects_v33 RENAME TO tool_effects`,
      `ALTER TABLE attachment_tool_receipts_v33 RENAME TO attachment_tool_receipts`,
      `ALTER TABLE tool_effect_checkpoints_v33 RENAME TO tool_effect_checkpoints`,
      `ALTER TABLE terminal_tasks_v33 RENAME TO terminal_tasks`,
      `ALTER TABLE terminal_publication_grants_v33 RENAME TO terminal_publication_grants`,
      `ALTER TABLE repository_publications_v33 RENAME TO repository_publications`,
      `DROP TABLE workstream_message_attachments`,
      `DROP TABLE workstream_message_mentions`,
      `DROP TABLE substreams`,
      `ALTER TABLE substreams_v33 RENAME TO substreams`,
      `DROP TABLE workstream_message_records`,
      `CREATE INDEX substreams_kind_status_idx ON substreams(kind, status, id)`,
      `CREATE INDEX substreams_owner_idx
         ON substreams(owner_user_id, status, id) WHERE owner_user_id IS NOT NULL`,
      `CREATE INDEX substreams_parent_idx
         ON substreams(inherit_from_substream_id, id) WHERE inherit_from_substream_id IS NOT NULL`,
      `CREATE UNIQUE INDEX substreams_origin_message_uq
         ON substreams(origin_message_id) WHERE origin_message_id IS NOT NULL`,
      `CREATE INDEX attachment_tool_receipts_invocation_idx
         ON attachment_tool_receipts(tool_invocation_id, resource_id)`,
      `CREATE INDEX tool_effects_status_idx ON tool_effects(status, started_at)`,
      `CREATE UNIQUE INDEX tool_effects_run_call_uq
         ON tool_effects(run_id, tool_call_id)`,
      `CREATE INDEX tool_effect_checkpoints_run_idx
         ON tool_effect_checkpoints(run_id, created_at, checkpoint_id)`,
      `CREATE INDEX terminal_tasks_state_idx
         ON terminal_tasks(state, command_deadline_at, task_id)`,
      `CREATE INDEX terminal_publication_grants_expiry_idx
         ON terminal_publication_grants(expires_at, consumed_at)`,
      `CREATE INDEX repository_publications_target_idx
         ON repository_publications(repository_full_name, base_ref, head_ref, state)`,
      `CREATE INDEX suggested_actions_audience_idx
         ON suggested_actions(audience_kind, audience_user_id, status, created_at)`,
      `CREATE INDEX suggested_actions_source_idx
         ON suggested_actions(source_activity_id, status, created_at)`,
      `CREATE INDEX suggested_actions_expiry_idx
         ON suggested_actions(status, expires_at)`,
      `CREATE INDEX suggested_actions_authored_message_idx
         ON suggested_actions(authored_message_id) WHERE authored_message_id IS NOT NULL`,
      `CREATE INDEX run_steering_pending_idx
         ON run_steering(consumed_at, requested_at) WHERE consumed_at IS NULL`,
      `CREATE INDEX participant_transcript_attachments_resource_idx
         ON participant_transcript_attachments(resource_id, turn_id)`,
      `CREATE INDEX participant_transcript_mentions_user_attention_idx
         ON participant_transcript_mentions(target_user_id, attention_ordinal)`,
      ...canonicalTurnRelationTriggerRecreates(),
      `CREATE VIEW canonical_conversation_turn_details AS
         SELECT turn.turn_id AS id,
                '0' AS substream_id,
                turn.transcript_sequence AS sequence_number,
                turn.attention_ordinal,
                turn.turn_id,
                NULL AS turn_open_sequence,
                NULL AS part_index,
                CASE turn.actor
                  WHEN 'human' THEN 'user'
                  WHEN 'external' THEN 'user'
                  WHEN 'assistant' THEN 'assistant'
                  ELSE 'system'
                END AS role,
                'text' AS kind,
                CASE turn.actor
                  WHEN 'human' THEN 'member'
                  WHEN 'assistant' THEN 'agent'
                  WHEN 'external' THEN 'external'
                  ELSE 'system'
                END AS author_type,
                turn.author_user_id,
                turn.external_actor_json,
                json_extract(payload.payload_json, '$.content') AS content,
                NULL AS content_ref_id,
                NULL AS content_bytes,
                NULL AS content_hash,
                NULL AS answers_message_id,
                NULL AS input_message_ids_json,
                turn.client_message_id,
                NULL AS effect_intent_id,
                NULL AS occurrence_key,
                fact.run_id AS produced_by_run_id,
                NULL AS attempt_epoch,
                NULL AS executor_event_seq,
                NULL AS model_turn_id,
                NULL AS tool_position,
                NULL AS delivery_intent,
                NULL AS input_batch_id,
                NULL AS admission_cut_seq,
                (SELECT block.tool_name FROM participant_transcript_blocks block
                  WHERE block.turn_id = turn.turn_id AND block.block_kind = 'tool'
                  ORDER BY block.block_index LIMIT 1) AS tool_name,
                NULL AS tool_mode,
                (SELECT CASE block.lifecycle_state
                          WHEN 'planned' THEN 'pending' WHEN 'started' THEN 'pending'
                          ELSE block.lifecycle_state END
                   FROM participant_transcript_blocks block
                  WHERE block.turn_id = turn.turn_id AND block.block_kind = 'tool'
                  ORDER BY block.block_index LIMIT 1) AS tool_status,
                NULL AS compacts_through_sequence,
                NULL AS compacts_through_turn_id,
                NULL AS projected_input_hash,
                NULL AS projection_key,
                NULL AS authorization_revisions_json,
                NULL AS lineage_fences_json,
                NULL AS terminal_reason,
                'people' AS visibility,
                0 AS pinned,
                turn.message_type,
                CASE WHEN json_type(payload.payload_json, '$.structuredContent') = 'null'
                  THEN NULL
                  ELSE json_extract(payload.payload_json, '$.structuredContent')
                END AS structured_content_json,
                NULL AS edited_at,
                turn.created_at,
                turn.updated_at
           FROM participant_transcript_turns turn
           JOIN transcript_facts fact ON fact.fact_id = turn.root_fact_id
           JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
          WHERE turn.entry_kind = 'conversation'`,
      // ── formerly v34: name transient output stream identity independently from transcript messages

      `ALTER TABLE runs RENAME COLUMN final_part_id TO final_turn_id`,
      `ALTER TABLE active_output_turns RENAME COLUMN message_id TO stream_id`,
      `DROP TRIGGER _runtime_harness_runs_insert`,
      `DROP TRIGGER _runtime_harness_runs_update`,
      `DROP VIEW _runtime_harness_runs`,
      ...finalTurnHarnessRunContract(),
      // ── formerly v35: make one persistent loop authoritative for each substream

      // v33 retired every pre-persistent-loop elicitation. New questions keep
      // the exact stable Bind tool slot whose delayed answer must settle.
      // Repeat the retirement at the constraint boundary so an object with an
      // interrupted or manually repaired v33 cannot make ADD NOT NULL depend
      // on an unprovable legacy tool identity. Canonical elicitation turns are
      // independent transcript rows and remain intact.
      `DELETE FROM elicitation_requests`,
      `ALTER TABLE elicitation_requests ADD COLUMN tool_call_id TEXT NOT NULL`,
      `CREATE UNIQUE INDEX elicitation_requests_tool_call_idx
         ON elicitation_requests(tool_call_id)`,
      // Pre-v35 Bind loop IDs were per-run identities. There is no sound way
      // to choose one of those projections as the stable substream head, so
      // discard the derived context and bootstrap it once from canonical
      // participant history. ON DELETE CASCADE removes message projections and
      // provider boundaries; canonical transcript rows are independent.
      `DELETE FROM bind_loop_heads`,
      // Bind recovery owns one current projection, not one full message
      // snapshot per transition. The old rows are empty after deleting heads,
      // so v35 can replace the unshipped shape without compatibility copying.
      `DROP TABLE bind_loop_state_messages`,
      `DROP TABLE bind_loop_states`,
      `DROP TABLE bind_provider_boundaries`,
      `DROP TABLE bind_loop_heads`,
      `CREATE TABLE bind_loop_heads (
        loop_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL CHECK (generation > 0),
        state_revision INTEGER NOT NULL CHECK (state_revision > 0),
        transition_kind TEXT NOT NULL,
        system_projection_revision INTEGER NOT NULL CHECK (system_projection_revision > 0),
        system_renderer_version TEXT NOT NULL,
        system_input_hash TEXT NOT NULL,
        projector_version TEXT NOT NULL,
        last_model_turn_index INTEGER NOT NULL CHECK (last_model_turn_index >= 0),
        last_assistant_reservation_json TEXT CHECK (
          last_assistant_reservation_json IS NULL
          OR (json_valid(last_assistant_reservation_json)
            AND json_type(last_assistant_reservation_json) = 'object')
        ),
        updated_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE TABLE bind_loop_state_messages (
        loop_id TEXT NOT NULL REFERENCES bind_loop_heads(loop_id) ON DELETE CASCADE,
        message_position INTEGER NOT NULL CHECK (message_position >= 0),
        loop_sequence INTEGER NOT NULL UNIQUE CHECK (loop_sequence > 0),
        fact_id TEXT NOT NULL REFERENCES transcript_facts(fact_id),
        PRIMARY KEY(loop_id, message_position)
      ) STRICT`,
      `CREATE INDEX bind_loop_state_messages_fact_idx
         ON bind_loop_state_messages(loop_id, fact_id)`,
      `CREATE TABLE bind_provider_boundaries (
        loop_id TEXT NOT NULL REFERENCES bind_loop_heads(loop_id) ON DELETE CASCADE,
        state_revision INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        system_projection_revision INTEGER NOT NULL,
        projector_version TEXT NOT NULL,
        projected_hash TEXT NOT NULL,
        bind_hash TEXT NOT NULL,
        verified_at INTEGER NOT NULL,
        PRIMARY KEY(loop_id, state_revision),
        CHECK (projected_hash = bind_hash)
      ) STRICT`,
      `CREATE TABLE bind_activation_inputs (
        loop_id TEXT NOT NULL REFERENCES bind_loop_heads(loop_id) ON DELETE CASCADE,
        activation_input_id TEXT NOT NULL,
        fact_id TEXT NOT NULL REFERENCES transcript_facts(fact_id),
        admitted_state_revision INTEGER NOT NULL CHECK (admitted_state_revision > 0),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(loop_id, activation_input_id)
      ) STRICT`,
      `CREATE TABLE substream_loops (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        loop_id TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        status TEXT NOT NULL CHECK (status IN ('idle', 'executing')),
        cycle_ordinal INTEGER NOT NULL CHECK (cycle_ordinal >= 0),
        step_ordinal INTEGER NOT NULL CHECK (step_ordinal >= 0),
        bind_state_revision INTEGER NOT NULL CHECK (bind_state_revision >= 0),
        active_execution_id TEXT,
        active_execution_epoch INTEGER CHECK (
          active_execution_epoch IS NULL OR active_execution_epoch > 0
        ),
        lease_owner TEXT,
        lease_expires_at INTEGER,
        stop_requested_at INTEGER,
        stop_after_step_ordinal INTEGER CHECK (
          stop_after_step_ordinal IS NULL OR stop_after_step_ordinal >= 0
        ),
        stop_reason TEXT,
        next_input_sequence INTEGER NOT NULL CHECK (next_input_sequence > 0),
        next_assistant_turn_sequence INTEGER NOT NULL CHECK (next_assistant_turn_sequence > 0),
        next_execution_sequence INTEGER NOT NULL CHECK (next_execution_sequence > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        CHECK (
          (status = 'idle'
            AND active_execution_id IS NULL
            AND active_execution_epoch IS NULL
            AND lease_owner IS NULL
            AND lease_expires_at IS NULL
            AND stop_requested_at IS NULL
            AND stop_after_step_ordinal IS NULL
            AND stop_reason IS NULL)
          OR (status = 'executing'
            AND active_execution_id IS NOT NULL
            AND active_execution_epoch IS NOT NULL
            AND lease_owner IS NOT NULL
            AND lease_expires_at IS NOT NULL)
        ),
        CHECK (
          (stop_requested_at IS NULL
            AND stop_after_step_ordinal IS NULL
            AND stop_reason IS NULL)
          OR (status = 'executing'
            AND stop_requested_at IS NOT NULL
            AND stop_after_step_ordinal IS NOT NULL
            AND stop_reason IS NOT NULL)
        )
      ) STRICT`,
      `CREATE TABLE pending_loop_input_mailbox (
        input_id TEXT PRIMARY KEY,
        loop_id TEXT NOT NULL REFERENCES substream_loops(loop_id) ON DELETE RESTRICT,
        input_sequence INTEGER NOT NULL CHECK (input_sequence > 0),
        admitted_after_transcript_sequence INTEGER NOT NULL CHECK (
          admitted_after_transcript_sequence >= 0
        ),
        client_message_id TEXT NOT NULL UNIQUE,
        preparation_kind TEXT NOT NULL CHECK (
          preparation_kind IN (
            'human_message', 'human_elicitation',
            'external_message', 'external_elicitation'
          )
        ),
        envelope_json TEXT CHECK (
          envelope_json IS NULL
          OR (json_valid(envelope_json) AND json_type(envelope_json) = 'object')
        ),
        state TEXT NOT NULL CHECK (
          state IN ('preparing', 'ready', 'failed', 'discarded')
        ),
        terminal_code TEXT CHECK (
          terminal_code IS NULL OR length(terminal_code) BETWEEN 1 AND 160
        ),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        UNIQUE(loop_id, input_sequence),
        CHECK (
          (state = 'preparing' AND envelope_json IS NOT NULL AND terminal_code IS NULL)
          OR (state = 'failed' AND envelope_json IS NULL AND terminal_code IS NOT NULL)
          OR (state IN ('ready', 'discarded')
            AND envelope_json IS NULL AND terminal_code IS NULL)
        )
      ) STRICT`,
      ...pendingLoopInputMailboxGuards(),
      `CREATE TABLE pending_loop_inputs (
        input_id TEXT PRIMARY KEY,
        loop_id TEXT NOT NULL REFERENCES substream_loops(loop_id) ON DELETE RESTRICT,
        input_sequence INTEGER NOT NULL CHECK (input_sequence > 0),
        prepared_turn_id TEXT NOT NULL UNIQUE,
        admitted_after_transcript_sequence INTEGER NOT NULL CHECK (
          admitted_after_transcript_sequence >= 0
        ),
        mode TEXT NOT NULL CHECK (mode IN ('steer', 'queue')),
        actor TEXT NOT NULL CHECK (actor IN ('human', 'external', 'system')),
        author_user_id TEXT,
        author_name_snapshot TEXT,
        author_avatar_url_snapshot TEXT,
        client_message_id TEXT UNIQUE,
        external_actor_json TEXT CHECK (
          external_actor_json IS NULL OR json_valid(external_actor_json)
        ),
        message_type TEXT NOT NULL,
        prepared_payload_id TEXT NOT NULL,
        prepared_fact_id TEXT NOT NULL UNIQUE,
        prepared_payload_audience TEXT NOT NULL CHECK (
          prepared_payload_audience IN ('shared', 'participant', 'model')
        ),
        prepared_payload_media_type TEXT NOT NULL,
        prepared_payload_json TEXT NOT NULL CHECK (json_valid(prepared_payload_json)),
        prepared_payload_sha256 TEXT NOT NULL,
        prepared_payload_byte_length INTEGER NOT NULL CHECK (prepared_payload_byte_length >= 0),
        bind_payload_json TEXT NOT NULL CHECK (
          json_valid(bind_payload_json) AND json_type(bind_payload_json) = 'object'
        ),
        provenance_json TEXT NOT NULL CHECK (
          json_valid(provenance_json) AND json_type(provenance_json) = 'object'
        ),
        authorization_json TEXT NOT NULL CHECK (
          json_valid(authorization_json) AND json_type(authorization_json) = 'object'
        ),
        attachments_json TEXT NOT NULL CHECK (
          json_valid(attachments_json) AND json_type(attachments_json) = 'array'
        ),
        mentions_json TEXT NOT NULL CHECK (
          json_valid(mentions_json) AND json_type(mentions_json) = 'array'
        ),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        UNIQUE(loop_id, input_sequence),
        CHECK (prepared_turn_id = input_id),
        CHECK (
          (actor = 'human'
            AND author_user_id IS NOT NULL
            AND author_name_snapshot IS NOT NULL
            AND external_actor_json IS NULL)
          OR (actor = 'external'
            AND author_user_id IS NULL
            AND author_name_snapshot IS NULL
            AND author_avatar_url_snapshot IS NULL
            AND external_actor_json IS NOT NULL)
          OR (actor = 'system'
            AND author_user_id IS NULL
            AND author_name_snapshot IS NULL
            AND author_avatar_url_snapshot IS NULL
            AND external_actor_json IS NULL)
        )
      ) STRICT`,
      `CREATE TRIGGER pending_loop_inputs_prepared_immutable
       BEFORE UPDATE OF
         input_id, loop_id, input_sequence, prepared_turn_id,
         admitted_after_transcript_sequence, mode,
         actor, author_user_id, author_name_snapshot,
         author_avatar_url_snapshot, client_message_id, external_actor_json,
         message_type, prepared_payload_id, prepared_fact_id,
         prepared_payload_audience, prepared_payload_media_type,
         prepared_payload_json, prepared_payload_sha256,
         prepared_payload_byte_length, bind_payload_json, provenance_json, authorization_json,
         attachments_json, mentions_json, created_at
       ON pending_loop_inputs
       WHEN NEW.input_id IS NOT OLD.input_id
         OR NEW.loop_id IS NOT OLD.loop_id
         OR NEW.input_sequence IS NOT OLD.input_sequence
         OR NEW.prepared_turn_id IS NOT OLD.prepared_turn_id
         OR NEW.admitted_after_transcript_sequence IS NOT OLD.admitted_after_transcript_sequence
         OR NEW.mode IS NOT OLD.mode
         OR NEW.actor IS NOT OLD.actor
         OR NEW.author_user_id IS NOT OLD.author_user_id
         OR NEW.author_name_snapshot IS NOT OLD.author_name_snapshot
         OR NEW.author_avatar_url_snapshot IS NOT OLD.author_avatar_url_snapshot
         OR NEW.client_message_id IS NOT OLD.client_message_id
         OR NEW.external_actor_json IS NOT OLD.external_actor_json
         OR NEW.message_type IS NOT OLD.message_type
         OR NEW.prepared_payload_id IS NOT OLD.prepared_payload_id
         OR NEW.prepared_fact_id IS NOT OLD.prepared_fact_id
         OR NEW.prepared_payload_audience IS NOT OLD.prepared_payload_audience
         OR NEW.prepared_payload_media_type IS NOT OLD.prepared_payload_media_type
         OR NEW.prepared_payload_json IS NOT OLD.prepared_payload_json
         OR NEW.prepared_payload_sha256 IS NOT OLD.prepared_payload_sha256
         OR NEW.prepared_payload_byte_length IS NOT OLD.prepared_payload_byte_length
         OR NEW.bind_payload_json IS NOT OLD.bind_payload_json
         OR NEW.provenance_json IS NOT OLD.provenance_json
         OR NEW.authorization_json IS NOT OLD.authorization_json
         OR NEW.attachments_json IS NOT OLD.attachments_json
         OR NEW.mentions_json IS NOT OLD.mentions_json
         OR NEW.created_at IS NOT OLD.created_at
       BEGIN
         SELECT RAISE(ABORT, 'pending_loop_input_prepared_fields_are_immutable');
       END`,
      `CREATE INDEX pending_loop_inputs_ready_idx
         ON pending_loop_inputs(loop_id, input_sequence)`,
      `CREATE TABLE delivered_loop_inputs (
        input_id TEXT PRIMARY KEY,
        loop_id TEXT NOT NULL REFERENCES substream_loops(loop_id) ON DELETE RESTRICT,
        input_sequence INTEGER NOT NULL CHECK (input_sequence > 0),
        delivered_turn_id TEXT NOT NULL UNIQUE
          REFERENCES participant_transcript_turns(turn_id) ON DELETE RESTRICT,
        delivered_attention_ordinal INTEGER NOT NULL CHECK (delivered_attention_ordinal > 0),
        delivered_at INTEGER NOT NULL,
        UNIQUE(loop_id, input_sequence)
      ) STRICT`,
      `CREATE TRIGGER delivered_loop_inputs_immutable
       BEFORE UPDATE ON delivered_loop_inputs
       BEGIN
         SELECT RAISE(ABORT, 'delivered_loop_input_is_immutable');
       END`,
      `CREATE TABLE assistant_turn_reservations (
        turn_id TEXT PRIMARY KEY,
        loop_id TEXT NOT NULL REFERENCES substream_loops(loop_id) ON DELETE RESTRICT,
        execution_id TEXT NOT NULL,
        cycle_ordinal INTEGER NOT NULL CHECK (cycle_ordinal > 0),
        execution_epoch INTEGER NOT NULL CHECK (execution_epoch > 0),
        assistant_turn_sequence INTEGER NOT NULL CHECK (assistant_turn_sequence > 0),
        transcript_sequence INTEGER NOT NULL UNIQUE CHECK (transcript_sequence > 0),
        stream_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reserved', 'streaming', 'materialized')),
        outcome TEXT CHECK (outcome IS NULL OR outcome IN ('accepted', 'error')),
        materialized_turn_id TEXT UNIQUE
          REFERENCES participant_transcript_turns(turn_id) ON DELETE RESTRICT,
        reserved_at INTEGER NOT NULL,
        started_at INTEGER,
        materialized_at INTEGER,
        updated_at INTEGER NOT NULL CHECK (updated_at >= reserved_at),
        UNIQUE(loop_id, assistant_turn_sequence),
        CHECK (
          (state = 'reserved'
            AND started_at IS NULL AND outcome IS NULL
            AND materialized_at IS NULL AND materialized_turn_id IS NULL)
          OR (state = 'streaming'
            AND started_at IS NOT NULL AND outcome IS NULL
            AND materialized_at IS NULL AND materialized_turn_id IS NULL)
          OR (state = 'materialized'
            AND outcome IS NOT NULL AND materialized_at IS NOT NULL
            AND materialized_turn_id = turn_id)
        )
      ) STRICT`,
      `CREATE UNIQUE INDEX assistant_turn_reservations_active_uq
         ON assistant_turn_reservations(loop_id)
         WHERE state IN ('reserved', 'streaming')`,
      `CREATE INDEX assistant_turn_reservations_stream_idx
         ON assistant_turn_reservations(stream_id, assistant_turn_sequence)`,
      `CREATE INDEX participant_transcript_activity_idx
         ON participant_transcript_turns(activity_id)
         WHERE activity_id IS NOT NULL`,
      `CREATE INDEX assistant_turn_reservations_cycle_idx
         ON assistant_turn_reservations(loop_id, cycle_ordinal, assistant_turn_sequence)`,
      `ALTER TABLE runs ADD COLUMN substream_loop_id TEXT
         REFERENCES substream_loops(loop_id) ON DELETE RESTRICT`,
      `ALTER TABLE runs ADD COLUMN loop_input_id TEXT
         REFERENCES delivered_loop_inputs(input_id) ON DELETE RESTRICT`,
      `ALTER TABLE runs ADD COLUMN loop_cycle_ordinal INTEGER
         CHECK (loop_cycle_ordinal IS NULL OR loop_cycle_ordinal > 0)`,
      `ALTER TABLE runs ADD COLUMN loop_execution_id TEXT`,
      `ALTER TABLE runs ADD COLUMN loop_execution_epoch INTEGER
         CHECK (loop_execution_epoch IS NULL OR loop_execution_epoch > 0)`,
      `ALTER TABLE runs ADD COLUMN loop_execution_sequence INTEGER
         CHECK (loop_execution_sequence IS NULL OR loop_execution_sequence > 0)`,
      `ALTER TABLE runs ADD COLUMN execution_context_json TEXT
         CHECK (
           execution_context_json IS NULL
           OR (json_valid(execution_context_json)
             AND json_type(execution_context_json) = 'object')
         )`,
      `ALTER TABLE runs ADD COLUMN execution_available_at INTEGER
         CHECK (execution_available_at IS NULL OR execution_available_at >= 0)`,
      `ALTER TABLE runs ADD COLUMN external_settled_at INTEGER
         CHECK (external_settled_at IS NULL OR external_settled_at >= 0)`,
      `ALTER TABLE runs ADD COLUMN last_settlement_error_code TEXT`,
      // A receipt is subordinate to the singleton loop. Multiple admitted
      // receipts may wait while one execution owns the loop lease, so the old
      // per-substream run exclusion is both redundant and incorrect.
      `DROP INDEX IF EXISTS runs_mutating_substream_uq`,
      `CREATE UNIQUE INDEX runs_loop_execution_uq
         ON runs(substream_loop_id, loop_execution_sequence)
         WHERE substream_loop_id IS NOT NULL AND loop_execution_sequence IS NOT NULL`,
      `CREATE INDEX runs_loop_input_idx
         ON runs(loop_input_id, created_at) WHERE loop_input_id IS NOT NULL`,
      `CREATE INDEX runs_loop_recovery_idx
         ON runs(substream_loop_id, status, execution_available_at, created_at)
         WHERE substream_loop_id IS NOT NULL
           AND status IN ('admitted', 'running')`,
      `CREATE INDEX runs_execution_due_idx
         ON runs(status, execution_available_at, created_at)
         WHERE execution_context_json IS NOT NULL
           AND substream_loop_id IS NULL
           AND terminalized_at IS NULL
           AND status IN ('admitted', 'running')`,
      `CREATE INDEX runs_external_settlement_due_idx
         ON runs(external_settled_at, updated_at)
         WHERE terminalized_at IS NOT NULL AND external_settled_at IS NULL`,
      // Pre-v35 run dispatches were per-message operational authority. They
      // are not valid inputs to the stable-loop claim path. Retain referenced
      // run rows only as already-settled historical receipts and discard their
      // resumable/streaming state; canonical participant turns are independent.
      `DELETE FROM active_output_chunks`,
      `DELETE FROM active_output_turns`,
      // The interim chain retired still-active run receipts here; on the one
      // real upgrade path every pre-cutover run row is already deleted above,
      // so the retirement was a no-op and is not carried.
      `DROP TABLE run_steering`,
      `DROP TABLE agent_run_dispatches`,
      // ── formerly v36: recover WorkspaceDO draft reservations for pending attachment inputs

      `CREATE TABLE pending_attachment_reservation_recovery (
        input_id TEXT NOT NULL CHECK (length(input_id) = 36)
          REFERENCES pending_loop_input_mailbox(input_id) ON DELETE RESTRICT,
        resource_id TEXT NOT NULL CHECK (length(resource_id) = 36),
        workspace_id TEXT NOT NULL CHECK (length(workspace_id) = 36),
        workstream_id TEXT NOT NULL CHECK (length(workstream_id) = 36),
        release_authority TEXT NOT NULL CHECK (
          release_authority IN ('preparation', 'projection')
        ),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (input_id, resource_id)
      ) STRICT`,
      `CREATE INDEX pending_attachment_reservation_recovery_input_idx
         ON pending_attachment_reservation_recovery(input_id, resource_id)`,
      // ── formerly v37: retire the final work-stream runtime SQL compatibility objects

      `DROP TRIGGER IF EXISTS _runtime_harness_runs_insert`,
      `DROP TRIGGER IF EXISTS _runtime_harness_runs_update`,
      `DROP TRIGGER IF EXISTS _runtime_inference_attempts_insert`,
      `DROP VIEW IF EXISTS _runtime_harness_runs`,
      `DROP VIEW IF EXISTS _runtime_inference_attempts`,
      `DROP VIEW IF EXISTS _runtime_users`,
      `DROP TABLE IF EXISTS _runtime_statement_changes`,
      // ── formerly v38: make recovered activity outcomes exact and qualify their timing

      // Activity rows are an execution projection, not message history. Rally
      // has no production users at this cutover, so rebuild this projection
      // instead of carrying a compatibility table solely to widen its terminal
      // state vocabulary. Canonical participant turns are untouched.
      `DROP TABLE transcript_activity_intervals`,
      `DROP TABLE transcript_activities`,
      `CREATE TABLE transcript_activities (
        activity_id TEXT PRIMARY KEY,
        parent_activity_id TEXT REFERENCES transcript_activities(activity_id),
        scope TEXT NOT NULL CHECK (scope IN ('response', 'assistant_turn', 'plugin', 'tool_call', 'thinking', 'compaction')),
        subject_id TEXT NOT NULL,
        call_index INTEGER,
        label TEXT NOT NULL,
        lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'completed', 'failed', 'cancelled', 'abandoned', 'ambiguous')),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (call_index IS NULL OR call_index >= 0)
      ) STRICT`,
      `CREATE INDEX transcript_active_activity_idx
         ON transcript_activities(lifecycle_state, parent_activity_id, call_index, created_at)
         WHERE lifecycle_state = 'active'`,
      `CREATE INDEX transcript_activity_subject_idx
         ON transcript_activities(scope, subject_id, revision)`,
      `CREATE TABLE transcript_activity_intervals (
        activity_id TEXT NOT NULL REFERENCES transcript_activities(activity_id) ON DELETE CASCADE,
        interval_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        stopped_at INTEGER,
        duration_ms INTEGER,
        revision INTEGER NOT NULL CHECK (revision > 0),
        boundary_source TEXT NOT NULL DEFAULT 'rally'
          CHECK (boundary_source IN ('rally', 'provider', 'normalized', 'recovered')),
        timing_accuracy TEXT NOT NULL DEFAULT 'observed'
          CHECK (timing_accuracy IN ('observed', 'upper_bound')),
        PRIMARY KEY(activity_id, interval_id),
        CHECK (stopped_at IS NULL OR stopped_at >= started_at),
        CHECK (duration_ms IS NULL OR duration_ms >= 0)
      ) STRICT`,
      `CREATE INDEX transcript_active_interval_idx
         ON transcript_activity_intervals(activity_id, started_at)
         WHERE stopped_at IS NULL`,
      `CREATE INDEX transcript_activity_parent_idx
         ON transcript_activities(parent_activity_id, activity_id)`,
      // ── formerly v40: persist canonical transcript reservations for active streamed turns

      // Active output is a transient recovery projection, not canonical
      // history. Retire any pre-v40 projection rather than inventing the
      // transcript reservation that its old row did not persist.
      `DELETE FROM active_output_chunks`,
      `DELETE FROM active_output_turns`,
      `ALTER TABLE active_output_turns ADD COLUMN transcript_sequence INTEGER NOT NULL
         CHECK (transcript_sequence > 0)`,
    ],
  },
  {
    version: 34,
    description: "pending loop input sequence may be reordered while content stays immutable",
    statements: [
      `DROP TRIGGER IF EXISTS pending_loop_inputs_prepared_immutable`,
      pendingLoopInputsPreparedImmutableTrigger(),
    ],
  },
  {
    version: 35,
    description: "retire suggested context state and preserve accepted resources as attachments",
    statements: [
      // A pending feedback effect belongs to a product that no longer has a
      // receiver. Removing it here keeps the generic outbox from retrying a
      // payload whose protocol has been retired.
      `DELETE FROM durable_outbox WHERE partition_key GLOB 'suggestion:*'`,
      // Accepted resources outlive the feature, so their original audience
      // must outlive it too. Copy only that security fact into a generic table
      // before the suggestion rows disappear; invalid/missing legacy audience
      // data becomes JSON null and therefore continues to fail closed.
      `CREATE TABLE content_audience_fences (
        fence_id TEXT PRIMARY KEY,
        audience_json TEXT NOT NULL CHECK (
          json_valid(audience_json) AND length(audience_json) <= 262144
        ),
        created_at INTEGER NOT NULL
      ) STRICT`,
      `INSERT INTO content_audience_fences (fence_id, audience_json, created_at)
       SELECT action_id || ':' || version,
              COALESCE(json_extract(share_intent_json, '$.sourceAudience'), 'null'),
              COALESCE(resolved_at, created_at)
         FROM suggested_actions
        WHERE status = 'accepted'`,
      `DROP TRIGGER IF EXISTS accepted_suggestion_source_audience_immutable`,
      `DROP TRIGGER IF EXISTS accepted_suggestion_source_audience_retained`,
      `DROP TRIGGER IF EXISTS participants_restricted_content_insert`,
      `DROP TRIGGER IF EXISTS participants_restricted_content_reactivate`,
      `DROP TRIGGER IF EXISTS workstream_restricted_content_scope`,
      `DROP TABLE suggested_actions`,
      ...retainedContentAudienceTriggers(),
      // Resources a person previously accepted remain useful context. They are
      // no longer suggestion state, so normalize the relationship before the
      // CHECK-constrained table is rebuilt without that retired vocabulary.
      `UPDATE workstream_resource_links
          SET relationship_type = 'attachment'
        WHERE relationship_type = 'suggested_activity'`,
      `CREATE TABLE workstream_resource_links_v35 (
        resource_id TEXT PRIMARY KEY,
        attached_by_user_id TEXT,
        watch_enabled INTEGER NOT NULL CHECK (watch_enabled IN (0, 1)),
        relationship_type TEXT NOT NULL CHECK (
          relationship_type IN (${CURRENT_RESOURCE_RELATIONSHIP_CHECK_VALUES})
        ),
        resource_json TEXT NOT NULL CHECK (json_valid(resource_json)),
        attached_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT`,
      `INSERT INTO workstream_resource_links_v35
         (resource_id, attached_by_user_id, watch_enabled, relationship_type,
          resource_json, attached_at, updated_at)
       SELECT resource_id, attached_by_user_id, watch_enabled, relationship_type,
              resource_json, attached_at, updated_at
         FROM workstream_resource_links`,
      `DROP TABLE workstream_resource_links`,
      `ALTER TABLE workstream_resource_links_v35 RENAME TO workstream_resource_links`,
      `CREATE INDEX workstream_resource_links_relation_idx
         ON workstream_resource_links(relationship_type, attached_at, resource_id)`,
    ],
  },
  {
    version: 36,
    description: "an automation activation is a loop input, so the mailbox admits its kind",
    // `pending_loop_inputs` points at this table, so the drop-and-rename is a
    // referenced-parent rebuild: enforcement is off for the swap and
    // `foreign_key_check` proves on commit that no delivered input was orphaned.
    foreignKeys: "disabled_during_rebuild",
    statements: [
      // An automation waking the room it belongs to has to arrive the way an
      // external message does — as a loop input that starts a run — and a
      // pending input exists only where a preparation reserved it. The
      // vocabulary is a CHECK, which SQLite cannot widen in place.
      `CREATE TABLE pending_loop_input_mailbox_v36 (
        input_id TEXT PRIMARY KEY,
        loop_id TEXT NOT NULL REFERENCES substream_loops(loop_id) ON DELETE RESTRICT,
        input_sequence INTEGER NOT NULL CHECK (input_sequence > 0),
        admitted_after_transcript_sequence INTEGER NOT NULL CHECK (
          admitted_after_transcript_sequence >= 0
        ),
        client_message_id TEXT NOT NULL UNIQUE,
        preparation_kind TEXT NOT NULL CHECK (
          preparation_kind IN (
            'human_message', 'human_elicitation',
            'external_message', 'external_elicitation',
            'automation_activation'
          )
        ),
        envelope_json TEXT CHECK (
          envelope_json IS NULL
          OR (json_valid(envelope_json) AND json_type(envelope_json) = 'object')
        ),
        state TEXT NOT NULL CHECK (
          state IN ('preparing', 'ready', 'failed', 'discarded')
        ),
        terminal_code TEXT CHECK (
          terminal_code IS NULL OR length(terminal_code) BETWEEN 1 AND 160
        ),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        UNIQUE(loop_id, input_sequence),
        CHECK (
          (state = 'preparing' AND envelope_json IS NOT NULL AND terminal_code IS NULL)
          OR (state = 'failed' AND envelope_json IS NULL AND terminal_code IS NOT NULL)
          OR (state IN ('ready', 'discarded')
            AND envelope_json IS NULL AND terminal_code IS NULL)
        )
      ) STRICT`,
      `INSERT INTO pending_loop_input_mailbox_v36
         (input_id, loop_id, input_sequence, admitted_after_transcript_sequence,
          client_message_id, preparation_kind, envelope_json, state, terminal_code,
          created_at, updated_at)
       SELECT input_id, loop_id, input_sequence, admitted_after_transcript_sequence,
              client_message_id, preparation_kind, envelope_json, state, terminal_code,
              created_at, updated_at
         FROM pending_loop_input_mailbox`,
      `DROP TABLE pending_loop_input_mailbox`,
      `ALTER TABLE pending_loop_input_mailbox_v36 RENAME TO pending_loop_input_mailbox`,
      ...pendingLoopInputMailboxGuards(),
    ],
  },
  {
    version: 37,
    description: "a stored automation run context has no delivery targets",
    statements: [
      // The frozen automation run context lives in two places: the automation's
      // own object, whose v13 stripped `deliveryTargets` when the field left the
      // strict schema, and here, copied verbatim into every child's execution
      // receipt and never cleared. The schema that reads this column nests the
      // same strict object, so a copy still carrying the key cannot be claimed,
      // recovered, settled, or retried. Same rewrite, one level deeper.
      `UPDATE runs
          SET execution_context_json = json_remove(
                execution_context_json, '$.automationRunContext.deliveryTargets')
        WHERE json_extract(execution_context_json, '$.automationRunContext.deliveryTargets')
              IS NOT NULL`,
    ],
  },
  {
    version: 38,
    description: "remove retired block dashboard state, runs, and refresh scheduling",
    statements: [
      `DELETE FROM due_work WHERE job_key = 'block_dashboard_refresh'`,
      // The retired dashboard used the ordinary harness tables for execution. Its own run
      // table pointed at those rows, so dropping that child table alone would
      // strand admitted/running roots which the remaining product selectors
      // now correctly treat as ordinary runs. Clear the few non-cascading
      // children first; every other operational child follows the run FK.
      `DELETE FROM repository_publications
        WHERE effect_intent_id IN (
          SELECT effect.effect_intent_id FROM tool_effects effect
          JOIN runs run ON run.run_id = effect.run_id
          WHERE run.origin = 'block_dashboard_block'
        )`,
      `DELETE FROM tool_effects
        WHERE run_id IN (
          SELECT run_id FROM runs WHERE origin = 'block_dashboard_block'
        )`,
      `DELETE FROM elicitation_requests
        WHERE run_id IN (
          SELECT run_id FROM runs WHERE origin = 'block_dashboard_block'
        )`,
      `DELETE FROM runs WHERE origin = 'block_dashboard_block'`,
      `DROP TABLE IF EXISTS block_dashboard_block_runs`,
      `DROP TABLE IF EXISTS block_dashboard_configuration_versions`,
      `DROP TABLE IF EXISTS block_dashboard_user_preferences`,
      `DROP INDEX IF EXISTS parts_pending_tool_fence_idx`,
    ],
  },
  {
    version: 39,
    description: "a conversation records the kind of parent it belongs to",
    statements: [
      // `workstream_key` is the parent id. It kept its column name because the
      // runtime-compat view and triggers in `workstream-runtime-compat-schema.ts`
      // name it inside released migration text; what changed is that the
      // parent may now be an automation as well as a work stream, and the
      // object says which. Every object that exists at this version belongs to
      // a work stream, which is what the default records.
      `ALTER TABLE workstream ADD COLUMN parent_kind TEXT NOT NULL DEFAULT 'workstream'
         CHECK (parent_kind IN ('workstream', 'automation'))`,
    ],
  },
  {
    version: 40,
    description: "freeze substream source captures and immutable idle context seeds",
    statements: [
      `CREATE TABLE substream_context_captures (
         operation_id TEXT PRIMARY KEY,
         request_json TEXT NOT NULL,
         capture_json TEXT NOT NULL,
         created_at INTEGER NOT NULL
       ) STRICT`,
      `CREATE TABLE substream_initial_context (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         operation_id TEXT NOT NULL UNIQUE,
         context_json TEXT NOT NULL,
         created_at INTEGER NOT NULL
       ) STRICT`,
    ],
  },
  {
    version: 41,
    description: "mirror parent-owned private-child membership with per-person versions",
    statements: [
      `CREATE TABLE private_child_membership_authority (
         user_id TEXT PRIMARY KEY,
         version INTEGER NOT NULL CHECK (version > 0),
         active INTEGER NOT NULL CHECK (active IN (0, 1)),
         actor_user_id TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       ) STRICT`,
    ],
  },
  {
    version: 42,
    description: "durably project canonical transcript text and backfill existing turns",
    statements: [...CONVERSATION_LINK_SEARCH_SCHEMA, ...TRANSCRIPT_SEARCH_MIGRATION_STATEMENTS],
  },
  {
    version: 43,
    description: "conversation Sidekick attachments and immutable per-execution instruction snapshots",
    statements: [
      `CREATE TABLE sidekick_attachments (sidekick_id TEXT PRIMARY KEY, attached_at INTEGER NOT NULL) STRICT`,
      `CREATE TABLE sidekick_execution_skills (execution_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))) STRICT`,
    ],
  }, {
    version: 44,
    description: 'durable authorization location discovery and membership refresh intent',
    statements: AUTHORIZATION_PROJECTION_MIGRATION,
  }, {
    version: 45,
    description: "the loop records how far into the transcript its projection has looked",
    statements: [
      // A human message that starts no run is a canonical turn and nothing
      // else: the model's conversation is appended one admission at a time,
      // never re-read from the transcript, so the turn rendered for every
      // member and was invisible to the agent forever. The loop now records
      // the highest transcript sequence its projection has considered, and
      // the next admission appends every conversation turn between that mark
      // and its own before appending itself.
      `ALTER TABLE substream_loops ADD COLUMN transcript_projected_through INTEGER NOT NULL DEFAULT 0
         CHECK (transcript_projected_through >= 0)`,
      // Existing rooms start "seen through now". The alternative — starting at
      // zero — would surface every side conversation a room has ever had into
      // the model's context on its next activation, all at once, which is a
      // behaviour change nobody in that room asked for and a burst the first
      // activation after deploy would pay.
      `UPDATE substream_loops
          SET transcript_projected_through = (
            SELECT next_transcript_sequence - 1 FROM transcript_counters WHERE id = 1
          )
        WHERE EXISTS (SELECT 1 FROM transcript_counters WHERE id = 1)`,
    ],
  },
  {
    version: 46,
    description: "conversation-owned stable Sidekick skill names",
    statements: [
      `CREATE TABLE sidekick_skill_names (
         sidekick_id TEXT PRIMARY KEY,
         name TEXT NOT NULL UNIQUE
       ) STRICT`,
    ],
  },

  { version: 47, description: "shared workstream appearance", statements: [
    `ALTER TABLE workstream ADD COLUMN appearance_json TEXT CHECK (appearance_json IS NULL OR json_valid(appearance_json))`,
  ] },

  {
    version: 48,
    description: "record a permanent retirement tombstone",
    statements: [
      // A retired workspace never reopens, and the fence in front of every
      // method here reads this table. It lives in the object rather than D1
      // because the gate answers during constructor recovery, before anything
      // else this object could consult is admitted.
      ...OBJECT_RETIREMENT_SCHEMA_STATEMENTS,
    ],
  },
  { version: 49, description: 'retain source mutation time through authorization projection delivery',
    statements: AUTHORIZATION_PROJECTION_TIMING_MIGRATION },
  { version: 50, description: 'mirror private child lifecycle versions', statements: [
    `CREATE TABLE private_child_lifecycle_authority (
      id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL,
      archived_at INTEGER
    ) STRICT`,
  ] },
  {
    version: 51,
    description: "context-residency ledger for resident context blocks",
    statements: [
      // Which resident context blocks (a checkout's AGENTS.md today) this
      // conversation has loaded, at which content, and where each lives:
      // in the transcript, in the system prompt, or nowhere. Rows are never
      // deleted; `none` is the bookkeeping of what was loaded previously.
      // `content` carries no byte CHECK yet: the bound is an open placeholder
      // in TypeScript until the team sets it, and a CHECK is not an inert site.
      `CREATE TABLE resident_context_blocks (
         kind TEXT NOT NULL,
         block_id TEXT NOT NULL,
         sha256 TEXT NOT NULL,
         source_generation INTEGER,
         content TEXT NOT NULL,
         truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
         residency TEXT NOT NULL CHECK (residency IN ('transcript', 'system', 'none')),
         superseded INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0, 1)),
         compactions_remaining INTEGER NOT NULL DEFAULT 0 CHECK (compactions_remaining >= 0),
         pending_delivery INTEGER NOT NULL DEFAULT 0 CHECK (pending_delivery IN (0, 1)),
         first_delivered_at INTEGER NOT NULL,
         last_delivered_at INTEGER NOT NULL,
         PRIMARY KEY (kind, block_id, sha256)
       ) STRICT`,
      // One row per compaction event: written when the harness prepares the
      // compaction, naming exactly the blocks whose transitions were rendered
      // into the compacted system message, and stamped when the commit applies
      // them, so a block recorded in between is left alone and a replayed
      // commit changes the ledger exactly once.
      `CREATE TABLE resident_context_compactions (
         compaction_event_id TEXT PRIMARY KEY,
         prepared_keys TEXT NOT NULL,
         prepared_at INTEGER NOT NULL,
         applied_at INTEGER
       ) STRICT`,
    ],
  },
  {
    version: 52,
    description: "project conversation title and archive state into the search index",
    statements: CONVERSATION_DISPLAY_SEARCH_MIGRATION_STATEMENTS,
  },
  {
    version: 53,
    description: "requeue every committed turn after the 2026-09-10 consumer version skew dead-lettered rewrites",
    statements: CONVERSATION_SEARCH_REPROJECTION_MIGRATION_STATEMENTS,
  },
  {
    version: 54,
    description: "retain connector identity independently of participant activity labels",
    statements: ["ALTER TABLE transcript_activities ADD COLUMN connector_type TEXT"],
  },
  { version: 55, description: "allow configured deployment identifiers", statements: [
  "PRAGMA defer_foreign_keys = ON",
  "CREATE TABLE \"_region_copy_workstream\" AS SELECT * FROM \"workstream\"",
  "DROP TRIGGER \"workstream_restricted_content_scope\"",
  "DROP TRIGGER \"authorization_workstream_insert\"",
  "DROP TRIGGER \"authorization_workstream_update\"",
  "DROP TRIGGER \"authorization_workstream_delete\"",
  "DROP TRIGGER \"workstream_search_display_update\"",
  "DELETE FROM \"workstream\"",
  "DROP TABLE \"workstream\"",
  "CREATE TABLE workstream (\n    id INTEGER PRIMARY KEY CHECK (id = 1),\n    workstream_key TEXT NOT NULL UNIQUE,\n    parent_workspace_key TEXT NOT NULL,\n    parent_do_id TEXT,\n    parent_generation INTEGER NOT NULL DEFAULT 0 CHECK (parent_generation >= 0),\n    region TEXT NOT NULL,\n    authority_mode TEXT NOT NULL CHECK (\n      authority_mode IN ('preparing', 'authoritative', 'quarantined')\n    ),\n    authority_generation INTEGER NOT NULL DEFAULT 0 CHECK (authority_generation >= 0),\n    title TEXT NOT NULL DEFAULT '',\n    description TEXT NOT NULL DEFAULT '',\n    preview TEXT NOT NULL DEFAULT '',\n    scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),\n    exact_state TEXT NOT NULL CHECK (exact_state IN (\n      'scheduled', 'running', 'interrupting', 'preparing_context', 'waiting_capacity',\n      'needs_input', 'completed', 'cancelled', 'failed', 'budget_exhausted',\n      'idle', 'archived', 'deleting', 'restoring'\n    )),\n    state_reason_code TEXT NOT NULL,\n    next_sequence_number INTEGER NOT NULL CHECK (next_sequence_number > 0),\n    next_attention_ordinal INTEGER NOT NULL CHECK (next_attention_ordinal > 0),\n    unread_tracking_start_ordinal INTEGER NOT NULL DEFAULT 0\n      CHECK (unread_tracking_start_ordinal >= 0),\n    authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),\n    scope_epoch INTEGER NOT NULL CHECK (scope_epoch >= 0),\n    source_authorization_floor INTEGER NOT NULL CHECK (source_authorization_floor >= 0),\n    listing_epoch INTEGER NOT NULL CHECK (listing_epoch >= 0),\n    deletion_epoch INTEGER NOT NULL CHECK (deletion_epoch >= 0),\n    run_revision INTEGER NOT NULL CHECK (run_revision >= 0),\n    created_at INTEGER NOT NULL,\n    last_people_activity_at INTEGER NOT NULL,\n    state_changed_at INTEGER NOT NULL,\n    completed_at INTEGER,\n    archived_at INTEGER,\n    origin_type TEXT NOT NULL DEFAULT 'ad_hoc',\n    created_by_user_id TEXT,\n    automation_subscription_id TEXT,\n    automation_run_id TEXT,\n    planned_for INTEGER,\n    email_address TEXT,\n    email_route_status TEXT NOT NULL DEFAULT 'pending',\n    created_from_opportunity_id TEXT,\n    opportunity_version INTEGER,\n    opportunity_display_prompt_hash TEXT,\n    opportunity_execution_prompt_hash TEXT,\n    description_source TEXT NOT NULL DEFAULT 'derived' CHECK (\n      description_source IN ('authored', 'derived')\n    ),\n    system_kind TEXT,\n    title_status TEXT NOT NULL DEFAULT 'settled' CHECK (\n      title_status IN ('naming', 'automatic', 'settled')\n    ),\n    model_override TEXT,\n    updated_at INTEGER NOT NULL\n  , parent_kind TEXT NOT NULL DEFAULT 'workstream'\n         CHECK (parent_kind IN ('workstream', 'automation')), appearance_json TEXT CHECK (appearance_json IS NULL OR json_valid(appearance_json))) STRICT",
  "INSERT INTO \"workstream\" SELECT * FROM \"_region_copy_workstream\"",
  "DROP TABLE \"_region_copy_workstream\"",
  "CREATE TRIGGER workstream_restricted_content_scope\n       BEFORE UPDATE OF scope ON workstream\n       WHEN OLD.scope = 'personal'\n        AND NEW.scope = 'workspace'\n        AND EXISTS (\n          SELECT 1 FROM content_audience_fences AS fence\n           WHERE COALESCE(json_extract(fence.audience_json, '$.scope'), '') != 'workspace'\n        )\n       BEGIN\n         SELECT RAISE(ABORT, 'workstream_audience_restricted_content');\n       END",
  "CREATE TRIGGER authorization_workstream_insert\n      AFTER INSERT ON workstream BEGIN\n        INSERT INTO authorization_projection_outbox(id, revision, not_before) VALUES (1, 1, 0)\n        ON CONFLICT(id) DO UPDATE SET revision = revision + 1;\n      END",
  "CREATE TRIGGER authorization_workstream_update\n      AFTER UPDATE OF scope ON workstream BEGIN\n        INSERT INTO authorization_projection_outbox(id, revision, not_before) VALUES (1, 1, 0)\n        ON CONFLICT(id) DO UPDATE SET revision = revision + 1;\n      END",
  "CREATE TRIGGER authorization_workstream_delete\n      AFTER DELETE ON workstream BEGIN\n        INSERT INTO authorization_projection_outbox(id, revision, not_before) VALUES (1, 1, 0)\n        ON CONFLICT(id) DO UPDATE SET revision = revision + 1;\n      END",
  "CREATE TRIGGER workstream_search_display_update\n    AFTER UPDATE OF title, archived_at ON workstream\n    WHEN NEW.title IS NOT OLD.title OR NEW.archived_at IS NOT OLD.archived_at\n    BEGIN\n      INSERT INTO durable_outbox\n        (message_id, channel, destination_kind, destination_id, partition_key,\n         source_version, source_epoch, contract_version, payload_json, payload_ref,\n         payload_hash, state, attempts, not_before, created_at, acked_at)\n      VALUES ('search-conversation', 'search_conversation_v1', 'queue', 'activity', 'search',\n        NEW.updated_at, 0, 1, json_object(), NULL, 'search-conversation', 'pending', 0, 0, NEW.updated_at, NULL)\n      ON CONFLICT(message_id) DO UPDATE SET source_version = excluded.source_version,\n        state = 'pending', not_before = 0;\n    END",
  "PRAGMA defer_foreign_keys = OFF"
] },
  {
    version: 56,
    description: "checkpoint transient inference delay with attempt settlement fences",
    statements: [
      `CREATE TABLE inference_delay_status (
        inference_request_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        execution_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        root_attempt_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1))
      ) STRICT`,
    ],
  },
  {
    version: 57,
    description: "separate provider observations from terminal retention intent",
    statements: [
      `CREATE TABLE terminal_provider_observation (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        sandbox_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        next_observe_at INTEGER NOT NULL,
        observed_at INTEGER,
        state TEXT,
        recoverable INTEGER CHECK (recoverable IN (0, 1)),
        error_code TEXT
      ) STRICT`,
    ],
  },
  {
    version: 58,
    description: "remove built-in meeting resource snapshots and attachments",
    statements: [
      `CREATE TABLE retired_meeting_attachment_ids (resource_id TEXT PRIMARY KEY) STRICT`,
      `INSERT INTO retired_meeting_attachment_ids(resource_id)
         SELECT resource_id FROM workstream_resource_links
         WHERE json_extract(resource_json, '$.provider') = 'avalon_note'`,
      `INSERT OR IGNORE INTO retired_meeting_attachment_ids(resource_id)
         SELECT resource_id FROM participant_transcript_attachments
         WHERE json_extract(attachment_json, '$.provider') = 'avalon_note'`,
      `DELETE FROM participant_transcript_attachments
         WHERE resource_id IN (SELECT resource_id FROM retired_meeting_attachment_ids)`,
      `DELETE FROM attachment_tool_receipts
         WHERE resource_id IN (SELECT resource_id FROM retired_meeting_attachment_ids)`,
      `DELETE FROM pending_attachment_reservation_recovery
         WHERE resource_id IN (SELECT resource_id FROM retired_meeting_attachment_ids)`,
      `DELETE FROM workstream_resource_links
         WHERE resource_id IN (SELECT resource_id FROM retired_meeting_attachment_ids)`,
      `UPDATE resource_inventory_revision SET revision = revision + 1
         WHERE EXISTS (SELECT 1 FROM retired_meeting_attachment_ids)`,
      `CREATE TRIGGER meeting_resource_links_retired BEFORE INSERT ON workstream_resource_links
         WHEN json_extract(NEW.resource_json, '$.provider') = 'avalon_note'
         BEGIN SELECT RAISE(ABORT, 'meeting_notes_retired'); END`,
      `CREATE TRIGGER meeting_resource_link_updates_retired BEFORE UPDATE ON workstream_resource_links
         WHEN json_extract(NEW.resource_json, '$.provider') = 'avalon_note'
         BEGIN SELECT RAISE(ABORT, 'meeting_notes_retired'); END`,
      `CREATE TRIGGER meeting_transcript_attachments_retired BEFORE INSERT ON participant_transcript_attachments
         WHEN json_extract(NEW.attachment_json, '$.provider') = 'avalon_note'
           OR NEW.resource_id IN (SELECT resource_id FROM retired_meeting_attachment_ids)
         BEGIN SELECT RAISE(ABORT, 'meeting_notes_retired'); END`,
      `CREATE TRIGGER meeting_transcript_attachment_updates_retired BEFORE UPDATE ON participant_transcript_attachments
         WHEN json_extract(NEW.attachment_json, '$.provider') = 'avalon_note'
           OR NEW.resource_id IN (SELECT resource_id FROM retired_meeting_attachment_ids)
         BEGIN SELECT RAISE(ABORT, 'meeting_notes_retired'); END`,

    ],
  },
  { version: 59, description: "receipt prepared conversation materialization", statements: [
    `CREATE TABLE prepared_conversation_receipts (
      operation_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL,
      first_turn_id TEXT NOT NULL, content_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('preparing', 'committed', 'failed')),
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE prepared_attachment_recovery (
      input_id TEXT NOT NULL CHECK(length(input_id) = 36),
      resource_id TEXT NOT NULL CHECK(length(resource_id) = 36),
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
      workstream_id TEXT NOT NULL CHECK(length(workstream_id) = 36),
      release_authority TEXT NOT NULL CHECK(release_authority IN ('preparation', 'projection')),
      created_at INTEGER NOT NULL,
      preparation_id TEXT REFERENCES prepared_conversation_receipts(operation_id),
      mailbox_input_id TEXT GENERATED ALWAYS AS (CASE WHEN preparation_id IS NULL THEN input_id ELSE NULL END) VIRTUAL
        REFERENCES pending_loop_input_mailbox(input_id) ON DELETE RESTRICT,
      PRIMARY KEY(input_id, resource_id)
    ) STRICT`,
    `INSERT INTO prepared_attachment_recovery(input_id, resource_id, workspace_id, workstream_id, release_authority, created_at)
      SELECT input_id, resource_id, workspace_id, workstream_id, release_authority, created_at FROM pending_attachment_reservation_recovery`,
    `DROP TABLE pending_attachment_reservation_recovery`,
    `ALTER TABLE prepared_attachment_recovery RENAME TO pending_attachment_reservation_recovery`,
    `CREATE INDEX pending_attachment_reservation_recovery_input_idx ON pending_attachment_reservation_recovery(input_id, resource_id)`,
  ] },
  {
    version: 60,
    description: "retain a background agent's inherited execution principal",
    statements: [`CREATE TABLE background_agent (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      execution_principal_json TEXT NOT NULL CHECK (json_valid(execution_principal_json)),
      stopped_at INTEGER
    ) STRICT`],
  },
  { version: 61, description: "receipt-owned friendly pagination continuations", statements: [TOOL_PAGE_SCHEMA, TOOL_PAGE_CONSUMER_INDEX] },
  {
    version: 62,
    description: "freeze legacy participant authority during a forward-only grant handoff",
    statements: PARTICIPANT_AUTHORITY_TRANSFER_SCHEMA,
  },
  {
    version: 63,
    description: "record which conversation a Terminal lease holder ran in",
    // NULL for a holder whose run row is in this object's own `runs` table,
    // which is every holder there was before conversations could share a
    // sandbox. Set only for a holder that ran in another conversation of the
    // same work stream — a background agent using its owner's sandbox — whose
    // liveness this object cannot read in its own transaction. The CHECK keeps
    // the column meaningless without a holder; the lease columns' own pairing
    // CHECK is in the promoted table and is not repeated here.
    statements: [
      `ALTER TABLE terminal_workspace ADD COLUMN operation_run_substream_id TEXT
         CHECK (operation_run_substream_id IS NULL OR operation_run_id IS NOT NULL)`,
    ],
  },
  {
    version: 64,
    description: "record which conversation's attachment authorized a Terminal import",
    // NULL for an import authorized by this object's own attachments, which is
    // every import there was before conversations could share a sandbox. Set
    // only for an import made by a run in another conversation of the same
    // work stream — a background agent importing what its own conversation has
    // attached into its owner's sandbox — so that the revocation check reads
    // each import's authorization from the conversation that gave it rather
    // than from whichever conversation happens to be acquiring.
    statements: [
      `ALTER TABLE terminal_imported_resources ADD COLUMN attached_substream_id TEXT`,
    ],
  },
  {
    version: 65,
    description: "let a run from another conversation record its Terminal command",
    // `terminal_tasks` referenced this object's `runs` and `tool_effects`, which
    // was right while every command came from a run of this conversation. A
    // background agent's run and its planning receipt live in the agent's own
    // object, so a command it ran through its owner's sandbox could record no
    // task at all. The rebuild drops those two keys and adds the holder's
    // conversation: `insertTask` checks the receipt itself for a run of this
    // object and takes the lease as the authority for a run from elsewhere.
    // Nothing references `terminal_tasks`, so the replacement is filled, the
    // old table dropped and the replacement renamed with enforcement on.
    statements: [
      `CREATE TABLE terminal_tasks_v65 (
        task_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        run_substream_id TEXT,
        effect_intent_id TEXT NOT NULL UNIQUE,
        sandbox_generation INTEGER NOT NULL CHECK (sandbox_generation >= 1),
        provider_task_name TEXT NOT NULL UNIQUE,
        provider_task_id TEXT,
        state TEXT NOT NULL CHECK (
          state IN ('planned', 'submitting', 'running', 'completed', 'failed', 'timed_out', 'cancelled')
        ),
        command_sha256 TEXT NOT NULL,
        command_deadline_at INTEGER NOT NULL,
        exit_code INTEGER,
        termination_reason TEXT CHECK (
          termination_reason IS NULL OR termination_reason IN (
            'exited', 'timed_out', 'cancelled', 'output_limit_exceeded'
          )
        ),
        stdout_head TEXT NOT NULL,
        stdout_tail TEXT NOT NULL,
        stderr_head TEXT NOT NULL,
        stderr_tail TEXT NOT NULL,
        stdout_bytes INTEGER NOT NULL CHECK (stdout_bytes >= 0),
        stderr_bytes INTEGER NOT NULL CHECK (stderr_bytes >= 0),
        output_resource_id TEXT,
        continuation_emitted_at INTEGER,
        started_at INTEGER,
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT`,
      `INSERT INTO terminal_tasks_v65
         (task_id, run_id, effect_intent_id, sandbox_generation, provider_task_name,
          provider_task_id, state, command_sha256, command_deadline_at, exit_code,
          termination_reason, stdout_head, stdout_tail, stderr_head, stderr_tail,
          stdout_bytes, stderr_bytes, output_resource_id, continuation_emitted_at,
          started_at, completed_at, created_at, updated_at)
       SELECT task_id, run_id, effect_intent_id, sandbox_generation, provider_task_name,
              provider_task_id, state, command_sha256, command_deadline_at, exit_code,
              termination_reason, stdout_head, stdout_tail, stderr_head, stderr_tail,
              stdout_bytes, stderr_bytes, output_resource_id, continuation_emitted_at,
              started_at, completed_at, created_at, updated_at
         FROM terminal_tasks`,
      `DROP TABLE terminal_tasks`,
      `ALTER TABLE terminal_tasks_v65 RENAME TO terminal_tasks`,
      `CREATE INDEX terminal_tasks_state_idx
         ON terminal_tasks(state, command_deadline_at, task_id)`,
    ],
  },
  {
    version: 66,
    description: "admit a Space as a conversation's parent kind",
    // A Space is a third kind of conversation parent, and its hidden main
    // conversation is an ordinary `SubstreamAgent` whose root row says so.
    // SQLite cannot widen a CHECK in place, so the singleton is rebuilt the way
    // version 55 rebuilt it. Version 55's literal is byte-frozen — it is hashed
    // into the `_sql_schema_migrations` receipt of every deployed conversation
    // — so this is a new copy of it with one constraint widened, not an edit.
    //
    // `DROP TABLE` takes a table's triggers with it, so the five that hang off
    // `workstream` are dropped explicitly first and recreated verbatim
    // afterwards: dropping them by name is what makes their absence between the
    // two statements deliberate rather than a side effect nobody stated. The
    // row is held in a scratch copy across the swap; nothing references
    // `workstream` by foreign key, so no dependent has to be emptied and the
    // rebuild runs with enforcement on.
    statements: [
      `CREATE TABLE "_parent_kind_copy_workstream" AS SELECT * FROM "workstream"`,
      `DROP TRIGGER "workstream_restricted_content_scope"`,
      `DROP TRIGGER "authorization_workstream_insert"`,
      `DROP TRIGGER "authorization_workstream_update"`,
      `DROP TRIGGER "authorization_workstream_delete"`,
      `DROP TRIGGER "workstream_search_display_update"`,
      `DROP TABLE "workstream"`,
      `CREATE TABLE workstream (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    workstream_key TEXT NOT NULL UNIQUE,
    parent_workspace_key TEXT NOT NULL,
    parent_do_id TEXT,
    parent_generation INTEGER NOT NULL DEFAULT 0 CHECK (parent_generation >= 0),
    region TEXT NOT NULL,
    authority_mode TEXT NOT NULL CHECK (
      authority_mode IN ('preparing', 'authoritative', 'quarantined')
    ),
    authority_generation INTEGER NOT NULL DEFAULT 0 CHECK (authority_generation >= 0),
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    preview TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
    exact_state TEXT NOT NULL CHECK (exact_state IN (
      'scheduled', 'running', 'interrupting', 'preparing_context', 'waiting_capacity',
      'needs_input', 'completed', 'cancelled', 'failed', 'budget_exhausted',
      'idle', 'archived', 'deleting', 'restoring'
    )),
    state_reason_code TEXT NOT NULL,
    next_sequence_number INTEGER NOT NULL CHECK (next_sequence_number > 0),
    next_attention_ordinal INTEGER NOT NULL CHECK (next_attention_ordinal > 0),
    unread_tracking_start_ordinal INTEGER NOT NULL DEFAULT 0
      CHECK (unread_tracking_start_ordinal >= 0),
    authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
    scope_epoch INTEGER NOT NULL CHECK (scope_epoch >= 0),
    source_authorization_floor INTEGER NOT NULL CHECK (source_authorization_floor >= 0),
    listing_epoch INTEGER NOT NULL CHECK (listing_epoch >= 0),
    deletion_epoch INTEGER NOT NULL CHECK (deletion_epoch >= 0),
    run_revision INTEGER NOT NULL CHECK (run_revision >= 0),
    created_at INTEGER NOT NULL,
    last_people_activity_at INTEGER NOT NULL,
    state_changed_at INTEGER NOT NULL,
    completed_at INTEGER,
    archived_at INTEGER,
    origin_type TEXT NOT NULL DEFAULT 'ad_hoc',
    created_by_user_id TEXT,
    automation_subscription_id TEXT,
    automation_run_id TEXT,
    planned_for INTEGER,
    email_address TEXT,
    email_route_status TEXT NOT NULL DEFAULT 'pending',
    created_from_opportunity_id TEXT,
    opportunity_version INTEGER,
    opportunity_display_prompt_hash TEXT,
    opportunity_execution_prompt_hash TEXT,
    description_source TEXT NOT NULL DEFAULT 'derived' CHECK (
      description_source IN ('authored', 'derived')
    ),
    system_kind TEXT,
    title_status TEXT NOT NULL DEFAULT 'settled' CHECK (
      title_status IN ('naming', 'automatic', 'settled')
    ),
    model_override TEXT,
    updated_at INTEGER NOT NULL
  , parent_kind TEXT NOT NULL DEFAULT 'workstream'
         CHECK (parent_kind IN ('workstream', 'automation', 'space')), appearance_json TEXT CHECK (appearance_json IS NULL OR json_valid(appearance_json))) STRICT`,
      `INSERT INTO "workstream" SELECT * FROM "_parent_kind_copy_workstream"`,
      `DROP TABLE "_parent_kind_copy_workstream"`,
      `CREATE TRIGGER workstream_restricted_content_scope
       BEFORE UPDATE OF scope ON workstream
       WHEN OLD.scope = 'personal'
        AND NEW.scope = 'workspace'
        AND EXISTS (
          SELECT 1 FROM content_audience_fences AS fence
           WHERE COALESCE(json_extract(fence.audience_json, '$.scope'), '') != 'workspace'
        )
       BEGIN
         SELECT RAISE(ABORT, 'workstream_audience_restricted_content');
       END`,
      `CREATE TRIGGER authorization_workstream_insert
      AFTER INSERT ON workstream BEGIN
        INSERT INTO authorization_projection_outbox(id, revision, not_before) VALUES (1, 1, 0)
        ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
      END`,
      `CREATE TRIGGER authorization_workstream_update
      AFTER UPDATE OF scope ON workstream BEGIN
        INSERT INTO authorization_projection_outbox(id, revision, not_before) VALUES (1, 1, 0)
        ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
      END`,
      `CREATE TRIGGER authorization_workstream_delete
      AFTER DELETE ON workstream BEGIN
        INSERT INTO authorization_projection_outbox(id, revision, not_before) VALUES (1, 1, 0)
        ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
      END`,
      `CREATE TRIGGER workstream_search_display_update
    AFTER UPDATE OF title, archived_at ON workstream
    WHEN NEW.title IS NOT OLD.title OR NEW.archived_at IS NOT OLD.archived_at
    BEGIN
      INSERT INTO durable_outbox
        (message_id, channel, destination_kind, destination_id, partition_key,
         source_version, source_epoch, contract_version, payload_json, payload_ref,
         payload_hash, state, attempts, not_before, created_at, acked_at)
      VALUES ('search-conversation', 'search_conversation_v1', 'queue', 'activity', 'search',
        NEW.updated_at, 0, 1, json_object(), NULL, 'search-conversation', 'pending', 0, 0, NEW.updated_at, NULL)
      ON CONFLICT(message_id) DO UPDATE SET source_version = excluded.source_version,
        state = 'pending', not_before = 0;
    END`,
    ],
  },
  {
    version: 67,
    description: "track imported source messages independently of Rally turns",
    statements: [
      `CREATE TABLE imported_session_sources (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        provider TEXT NOT NULL CHECK (provider IN ('chatgpt', 'claude', 'claude_code')),
        session_id TEXT NOT NULL,
        source_url TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE TABLE imported_session_messages (
        source_message_id TEXT PRIMARY KEY,
        source_revision TEXT NOT NULL,
        source_position INTEGER NOT NULL CHECK (source_position >= 0),
        latest_turn_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE TABLE imported_session_update_receipts (
        operation_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        added_count INTEGER NOT NULL CHECK (added_count >= 0),
        updated_count INTEGER NOT NULL CHECK (updated_count >= 0),
        missing_count INTEGER NOT NULL CHECK (missing_count >= 0),
        committed_at INTEGER NOT NULL
      ) STRICT`,
    ],
  },
  {
    version: 68,
    description: "pending loop inputs that land in send order without starting a run",
    statements: [
      // `1` for every row already queued: each was admitted to start a run.
      `ALTER TABLE pending_loop_inputs ADD COLUMN starts_run INTEGER NOT NULL DEFAULT 1
         CHECK (starts_run IN (0, 1))`,
      // Its own trigger, so v34's prepared-fields trigger stays as shipped.
      `CREATE TRIGGER pending_loop_inputs_starts_run_immutable
         BEFORE UPDATE OF starts_run ON pending_loop_inputs
         WHEN NEW.starts_run IS NOT OLD.starts_run
         BEGIN
           SELECT RAISE(ABORT, 'pending_loop_input_prepared_fields_are_immutable');
         END`,
    ],
  },
  {
    version: 69,
    description: "record which conversation a background agent works for",
    statements: [`ALTER TABLE background_agent ADD COLUMN root_substream_id TEXT`],
  },
  {
    version: 70,
    description: "requeue every committed turn so its search rows carry an audience",
    statements: CONVERSATION_SEARCH_AUDIENCE_MIGRATION_STATEMENTS,
  },
  {
    version: 71,
    description: "desktop actions a conversation's tools ask of a person's desktop, and the agent profile a conversation runs",
    statements: [
      `CREATE TABLE desktop_actions (
        action_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        action_json TEXT NOT NULL CHECK (json_valid(action_json)),
        status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'abandoned')),
        outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
        answered_by_user_id TEXT,
        created_at INTEGER NOT NULL,
        answered_at INTEGER,
        UNIQUE (run_id, tool_call_id),
        CHECK ((status = 'answered') = (outcome_json IS NOT NULL))
      ) STRICT`,
      // Only pending rows are read by status; every other read is by key.
      `CREATE INDEX desktop_actions_pending ON desktop_actions (created_at, action_id)
         WHERE status = 'pending'`,
      // Null is the ordinary conversation. A profile replaces the run's system
      // prompt, model role and tool surface; see `agent-profiles.ts`.
      `ALTER TABLE workstream ADD COLUMN agent_profile TEXT`,
    ],
  },
  {
    version: 72,
    description: "this conversation's copy of members' personal system prompts",
    statements: SUBSTREAM_PERSONAL_SYSTEM_PROMPT_MIGRATION,
  },
  {
    version: 73,
    description: "the Slack origins of steers a run absorbed",
    statements: [
      // A steer merges into the live run instead of starting its own, so its
      // Slack message has no run of its own to settle its status reaction.
      // The run that answered it does, from these rows. Written in the commit
      // that promotes the steer; `input_id` makes that write idempotent.
      `CREATE TABLE run_absorbed_slack_origins (
        input_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        slack_origin_json TEXT NOT NULL CHECK (json_valid(slack_origin_json)),
        created_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE INDEX run_absorbed_slack_origins_run ON run_absorbed_slack_origins (run_id)`,
    ],
  },
  {
    version: 74,
    description: "the newest Channel colour revision this conversation applied",
    statements: [
      // WorkspaceDO numbers every mark from one counter (channel-color-sync.ts);
      // `recolor` refuses a revision at or below this one, so a job that
      // stalled behind a newer one cannot write the old colour back.
      `ALTER TABLE workstream ADD COLUMN channel_color_revision INTEGER NOT NULL DEFAULT 0
         CHECK (channel_color_revision >= 0)`,
    ],
  },
  {
    version: 75,
    description: "conversation suggestions and the turn-disposition judgements behind them",
    statements: [
      // One row per judged turn that produced a suggestion: a quiet line under
      // the turn offering to carry its result up or to break a side question
      // out. Conversation state, not a transcript row, so a dismissal resolves
      // it in place and nothing accumulates. `judged_turn_sequence` is kept
      // beside the id so the newest-three expiry and the merge marker's
      // resolution compare integers rather than looking the turn up again.
      // `docs/conversation-suggestions.md` owns the lifecycle.
      `CREATE TABLE conversation_suggestions (
        suggestion_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('merge_up', 'start_breakout')),
        judged_turn_id TEXT NOT NULL,
        judged_turn_sequence INTEGER NOT NULL CHECK (judged_turn_sequence >= 0),
        run_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'dismissed', 'expired', 'withdrawn')),
        draft_status TEXT NOT NULL CHECK (draft_status IN ('pending', 'ready', 'failed')),
        draft_text TEXT,
        draft_subject TEXT,
        target_kind TEXT CHECK (target_kind IS NULL OR target_kind IN ('thread', 'channel')),
        target_id TEXT,
        target_title TEXT,
        decision_choice TEXT NOT NULL,
        decision_confidence REAL NOT NULL CHECK (decision_confidence >= 0 AND decision_confidence <= 1),
        decision_model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolved_by_user_id TEXT,
        resolution TEXT CHECK (resolution IS NULL OR resolution IN ('accepted', 'dismissed', 'ignored'))
      ) STRICT`,
      `CREATE UNIQUE INDEX conversation_suggestions_one_per_turn ON conversation_suggestions (judged_turn_id)`,
      `CREATE INDEX conversation_suggestions_pacing ON conversation_suggestions (kind, status, resolved_at)`,
      // Every decision the classifier made for a run, shown or not: what makes
      // a settlement retry idempotent on the run (gate 3) and what a later
      // calibration re-scores without calling the provider again.
      `CREATE TABLE turn_disposition_judgements (
        run_id TEXT PRIMARY KEY,
        judged_turn_id TEXT NOT NULL,
        code TEXT NOT NULL,
        choice TEXT,
        confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        carried_item_kind TEXT,
        model TEXT,
        failure_kind TEXT,
        suggestion_id TEXT,
        created_at INTEGER NOT NULL
      ) STRICT`,
    ],
  },
  {
    version: 76,
    description: "the memory sweep's cursor and cadence, and the retired admission-recall table dropped",
    statements: [
      // One row: how far the sweep has read this conversation, when it may
      // look again, and the claim in flight. The description refresh's shape
      // (`description_refresh_state`) for the same reason: a claim pushes
      // `rest_until` before the model call. `docs/agent-memory.md#the-sweep`.
      `CREATE TABLE memory_sweep_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        swept_through_seq INTEGER NOT NULL CHECK (swept_through_seq >= 0),
        rest_until INTEGER NOT NULL CHECK (rest_until >= 0),
        consecutive_quiet INTEGER NOT NULL CHECK (consecutive_quiet >= 0),
        claim_from_seq INTEGER CHECK (claim_from_seq IS NULL OR claim_from_seq >= 0),
        claim_to_seq INTEGER CHECK (claim_to_seq IS NULL OR claim_to_seq >= 0),
        claim_attempt INTEGER NOT NULL CHECK (claim_attempt >= 0),
        claim_at INTEGER CHECK (claim_at IS NULL OR claim_at >= 0),
        retry_at INTEGER CHECK (retry_at IS NULL OR retry_at >= 0),
        version INTEGER NOT NULL CHECK (version >= 1),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT`,
      // Admission recall froze its results here; nothing reads or writes the
      // table since the agent-memory redesign. `run_scopes.memory_context_hash`
      // stays, always NULL, because `run_scopes` is a referenced parent.
      `DROP TABLE run_memory_contexts`,
    ],
  },
  {
    version: 77,
    description: "the memory digest copies a run renders its remembered facts from",
    statements: [
      // One row per principal that has acted here (`user:<id>`,
      // `sidekick:<automationId>`, or `conversation`): the WorkspaceDO's
      // digest answer for that reader, as structured facts the run renders at
      // start, so inference reads nothing beyond this object. `read_at` is the
      // WorkspaceDO's clock at the read and orders overlapping refreshes.
      // `docs/agent-memory.md#the-digest`.
      `CREATE TABLE memory_digest_copies (
        principal TEXT PRIMARY KEY,
        facts_json TEXT NOT NULL,
        read_at INTEGER NOT NULL CHECK (read_at >= 0),
        refreshed_at INTEGER NOT NULL
      ) STRICT`,
    ],
  },
];

/**
 * Retires the elicitation view, which the scheduling slice could not.
 *
 * Its two writers were batches spanning the messages and identity slices — an
 * elicitation row, a transcript part, and the work stream's counters, written
 * together because each statement was guarded on the one before it having
 * landed. Both are single operations on `WorkstreamSchedulingStorage` now, so
 * the view has neither a reader nor a writer left.
 *
 * The view and its two triggers are objects over a table this schema already
 * declares, so nothing is adopted — the same shape and the same assertion as
 * the promotions below, for the same reason: a reshaped compat schema should
 * fail the build rather than produce a migration that quietly patches nothing.
 */
function elicitationAuthorityPromotion(): string[] {
  return compatObjectDrops(/^_runtime_elicitations/, 3, "elicitation");
}

/**
 * Retires the identity and participant views, and their four write triggers.
 *
 * The last two compatibility views. Production stopped naming `workstreams`
 * and `workstream_participants` with the identity slice; the fixtures that
 * still did now seed and read the object's own tables, which is what makes
 * this droppable at all.
 */
function identityAuthorityPromotion(): string[] {
  return compatObjectDrops(
    /^_runtime_workstreams$|^_runtime_workstreams_|^_runtime_workstream_participants/,
    7,
    "identity",
  );
}

/** Drops the frozen runtime views whose backing transcript tables retire in v32. */
function transcriptPayloadRetirementGuardDrops(): string[] {
  return [
    "transcript_payload_guard_receipt",
    "transcript_payload_guard_message_rows",
    "transcript_payload_guard_structured_content",
    "transcript_payload_guard_relations",
    "transcript_payload_guard_checkpoints",
  ].map((name) => `DROP TRIGGER ${name}`);
}

function transcriptPayloadRetirementGuards(): string[] {
  const abort = "SELECT RAISE(ABORT, 'transcript_payload_retirement_not_verified');";
  return [
    `CREATE TRIGGER transcript_payload_guard_receipt
       BEFORE INSERT ON transcript_payload_retirement_guard
       WHEN (
         (
           EXISTS (SELECT 1 FROM parts)
           OR EXISTS (SELECT 1 FROM part_attachments)
           OR EXISTS (SELECT 1 FROM part_mentions)
           OR EXISTS (SELECT 1 FROM compaction_checkpoints)
         ) AND NOT EXISTS (SELECT 1 FROM legacy_transcript_payload_transfers WHERE id = 1)
       ) OR (SELECT COUNT(*) FROM parts) != (SELECT COUNT(*) FROM workstream_message_records)
         OR (SELECT COUNT(*) FROM part_attachments) !=
            (SELECT COUNT(*) FROM workstream_message_attachments)
         OR (SELECT COUNT(*) FROM part_mentions) !=
            (SELECT COUNT(*) FROM workstream_message_mentions)
       BEGIN ${abort} END`,
    `CREATE TRIGGER transcript_payload_guard_message_rows
       BEFORE INSERT ON transcript_payload_retirement_guard
       WHEN EXISTS (
         SELECT 1 FROM parts part
         LEFT JOIN workstream_message_records record ON record.message_id = part.id
         LEFT JOIN transcript_facts fact ON fact.fact_id = record.fact_id
         LEFT JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
         WHERE record.message_id IS NULL
            OR record.substream_id IS NOT part.substream_id
            OR record.sequence_number IS NOT part.sequence_number
            OR record.attention_ordinal IS NOT part.attention_ordinal
            OR record.turn_id IS NOT part.turn_id
            OR record.turn_open_sequence IS NOT part.turn_open_sequence
            OR record.part_index IS NOT part.part_index
            OR record.role IS NOT part.role
            OR record.kind IS NOT part.kind
            OR record.author_type IS NOT part.author_type
            OR record.author_user_id IS NOT part.author_user_id
            OR record.external_actor_json IS NOT part.external_actor_json
            OR record.content_ref_id IS NOT part.content_ref_id
            OR record.content_bytes IS NOT part.content_bytes
            OR record.content_hash IS NOT part.content_hash
            OR record.answers_message_id IS NOT part.answers_part_id
            OR record.input_message_ids_json IS NOT part.input_part_ids_json
            OR record.client_message_id IS NOT part.client_message_id
            OR record.effect_intent_id IS NOT part.effect_intent_id
            OR record.occurrence_key IS NOT part.occurrence_key
            OR record.produced_by_run_id IS NOT part.produced_by_run_id
            OR record.attempt_epoch IS NOT part.attempt_epoch
            OR record.executor_event_seq IS NOT part.executor_event_seq
            OR record.model_turn_id IS NOT part.model_turn_id
            OR record.tool_position IS NOT part.tool_position
            OR record.delivery_intent IS NOT part.delivery_intent
            OR record.input_batch_id IS NOT part.input_batch_id
            OR record.admission_cut_seq IS NOT part.admission_cut_seq
            OR record.tool_name IS NOT part.tool_name
            OR record.tool_mode IS NOT part.tool_mode
            OR record.tool_status IS NOT part.tool_status
            OR record.compacts_through_sequence IS NOT part.compacts_through_sequence
            OR record.compacts_through_turn_id IS NOT part.compacts_through_turn_id
            OR record.projected_input_hash IS NOT part.projected_input_hash
            OR record.projection_key IS NOT part.projection_key
            OR record.authorization_revisions_json IS NOT part.authorization_revisions_json
            OR record.lineage_fences_json IS NOT part.lineage_fences_json
            OR record.terminal_reason IS NOT part.terminal_reason
            OR record.visibility IS NOT part.visibility
            OR record.pinned IS NOT part.pinned
            OR record.message_type IS NOT part.message_type
            OR record.edited_at IS NOT part.edited_at
            OR record.created_at IS NOT part.created_at
            OR record.updated_at IS NOT part.updated_at
            OR json_extract(payload.payload_json, '$.role') IS NOT part.role
            OR json_extract(payload.payload_json, '$.content') IS NOT COALESCE(part.content, '')
       ) BEGIN ${abort} END`,
    `CREATE TRIGGER transcript_payload_guard_structured_content
       BEFORE INSERT ON transcript_payload_retirement_guard
       WHEN EXISTS (
         SELECT part.id FROM parts part
         JOIN workstream_message_records record ON record.message_id = part.id
         JOIN transcript_facts fact ON fact.fact_id = record.fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
         WHERE (part.structured_content_json IS NOT NULL
                OR json_type(payload.payload_json, '$.structuredContent') IS NOT 'null')
           AND (EXISTS (
             SELECT fullkey, type, atom FROM json_tree(part.structured_content_json)
             EXCEPT
             SELECT fullkey, type, atom
               FROM json_tree(json_extract(payload.payload_json, '$.structuredContent'))
           ) OR EXISTS (
             SELECT fullkey, type, atom
               FROM json_tree(json_extract(payload.payload_json, '$.structuredContent'))
             EXCEPT
             SELECT fullkey, type, atom FROM json_tree(part.structured_content_json)
           ))
       ) BEGIN ${abort} END`,
    `CREATE TRIGGER transcript_payload_guard_relations
       BEFORE INSERT ON transcript_payload_retirement_guard
       WHEN EXISTS (
         SELECT part_id AS message_id, resource_id, position, attachment_json FROM part_attachments
         EXCEPT SELECT message_id, resource_id, position, attachment_json
                  FROM workstream_message_attachments
       ) OR EXISTS (
         SELECT message_id, resource_id, position, attachment_json
           FROM workstream_message_attachments
         EXCEPT SELECT part_id AS message_id, resource_id, position, attachment_json
                  FROM part_attachments
       ) OR EXISTS (
         SELECT part_id AS message_id, mention_index, mention_kind, target_user_id,
                connector_type, start_offset, end_offset, attention_ordinal FROM part_mentions
         EXCEPT SELECT message_id, mention_index, mention_kind, target_user_id,
                       connector_type, start_offset, end_offset, attention_ordinal
                  FROM workstream_message_mentions
       ) OR EXISTS (
         SELECT message_id, mention_index, mention_kind, target_user_id,
                connector_type, start_offset, end_offset, attention_ordinal
           FROM workstream_message_mentions
         EXCEPT SELECT part_id AS message_id, mention_index, mention_kind, target_user_id,
                       connector_type, start_offset, end_offset, attention_ordinal FROM part_mentions
       ) BEGIN ${abort} END`,
    `CREATE TRIGGER transcript_payload_guard_checkpoints
       BEFORE INSERT ON transcript_payload_retirement_guard
       WHEN EXISTS (
         SELECT 1 FROM compaction_checkpoints legacy
         LEFT JOIN transcript_compaction_checkpoints checkpoint
           ON checkpoint.execution_principal_key = legacy.execution_principal_key
          AND checkpoint.run_id = legacy.run_id
          AND checkpoint.compacted_through_sequence = legacy.compacted_through_sequence
         LEFT JOIN transcript_facts fact ON fact.fact_id = checkpoint.checkpoint_fact_id
         LEFT JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
         WHERE checkpoint.checkpoint_fact_id IS NULL
            OR json_extract(payload.payload_json, '$.summary') IS NOT legacy.summary
            OR EXISTS (
              SELECT fullkey, type, atom FROM json_tree(legacy.messages_json)
              EXCEPT SELECT fullkey, type, atom FROM json_tree(payload.payload_json, '$.messages')
            ) OR EXISTS (
              SELECT fullkey, type, atom FROM json_tree(payload.payload_json, '$.messages')
              EXCEPT SELECT fullkey, type, atom FROM json_tree(legacy.messages_json)
            )
       ) BEGIN ${abort} END`,
  ];
}

function transcriptCompatibilityRetirement(): string[] {
  return compatObjectDrops(
    /^_runtime_messages(?:$|_)|^_runtime_compactions(?:$|_)|^_runtime_message_(?:attachments|mentions)$/,
    6,
    "transcript retirement",
  );
}

/**
 * The drops that retire one family of compatibility objects.
 *
 * Every promotion in this file writes this out by hand: filter the compat
 * schema for the family's views and triggers, assert the expected count so a
 * reshaped schema fails the build rather than producing a migration that
 * quietly patches nothing, and drop the triggers first so none is left
 * orphaned in `sqlite_schema`.
 *
 * The two promotions this file gained last share it; the seven before them
 * were left alone. Three of those cannot use it — the terminal promotion drops
 * every trigger it finds rather than a named family, and the tool-receipt one
 * adopts tables as well as dropping objects — and rewriting the other four
 * would put a migration nobody is changing into the diff of a conversion
 * slice. The assertion is what matters and each of them already has it; this
 * is where a promotion should start, not a cleanup owed to the ones that
 * predate it.
 *
 * `WORKSTREAM_RUNTIME_COMPAT_SCHEMA` keeps declaring what these drop, and has
 * to: it is what migration 1 applies, so an object replaying from empty
 * creates each view before a later migration drops it. Deleting a retired
 * statement from that array rewrites history — and silently, because the
 * damage lands on the *next* migration that names the view.
 */
function compatObjectDrops(names: RegExp, expected: number, family: string): string[] {
  const compatObjects = WORKSTREAM_RUNTIME_COMPAT_SCHEMA.flatMap((statement) => {
    const trigger = /CREATE TRIGGER IF NOT EXISTS (\S+)/.exec(statement)?.[1];
    if (trigger) return names.test(trigger) ? [`DROP TRIGGER IF EXISTS ${trigger}`] : [];
    const view = /CREATE VIEW IF NOT EXISTS (\S+)/.exec(statement)?.[1];
    return view && names.test(view) ? [`DROP VIEW IF EXISTS ${view}`] : [];
  });
  if (compatObjects.length !== expected) {
    throw new Error(
      `expected ${expected} ${family} compat objects, found ${compatObjects.length}`,
    );
  }
  return [
    ...compatObjects.filter((statement) => statement.startsWith("DROP TRIGGER")),
    ...compatObjects.filter((statement) => statement.startsWith("DROP VIEW")),
  ];
}


/**
 * Retires the lifecycle-event view, which slice 6 could not.
 *
 * It survived that slice for one reason: the two functions that publish and
 * recover a run's final message joined it to `messages`, so it could not go
 * until the transcript write did. `publishHostOutcome` makes that one
 * transaction inside the object — the optional turns and their event — and
 * `loadPersistedHarnessHostOutcome` asks the authorities separately, so
 * the join and the view it needed are both gone.
 */
function runLifecycleAuthorityPromotion(): string[] {
  const names = /^_runtime_run_lifecycle_events/;
  const compatObjects = WORKSTREAM_RUNTIME_COMPAT_SCHEMA.flatMap((statement) => {
    const trigger = /CREATE TRIGGER IF NOT EXISTS (\S+)/.exec(statement)?.[1];
    if (trigger) return names.test(trigger) ? [`DROP TRIGGER IF EXISTS ${trigger}`] : [];
    const view = /CREATE VIEW IF NOT EXISTS (\S+)/.exec(statement)?.[1];
    return view && names.test(view) ? [`DROP VIEW IF EXISTS ${view}`] : [];
  });
  if (compatObjects.length !== 2) {
    throw new Error(`expected two lifecycle compat objects, found ${compatObjects.length}`);
  }
  return [
    ...compatObjects.filter((statement) => statement.startsWith("DROP TRIGGER")),
    ...compatObjects.filter((statement) => statement.startsWith("DROP VIEW")),
  ];
}

/**
 * Retires three of the harness-run slice's six compatibility views.
 *
 * Three, not six, and the three left behind are held by other slices rather
 * than by anything this authority still does:
 *
 * - `_runtime_harness_runs` is written by the *work-stream bootstrap* batch,
 *   which creates the work stream, its opening transcript row and its first run
 *   in one atomic routed statement set. Pulling the run out would introduce a
 *   partial failure that does not exist today — a work stream with no run — so
 *   it goes when the transcript does.
 * - `_runtime_run_lifecycle_events` is joined to `messages` by the two
 *   functions that verify a run's final message was published. Same slice, same
 *   reason.
 * - `_runtime_inference_attempts` is joined to `_runtime_harness_runs` by run
 *   telemetry, so it cannot outlive the view it joins.
 *
 * The three dropped here carry an insert trigger each and nothing else: a
 * scope, a plugin activation and a memory context are all written once and
 * never updated, which is why none of them ever needed one.
 */
function harnessRunAuthorityPromotion(): string[] {
  const names = /^_runtime_run_(?:scopes|plugin_activations|memory_contexts)/;
  const compatObjects = WORKSTREAM_RUNTIME_COMPAT_SCHEMA.flatMap((statement) => {
    const trigger = /CREATE TRIGGER IF NOT EXISTS (\S+)/.exec(statement)?.[1];
    if (trigger) return names.test(trigger) ? [`DROP TRIGGER IF EXISTS ${trigger}`] : [];
    const view = /CREATE VIEW IF NOT EXISTS (\S+)/.exec(statement)?.[1];
    return view && names.test(view) ? [`DROP VIEW IF EXISTS ${view}`] : [];
  });
  if (compatObjects.length !== 6) {
    throw new Error(`expected six harness-run compat objects, found ${compatObjects.length}`);
  }
  return [
    // Triggers first, so no trigger is left orphaned in `sqlite_schema`.
    ...compatObjects.filter((statement) => statement.startsWith("DROP TRIGGER")),
    ...compatObjects.filter((statement) => statement.startsWith("DROP VIEW")),
  ];
}

/**
 * Retires the resources slice's three compatibility objects.
 *
 * `_runtime_resources` is the interesting one, and it is why this slice is so
 * much smaller than its statement count suggested: it was never a view over a
 * table the object owns. It projected `workstream_resource_links.resource_json`
 * — the *frozen copy* the object keeps of a workspace resource — as though it
 * were the workspace's live `resources` row, so that a single routed statement
 * could join the two authorities. Nothing reads it any more; each caller asks
 * the authority that owns the half it needs.
 *
 * Five objects, not three: `_runtime_workstream_resources` carries an update
 * and a delete trigger. It never carried an *insert* one — attaching has gone
 * through the product service since before this slice — which is the clearest
 * evidence that the link table was already the object's in everything but the
 * reads.
 *
 * Asserted for the reason migrations 17-19 assert theirs: a reshaped compat
 * schema should fail the build rather than produce a migration that quietly
 * patches nothing.
 */
function resourceAuthorityPromotion(): string[] {
  // Five objects: three views, plus the update and delete triggers that only
  // `_runtime_workstream_resources` carried.
  const names = /^_runtime_(?:workstream_resources|resources|resource_revisions)/;
  const compatObjects = WORKSTREAM_RUNTIME_COMPAT_SCHEMA.flatMap((statement) => {
    const trigger = /CREATE TRIGGER IF NOT EXISTS (\S+)/.exec(statement)?.[1];
    if (trigger) return names.test(trigger) ? [`DROP TRIGGER IF EXISTS ${trigger}`] : [];
    const view = /CREATE VIEW IF NOT EXISTS (\S+)/.exec(statement)?.[1];
    return view && names.test(view) ? [`DROP VIEW IF EXISTS ${view}`] : [];
  });
  if (compatObjects.length !== 5) {
    throw new Error(`expected five resource compat objects, found ${compatObjects.length}`);
  }
  return [
    // Triggers first, so no trigger is left orphaned in `sqlite_schema`.
    ...compatObjects.filter((statement) => statement.startsWith("DROP TRIGGER")),
    ...compatObjects.filter((statement) => statement.startsWith("DROP VIEW")),
  ];
}

/**
 * Retires four of the scheduling slice's five compatibility views.
 *
 * `_runtime_elicitations` was deliberately not among them, and its two triggers
 * stayed with it: every *read* of that view was gone, but its two writers were
 * batches spanning the messages and identity slices — an elicitation row, a
 * transcript message, and the work stream's counters, written together because
 * the second statement was guarded on the first having landed. Dropping it here
 * would have left those batches with nothing to write through. Migration 25
 * retires it, once both writers became single object operations.
 *
 * The other four views and their seven triggers are objects over tables this
 * schema already declares, so nothing is adopted — the same shape as the
 * block-dashboard promotion, and the same assertion, for the same reason
 * migration 17 asserts its own: a reshaped compat schema should fail the build
 * rather than produce a migration that quietly patches nothing.
 */
function schedulingAuthorityPromotion(): string[] {
  const names = /^_runtime_(?:wakeups|compactions|description_refreshes|plugin_hints)/;
  const compatObjects = WORKSTREAM_RUNTIME_COMPAT_SCHEMA.flatMap((statement) => {
    const trigger = /CREATE TRIGGER IF NOT EXISTS (\S+)/.exec(statement)?.[1];
    if (trigger) return names.test(trigger) ? [`DROP TRIGGER IF EXISTS ${trigger}`] : [];
    const view = /CREATE VIEW IF NOT EXISTS (\S+)/.exec(statement)?.[1];
    return view && names.test(view) ? [`DROP VIEW IF EXISTS ${view}`] : [];
  });
  if (compatObjects.length !== 11) {
    throw new Error(`expected eleven scheduling compat objects, found ${compatObjects.length}`);
  }
  // A name is enough even where the object's body is not the file's:
  // `_runtime_description_refreshes_insert` was rebuilt by a later migration
  // and carries a patched body, but it is the same trigger, and `DROP` names
  // it rather than matching it.
  return [
    // Triggers first, for the reason the block-dashboard promotion gives.
    ...compatObjects.filter((statement) => statement.startsWith("DROP TRIGGER")),
    ...compatObjects.filter((statement) => statement.startsWith("DROP VIEW")),
  ];
}

/**
 * An accepted suggestion becomes durable work-stream content. Keep its source
 * audience as a lifetime containment fence even when a compatibility writer
 * bypasses WorkstreamObjectProductService (connector identity reconciliation
 * is the important case). The product service performs the same check before
 * mutation so HTTP callers receive a structured conflict; these triggers are
 * the storage-authority backstop for every writer.
 */
function acceptedSuggestionAudienceTriggers(): string[] {
  const userIsAllowed = `(
    COALESCE(json_extract(accepted.share_intent_json, '$.sourceAudience.scope'), '') = 'workspace'
    OR (
      COALESCE(json_extract(accepted.share_intent_json, '$.sourceAudience.scope'), '') = 'users'
      AND COALESCE(json_type(accepted.share_intent_json, '$.sourceAudience.userIds'), '') = 'array'
      AND EXISTS (
        SELECT 1
          FROM json_each(json_extract(
            accepted.share_intent_json,
            '$.sourceAudience.userIds'
          )) AS audience_user
         WHERE audience_user.value = NEW.user_id
      )
    )
  )`;
  const wouldExposeAcceptedContent = `EXISTS (
    SELECT 1
      FROM suggested_actions AS accepted
     WHERE accepted.status = 'accepted'
       AND NOT ${userIsAllowed}
  )`;

  return [
    `CREATE TRIGGER IF NOT EXISTS accepted_suggestion_source_audience_immutable
       BEFORE UPDATE OF share_intent_json ON suggested_actions
       WHEN OLD.status = 'accepted'
        AND NEW.share_intent_json IS NOT OLD.share_intent_json
       BEGIN
         SELECT RAISE(ABORT, 'accepted_suggestion_source_audience_immutable');
       END`,
    `CREATE TRIGGER IF NOT EXISTS accepted_suggestion_source_audience_retained
       BEFORE DELETE ON suggested_actions
       WHEN OLD.status = 'accepted'
       BEGIN
         SELECT RAISE(ABORT, 'accepted_suggestion_source_audience_immutable');
       END`,
    `CREATE TRIGGER IF NOT EXISTS participants_restricted_content_insert
       BEFORE INSERT ON participants
       WHEN NEW.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM participants AS current
           WHERE current.user_id = NEW.user_id AND current.status = 'active'
        )
        AND ${wouldExposeAcceptedContent}
       BEGIN
         SELECT RAISE(ABORT, 'workstream_audience_restricted_content');
       END`,
    `CREATE TRIGGER IF NOT EXISTS participants_restricted_content_reactivate
       BEFORE UPDATE OF status ON participants
       WHEN OLD.status != 'active'
        AND NEW.status = 'active'
        AND ${wouldExposeAcceptedContent}
       BEGIN
         SELECT RAISE(ABORT, 'workstream_audience_restricted_content');
       END`,
    `CREATE TRIGGER IF NOT EXISTS workstream_restricted_content_scope
       BEFORE UPDATE OF scope ON workstream
       WHEN OLD.scope = 'personal'
        AND NEW.scope = 'workspace'
        AND EXISTS (
          SELECT 1
            FROM suggested_actions AS accepted
           WHERE accepted.status = 'accepted'
             AND COALESCE(
               json_extract(accepted.share_intent_json, '$.sourceAudience.scope'),
               ''
             ) != 'workspace'
        )
       BEGIN
         SELECT RAISE(ABORT, 'workstream_audience_restricted_content');
       END`,
  ];
}

/**
 * The retired feature's accepted resources are ordinary attachments now, but
 * ordinary does not mean public. These generic fences preserve only the source
 * audience needed to stop a future participant or scope change widening that
 * content. No suggestion action, status, feedback, or display state survives.
 */
function retainedContentAudienceTriggers(): string[] {
  const userIsAllowed = `(
    COALESCE(json_extract(fence.audience_json, '$.scope'), '') = 'workspace'
    OR (
      COALESCE(json_extract(fence.audience_json, '$.scope'), '') = 'users'
      AND COALESCE(json_type(fence.audience_json, '$.userIds'), '') = 'array'
      AND EXISTS (
        SELECT 1
          FROM json_each(json_extract(fence.audience_json, '$.userIds')) AS audience_user
         WHERE audience_user.value = NEW.user_id
      )
    )
  )`;
  const wouldExposeRetainedContent = `EXISTS (
    SELECT 1 FROM content_audience_fences AS fence WHERE NOT ${userIsAllowed}
  )`;

  return [
    `CREATE TRIGGER content_audience_fences_immutable_update
       BEFORE UPDATE ON content_audience_fences
       BEGIN
         SELECT RAISE(ABORT, 'content_audience_fence_immutable');
       END`,
    `CREATE TRIGGER content_audience_fences_immutable_delete
       BEFORE DELETE ON content_audience_fences
       BEGIN
         SELECT RAISE(ABORT, 'content_audience_fence_immutable');
       END`,
    `CREATE TRIGGER participants_restricted_content_insert
       BEFORE INSERT ON participants
       WHEN NEW.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM participants AS current
           WHERE current.user_id = NEW.user_id AND current.status = 'active'
        )
        AND ${wouldExposeRetainedContent}
       BEGIN
         SELECT RAISE(ABORT, 'workstream_audience_restricted_content');
       END`,
    `CREATE TRIGGER participants_restricted_content_reactivate
       BEFORE UPDATE OF status ON participants
       WHEN OLD.status != 'active'
        AND NEW.status = 'active'
        AND ${wouldExposeRetainedContent}
       BEGIN
         SELECT RAISE(ABORT, 'workstream_audience_restricted_content');
       END`,
    `CREATE TRIGGER workstream_restricted_content_scope
       BEFORE UPDATE OF scope ON workstream
       WHEN OLD.scope = 'personal'
        AND NEW.scope = 'workspace'
        AND EXISTS (
          SELECT 1 FROM content_audience_fences AS fence
           WHERE COALESCE(json_extract(fence.audience_json, '$.scope'), '') != 'workspace'
        )
       BEGIN
         SELECT RAISE(ABORT, 'workstream_audience_restricted_content');
       END`,
  ];
}

/**
 * Retires the three `_runtime_block_dashboard_*` views and their triggers.
 *
 * Nothing is adopted, unlike the receipt promotion: every object the compat
 * schema creates for the block dashboard is a view or a trigger over tables the
 * object's own schema already declares. That is worth stating rather than
 * assuming — the receipt slice found a real `STRICT` table and a load-bearing
 * unique index hiding in that file, and the rule it left behind is to derive a
 * drop set from what each object *is*, never from the file it lives in. These
 * three are views, and the four are their triggers.
 *
 * The count is asserted for the reason migration 17 asserts its own: a reshaped
 * compat schema should fail the build rather than produce a migration that
 * quietly patches nothing.
 */
function blockDashboardAuthorityPromotion(): string[] {
  const names = /^_runtime_block_dashboard_/;
  const compatObjects = WORKSTREAM_RUNTIME_COMPAT_SCHEMA.flatMap((statement) => {
    const trigger = /CREATE TRIGGER IF NOT EXISTS (\S+)/.exec(statement)?.[1];
    if (trigger) return names.test(trigger) ? [`DROP TRIGGER IF EXISTS ${trigger}`] : [];
    const view = /CREATE VIEW IF NOT EXISTS (\S+)/.exec(statement)?.[1];
    return view && names.test(view) ? [`DROP VIEW IF EXISTS ${view}`] : [];
  });
  if (compatObjects.length !== 7) {
    throw new Error(`expected seven block-dashboard compat objects, found ${compatObjects.length}`);
  }
  // Triggers first: dropping a view out from under its own INSTEAD OF trigger
  // is legal but leaves the trigger orphaned in `sqlite_schema`.
  return [
    ...compatObjects.filter((statement) => statement.startsWith("DROP TRIGGER")),
    ...compatObjects.filter((statement) => statement.startsWith("DROP VIEW")),
  ];
}

/**
 * Promotes the Terminal lifecycle out of a JSON blob and retires the
 * compatibility views that put it there.
 *
 * `terminal_workspace` carried nine lifecycle fields inside `lifecycle_json`
 * for one reason: the Terminal services addressed this object through
 * `_runtime_terminal_workspace`, a view whose INSTEAD OF triggers packed D1's
 * flat columns into JSON on write and unpacked them on read. So
 * `archive_due_at` — a deadline the workspace scheduler sorts alarms by — had
 * no type, no CHECK, and no index, because it was a JSON key. The services now
 * hold a typed port onto the real tables, and the blob has no remaining reason
 * to exist.
 *
 * The table is rebuilt rather than extended with `ALTER TABLE ADD COLUMN`:
 * SQLite cannot add a CHECK constraint to an existing table, and a shape whose
 * lifecycle states are constrained in one place and its claim invariants in
 * none would be a worse schema than the blob it replaces. The table is a
 * singleton, so the rebuild copies at most one row.
 *
 * `authority_epoch` does not survive the rebuild. The compatibility triggers
 * set it equal to `version` on every write and nothing ever read it back, so
 * it was a second name for one number.
 *
 * Views and triggers are dropped before the rebuild. SQLite does not validate
 * a view body until the view is used, so a `DROP TABLE` under a live view
 * would succeed and leave a view that fails on next read; dropping first keeps
 * every intermediate state of this transaction selectable.
 */
function terminalAuthorityPromotion(): string[] {
  const compatObjects = WORKSTREAM_RUNTIME_COMPAT_SCHEMA.flatMap((statement) => {
    const trigger = /CREATE TRIGGER IF NOT EXISTS (_runtime_(?:terminal_|repository_publications)\S*)/
      .exec(statement)?.[1];
    if (trigger) return [`DROP TRIGGER IF EXISTS ${trigger}`];
    const view = /CREATE VIEW IF NOT EXISTS (_runtime_(?:terminal_|repository_publications)\S*)/
      .exec(statement)?.[1];
    return view ? [`DROP VIEW IF EXISTS ${view}`] : [];
  });
  if (compatObjects.length === 0) throw new Error("terminal compat statements not found");
  // Triggers first: dropping a view out from under its own INSTEAD OF trigger
  // is legal but leaves the trigger orphaned in `sqlite_schema`.
  const drops = [
    ...compatObjects.filter((statement) => statement.startsWith("DROP TRIGGER")),
    ...compatObjects.filter((statement) => statement.startsWith("DROP VIEW")),
  ];

  const isoToEpochMs = (path: string) =>
    `CASE WHEN json_extract(lifecycle_json, '${path}') IS NULL THEN NULL
       ELSE CAST((julianday(json_extract(lifecycle_json, '${path}')) - 2440587.5)
              * 86400000 + 0.5 AS INTEGER) END`;

  return [
    ...drops,
    `CREATE TABLE terminal_workspace_promoted (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      provider TEXT NOT NULL CHECK (provider = 'daytona'),
      sandbox_id TEXT,
      lifecycle_state TEXT NOT NULL CHECK (
        lifecycle_state IN (
          'absent', 'starting', 'running', 'stopping', 'stopped', 'archiving',
          'archived', 'restoring', 'expiring', 'expired', 'failed'
        )
      ),
      generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
      stable_name TEXT,
      authority_fingerprint TEXT NOT NULL DEFAULT '',
      applied_network_revision INTEGER NOT NULL DEFAULT 0
        CHECK (applied_network_revision >= 0),
      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
      operation_run_id TEXT,
      operation_lease_expires_at INTEGER,
      lifecycle_claim_id TEXT,
      lifecycle_claim_expires_at INTEGER,
      last_command_at INTEGER,
      idle_expires_at INTEGER,
      archive_due_at INTEGER,
      expire_due_at INTEGER,
      final_diff_resource_id TEXT,
      failure_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (lifecycle_state != 'absent' OR sandbox_id IS NULL),
      -- A lease or claim without its deadline is unreleasable: nothing can
      -- decide it has expired, so the workspace stays held forever. The blob
      -- could not say this; the table can.
      -- The copy above drops both halves together when either is missing: the
      -- CHECK is enforced on INSERT, so a repair afterwards would never run.
      CHECK ((operation_run_id IS NULL) = (operation_lease_expires_at IS NULL)),
      CHECK ((lifecycle_claim_id IS NULL) = (lifecycle_claim_expires_at IS NULL))
    ) STRICT`,
    `INSERT INTO terminal_workspace_promoted
       (id, provider, sandbox_id, lifecycle_state, generation, stable_name,
        authority_fingerprint, applied_network_revision, version,
        operation_run_id, operation_lease_expires_at, lifecycle_claim_id,
        lifecycle_claim_expires_at, last_command_at, idle_expires_at,
        archive_due_at, expire_due_at, final_diff_resource_id, failure_code,
        created_at, updated_at)
     SELECT id, provider, sandbox_id, lifecycle_state, generation, stable_name,
        COALESCE(json_extract(lifecycle_json, '$.authorityFingerprint'), ''),
        applied_network_revision, version,
        CASE WHEN ${isoToEpochMs("$.operationLeaseExpiresAt")} IS NULL THEN NULL
          ELSE json_extract(lifecycle_json, '$.operationRunId') END,
        CASE WHEN json_extract(lifecycle_json, '$.operationRunId') IS NULL THEN NULL
          ELSE ${isoToEpochMs("$.operationLeaseExpiresAt")} END,
        CASE WHEN ${isoToEpochMs("$.lifecycleClaimExpiresAt")} IS NULL THEN NULL
          ELSE json_extract(lifecycle_json, '$.lifecycleClaimId') END,
        CASE WHEN json_extract(lifecycle_json, '$.lifecycleClaimId') IS NULL THEN NULL
          ELSE ${isoToEpochMs("$.lifecycleClaimExpiresAt")} END,
        last_command_at, idle_expires_at,
        ${isoToEpochMs("$.archiveDueAt")},
        ${isoToEpochMs("$.expireDueAt")},
        json_extract(lifecycle_json, '$.finalDiffResourceId'),
        json_extract(lifecycle_json, '$.failureCode'),
        created_at, updated_at
       FROM terminal_workspace`,
    `DROP TABLE terminal_workspace`,
    `ALTER TABLE terminal_workspace_promoted RENAME TO terminal_workspace`,
  ];
}

/**
 * Rebuilds the workstreams compatibility view and its write triggers so the
 * generic runtime's D1-compatible `idle` settlement retains a DO cancellation.
 * D1's retired harness-status CHECK cannot accept `stopped`, so the shared
 * runtime must continue writing `idle`; inside the object the already-updated
 * latest run is authoritative evidence that this particular idle transition
 * means a user stop.
 */
function rebuiltWorkstreamsStoppedProjection(): string[] {
  const view = WORKSTREAM_RUNTIME_COMPAT_SCHEMA.find((statement) =>
    statement.includes("CREATE VIEW IF NOT EXISTS _runtime_workstreams AS"));
  const insert = WORKSTREAM_RUNTIME_COMPAT_SCHEMA.find((statement) =>
    statement.includes("CREATE TRIGGER IF NOT EXISTS _runtime_workstreams_insert"));
  const update = WORKSTREAM_RUNTIME_COMPAT_SCHEMA.find((statement) =>
    statement.includes("CREATE TRIGGER IF NOT EXISTS _runtime_workstreams_update"));
  if (!view || !insert || !update) throw new Error("workstreams compat statements not found");

  const stateAnchor = `              WHEN exact_state IN ('failed', 'budget_exhausted') THEN 'failed'
              ELSE 'idle'`;
  if (!view.includes(stateAnchor)) throw new Error("workstreams view state projection changed");
  const rebuiltView = view.replace(stateAnchor, `              WHEN exact_state IN ('failed', 'budget_exhausted') THEN 'failed'
              WHEN exact_state = 'cancelled' THEN 'stopped'
              ELSE 'idle'`);

  const writeAnchor = `            WHEN 'completed' THEN 'completed'
            WHEN 'failed' THEN 'failed'
            ELSE 'idle' END,`;
  if (!insert.includes(writeAnchor)) throw new Error("workstreams insert state projection changed");
  const rebuiltInsert = insert.replace(writeAnchor, `            WHEN 'completed' THEN 'completed'
            WHEN 'failed' THEN 'failed'
            WHEN 'stopped' THEN 'cancelled'
            ELSE 'idle' END,`)
    .replaceAll("* 86400000 AS INTEGER", "* 86400000 + 0.5 AS INTEGER");

  const updateAnchor = `                  WHEN 'completed' THEN 'completed'
                  WHEN 'failed' THEN 'failed'
                  ELSE 'idle' END END,`;
  if (!update.includes(updateAnchor)) throw new Error("workstreams update state projection changed");
  const rebuiltUpdate = update.replace(updateAnchor, `                  WHEN 'completed' THEN 'completed'
                  WHEN 'failed' THEN 'failed'
                  WHEN 'stopped' THEN 'cancelled'
                  WHEN 'idle' THEN CASE WHEN (
                    SELECT status FROM runs
                     WHERE parent_run_id IS NULL AND origin != 'block_dashboard_block'
                     ORDER BY created_at DESC, run_id DESC LIMIT 1
                  ) = 'cancelled' THEN 'cancelled' ELSE 'idle' END
                  ELSE 'idle' END END,`)
    .replaceAll("* 86400000 AS INTEGER", "* 86400000 + 0.5 AS INTEGER");

  return [
    "DROP TRIGGER IF EXISTS _runtime_workstreams_insert",
    "DROP TRIGGER IF EXISTS _runtime_workstreams_update",
    "DROP VIEW IF EXISTS _runtime_workstreams",
    rebuiltView,
    rebuiltInsert,
    rebuiltUpdate,
  ];
}

/**
 * Rebuilds `_runtime_description_refreshes_insert` so a claim does not zero
 * the keep ratchet.
 *
 * The claim INSERT names no `consecutive_keeps`; the trigger coalesced the
 * absent value to 0 and its conflict arm then wrote that 0 over the standing
 * count, so keeps could never exceed one and the 24/48-hour rest tiers were
 * unreachable. The legacy D1 claim upsert never touched the column — this
 * restores that contract: an incoming NULL preserves the standing value, an
 * explicit value (the settle path's report) lands as written.
 *
 * Derived from the frozen v1 body with v3's rounding applied, so the versions
 * cannot drift.
 */
function rebuiltDescriptionRefreshInsertTrigger(): string[] {
  const source = WORKSTREAM_RUNTIME_COMPAT_SCHEMA.find((statement) =>
    statement.includes("CREATE TRIGGER IF NOT EXISTS _runtime_description_refreshes_insert"));
  if (!source) throw new Error("description refresh insert trigger not found in compat schema");
  const rounded = source.replaceAll("* 86400000 AS INTEGER", "* 86400000 + 0.5 AS INTEGER");
  const anchor = `          consecutive_keeps = CASE WHEN excluded.decision = 'authored'
            THEN description_refresh_state.consecutive_keeps ELSE excluded.consecutive_keeps END,`;
  if (!rounded.includes(anchor)) throw new Error("description refresh trigger shape changed");
  const patched = rounded.replace(anchor, `          consecutive_keeps = CASE
            WHEN excluded.decision = 'authored' OR NEW.consecutive_keeps IS NULL
            THEN description_refresh_state.consecutive_keeps
            ELSE excluded.consecutive_keeps END,`);
  return ["DROP TRIGGER IF EXISTS _runtime_description_refreshes_insert", patched];
}

/**
 * Rebuilds `_runtime_messages_insert` so a replayed durable write is absorbed.
 *
 * SQLite ignores an `ON CONFLICT` clause on an INSERT against a view: conflict
 * handling is the INSTEAD OF trigger's job. The harness's durable writers rely
 * on `ON CONFLICT(workstream_id, client_message_id) DO NOTHING` for replay
 * safety — a retried attempt writes its final message again under the same
 * `harness:<runId>` client id with a fresh message id — and against the object
 * that clause was silently dropped, so the trigger's bare INSERT hit
 * `parts_client_message_uq` and crashed the run's settlement instead of
 * deduplicating it. The trigger now carries a second upsert arm: same id and
 * tool-typed updates in place when no client-id conflict selects the first
 * arm, while the same client id from a different message id is a replay and
 * is ignored. Schema v11 repairs the same-id plus same-client-id case that
 * SQLite resolves through this first arm.
 *
 * Derived from the frozen v1 body with the v3 rounding applied, so the three
 * versions cannot drift apart.
 */
function rebuiltMessagesInsertTrigger(): string[] {
  const source = WORKSTREAM_RUNTIME_COMPAT_SCHEMA.find((statement) =>
    statement.includes("CREATE TRIGGER IF NOT EXISTS _runtime_messages_insert"));
  if (!source) throw new Error("messages insert trigger not found in compat schema");
  const rounded = source.replaceAll("* 86400000 AS INTEGER", "* 86400000 + 0.5 AS INTEGER");
  const anchor = `       ON CONFLICT(id) DO UPDATE SET
         structured_content_json = excluded.structured_content_json,
         tool_status = excluded.tool_status,
         edited_at = excluded.edited_at,
         updated_at = excluded.updated_at
       WHERE parts.message_type = 'tool';`;
  if (!rounded.includes(anchor)) throw new Error("messages insert trigger shape changed");
  const patched = rounded.replace(anchor, `       ON CONFLICT(client_message_id) WHERE client_message_id IS NOT NULL
         DO NOTHING
       ON CONFLICT(id) DO UPDATE SET
         structured_content_json = excluded.structured_content_json,
         tool_status = excluded.tool_status,
         edited_at = excluded.edited_at,
         updated_at = excluded.updated_at
       WHERE parts.message_type = 'tool';`);
  return ["DROP TRIGGER IF EXISTS _runtime_messages_insert", patched];
}

/**
 * Rebuilds `_runtime_messages_insert` so one tool row can move from started to
 * its terminal state when both durable identifiers stay the same.
 *
 * The v5 trigger put `client_message_id DO NOTHING` before its `id DO UPDATE`
 * arm. Tool lifecycle writes conflict on both columns, and SQLite chooses the
 * first matching arm, so the terminal write was discarded permanently. The
 * first arm now updates only when it names the same tool row; a different id
 * under the same client id remains a replay and still changes nothing. This is
 * a new migration rather than an edit to v5 because deployed schema hashes are
 * immutable.
 */
function rebuiltMessagesInsertTriggerForToolSettlement(): string[] {
  const source = rebuiltMessagesInsertTrigger()[1];
  if (!source) throw new Error("rebuilt messages insert trigger not found");
  const anchor = `       ON CONFLICT(client_message_id) WHERE client_message_id IS NOT NULL
         DO NOTHING
       ON CONFLICT(id) DO UPDATE SET`;
  if (!source.includes(anchor)) throw new Error("messages replay conflict arm changed");
  const patched = source.replace(anchor, `       ON CONFLICT(client_message_id) WHERE client_message_id IS NOT NULL
         DO UPDATE SET
           structured_content_json = excluded.structured_content_json,
           tool_status = excluded.tool_status,
           edited_at = excluded.edited_at,
           updated_at = excluded.updated_at
         WHERE parts.id = excluded.id AND parts.message_type = 'tool'
       ON CONFLICT(id) DO UPDATE SET`);
  return ["DROP TRIGGER IF EXISTS _runtime_messages_insert", patched];
}

/**
 * Repairs terminal tool effects whose transcript completion was discarded by
 * v5 before v11 could correct the trigger. The effect receipt is the durable
 * execution authority and carries the same invocation id, terminal status,
 * member-safe summary/error, and settlement time needed by the transcript.
 */
function repairStrandedToolTranscriptParts(): string[] {
  return [
    `UPDATE parts SET
       structured_content_json = json_set(
         parts.structured_content_json,
         '$.invocation.status', (
           SELECT effect.status FROM tool_effects effect
            WHERE effect.effect_intent_id = parts.id
         ),
         '$.invocation.activityName', json('null'),
         '$.invocation.outputSummary', (
           SELECT effect.output_summary FROM tool_effects effect
            WHERE effect.effect_intent_id = parts.id
         ),
         '$.invocation.completedAt', (
           SELECT CASE WHEN effect.settled_at IS NULL THEN NULL
             ELSE strftime('%Y-%m-%dT%H:%M:%fZ', effect.settled_at / 1000.0, 'unixepoch') END
             FROM tool_effects effect WHERE effect.effect_intent_id = parts.id
         ),
         '$.invocation.error', json(COALESCE((
           SELECT effect.error_json FROM tool_effects effect
            WHERE effect.effect_intent_id = parts.id
         ), 'null'))
       ),
       tool_status = (
         SELECT effect.status FROM tool_effects effect
          WHERE effect.effect_intent_id = parts.id
       ),
       edited_at = COALESCE((
         SELECT effect.settled_at FROM tool_effects effect
          WHERE effect.effect_intent_id = parts.id
       ), parts.edited_at, parts.updated_at),
       updated_at = MAX(parts.updated_at, COALESCE((
         SELECT effect.settled_at FROM tool_effects effect
          WHERE effect.effect_intent_id = parts.id
       ), parts.updated_at))
     WHERE parts.message_type = 'tool'
       AND json_extract(parts.structured_content_json, '$.invocation.status') IN ('pending', 'started')
       AND EXISTS (
         SELECT 1 FROM tool_effects effect
          WHERE effect.effect_intent_id = parts.id
            AND effect.status IN ('completed', 'failed', 'ambiguous')
       )`,
  ];
}

/**
 * Rebuilds `_runtime_tool_invocations_update` so a replan lands whole.
 *
 * `replanCompletedReadReceipt` rebinds a settled read receipt to the call that
 * landed on its coordinates: it rewrites tool_name, connection_id, input_hash,
 * input_json, the execution plan pair, and the idempotency key alongside the
 * status flip. The v1 trigger carried only the status/output/error columns, so
 * the port dropped the rebind columns on the floor while the statement still
 * counted as a change — the receipt then described the old call under the new
 * plan hash. The trigger now maps every column the runtime's UPDATE statements
 * write; a view UPDATE that does not mention a column passes its old value
 * through NEW, so the added arms are identity writes for every other caller.
 *
 * Derived from the frozen v1 body with v3's rounding applied, so the versions
 * cannot drift.
 */
function rebuiltToolInvocationsUpdateTrigger(): string[] {
  const source = WORKSTREAM_RUNTIME_COMPAT_SCHEMA.find((statement) =>
    statement.includes("CREATE TRIGGER IF NOT EXISTS _runtime_tool_invocations_update"));
  if (!source) throw new Error("tool invocations update trigger not found in compat schema");
  const rounded = source.replaceAll("* 86400000 AS INTEGER", "* 86400000 + 0.5 AS INTEGER");
  const anchor = `       UPDATE tool_effects SET
         status = CASE NEW.status WHEN 'pending' THEN 'admitted' WHEN 'started' THEN 'executing' ELSE NEW.status END,`;
  if (!rounded.includes(anchor)) throw new Error("tool invocations update trigger shape changed");
  const patched = rounded.replace(anchor, `${anchor}
         tool_name = NEW.tool_name,
         connection_id = NEW.connection_id,
         request_hash = NEW.input_hash,
         input_json = COALESCE(NEW.input_json, '{}'),
         execution_plan_hash = NEW.execution_plan_hash,
         execution_plan_json = NEW.execution_plan_json,
         provider_idempotency_key = NEW.provider_idempotency_key,`);
  return ["DROP TRIGGER IF EXISTS _runtime_tool_invocations_update", patched];
}

/**
 * Keep an already-rendered tool card aligned when a recovery path settles only
 * the durable receipt.
 *
 * Normal execution writes the transcript row again after settling the receipt,
 * but stale-run reaping cannot: it has only the generic runtime database and no
 * live event publisher. Its UPDATE therefore used to leave `tool_effects`
 * terminal while `parts.structured_content_json` stayed `started` forever.
 * The receipt is the execution authority, so the compatibility trigger now
 * projects a terminal receipt into the same-id tool part inside the transaction
 * that settled it. A later normal transcript write remains an idempotent
 * overwrite through the v11 trigger.
 *
 * Derived from v8 rather than editing it because deployed migration hashes are
 * immutable.
 */
function rebuiltToolInvocationsUpdateTriggerForTranscriptSettlement(): string[] {
  const source = rebuiltToolInvocationsUpdateTrigger()[1];
  if (!source) throw new Error("rebuilt tool invocations update trigger not found");
  const anchor = `        WHERE effect_intent_id = OLD.id;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;`;
  if (!source.includes(anchor)) throw new Error("tool invocations update trigger tail changed");
  const patched = source.replace(anchor, `        WHERE effect_intent_id = OLD.id;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
       UPDATE parts SET
         structured_content_json = json_set(
           parts.structured_content_json,
           '$.invocation.status', NEW.status,
           '$.invocation.activityName', json('null'),
           '$.invocation.outputSummary', NEW.output_summary,
           '$.invocation.completedAt', NEW.completed_at,
           '$.invocation.error', json(COALESCE(NEW.error_json, 'null'))
         ),
         tool_status = NEW.status,
         edited_at = COALESCE(
           CASE WHEN NEW.completed_at IS NULL THEN NULL
             ELSE CAST((julianday(NEW.completed_at) - 2440587.5) * 86400000 + 0.5 AS INTEGER) END,
           parts.edited_at,
           parts.updated_at
         ),
         updated_at = MAX(parts.updated_at, COALESCE(
           CASE WHEN NEW.completed_at IS NULL THEN NULL
             ELSE CAST((julianday(NEW.completed_at) - 2440587.5) * 86400000 + 0.5 AS INTEGER) END,
           parts.updated_at
         ))
        WHERE parts.id = OLD.id AND parts.message_type = 'tool'
          AND NEW.status IN ('completed', 'failed', 'ambiguous');`);
  return ["DROP TRIGGER IF EXISTS _runtime_tool_invocations_update", patched];
}

/**
 * Makes a re-add through the runtime compatibility views leave the work stream
 * unseen again, the way a re-add through the product path does.
 *
 * Two writers can bring a removed participant back, and neither is this
 * object's own code: `admitConnectorAudience` re-admits somebody the moment
 * they speak in the Slack thread a work stream came from, and an agent tool can
 * clear `removed_at` through the update view. Both reach `participants` through
 * an INSTEAD OF trigger written before `first_opened_at` existed, so the old
 * timestamp survived the reactivation — the person was notified again, their
 * participant epoch bumped again, and the marker stayed on whatever the run was
 * doing. Being put back into a room you were taken out of is being added to it;
 * the marker now says so on every path that can do it.
 *
 * The reset is keyed to exactly the transition each trigger already bumps the
 * epoch for, so the three facts a re-add produces — a new epoch, a fresh
 * notification, an unseen marker — cannot disagree about whether one happened.
 *
 * Derived from `roundedCompatTriggerRebuilds` rather than from the v1 array,
 * because v1's text is not what is installed: migration 3 replaced both of
 * these with rounding variants, and rebuilding from v1 would silently reinstate
 * the truncation that cost half of all runs their terminal state.
 */
function participantCompatTriggersResettingFirstOpened(): string[] {
  const rebuilt = new Map(roundedCompatTriggerRebuilds()
    .filter((statement) => statement.startsWith("CREATE TRIGGER"))
    .map((statement) => [/CREATE TRIGGER IF NOT EXISTS (\S+)/.exec(statement)?.[1] ?? "", statement]));

  const insert = rebuilt.get("_runtime_workstream_participants_insert");
  if (!insert) throw new Error("participant insert compat trigger not found");
  const insertAnchor = `          participant_epoch = CASE WHEN participants.status = 'removed' AND excluded.status = 'active'
            THEN participants.participant_epoch + 1 ELSE participants.participant_epoch END,`;
  if (!insert.includes(insertAnchor)) throw new Error("participant insert conflict branch changed");

  const update = rebuilt.get("_runtime_workstream_participants_update");
  if (!update) throw new Error("participant update compat trigger not found");
  const updateAnchor = `          participant_epoch = participant_epoch + CASE
            WHEN (OLD.removed_at IS NULL) != (NEW.removed_at IS NULL) THEN 1 ELSE 0 END,`;
  if (!update.includes(updateAnchor)) throw new Error("participant update epoch clause changed");

  return [
    "DROP TRIGGER IF EXISTS _runtime_workstream_participants_insert",
    insert.replace(insertAnchor, `${insertAnchor}
          first_opened_at = CASE WHEN participants.status = 'removed' AND excluded.status = 'active'
            THEN NULL ELSE participants.first_opened_at END,`),
    "DROP TRIGGER IF EXISTS _runtime_workstream_participants_update",
    // Only one direction of the epoch's condition: being removed is not being
    // shown the work stream again.
    update.replace(updateAnchor, `${updateAnchor}
          first_opened_at = CASE
            WHEN OLD.removed_at IS NOT NULL AND NEW.removed_at IS NULL THEN NULL
            ELSE first_opened_at END,`),
  ];
}

/**
 * Rebuilds every compat trigger that converts an ISO timestamp to epoch
 * milliseconds, rounding instead of truncating.
 *
 * `CAST((julianday(x) - 2440587.5) * 86400000 AS INTEGER)` truncates, and the
 * float product sits up to ~0.03 ms off the true integer, so half of all
 * timestamps came back one millisecond early when the view reformatted them.
 * That broke every read that compares a stored timestamp to the string it was
 * written from — most visibly `terminalizeHarnessAttempt`'s `terminalized_at =
 * ?` guard, which is what decides whether the member-facing work stream state
 * follows the run out of `running`. A measured 49.7% of runs lost that guard
 * and left the member watching a spinner over a finished run. Adding 0.5
 * before the cast rounds to nearest; the float error is two orders of
 * magnitude below half a millisecond, so the round trip is exact for every
 * input.
 *
 * Derived from the v1 statements rather than restated because the v1 array is
 * already frozen by its own migration hash — any edit to it breaks v1 before
 * it could silently change what this migration builds.
 */
function roundedCompatTriggerRebuilds(): string[] {
  return WORKSTREAM_RUNTIME_COMPAT_SCHEMA
    .filter((statement) =>
      statement.includes("CREATE TRIGGER IF NOT EXISTS")
      && statement.includes("* 86400000 AS INTEGER"))
    .flatMap((statement) => {
      const name = /CREATE TRIGGER IF NOT EXISTS (\S+)/.exec(statement)?.[1];
      if (!name) throw new Error("compat trigger statement without a name");
      return [
        `DROP TRIGGER IF EXISTS ${name}`,
        statement.replaceAll("* 86400000 AS INTEGER", "* 86400000 + 0.5 AS INTEGER"),
      ];
    });
}

/**
 * Allocates `tool_effects.tool_position` from the run's high-water mark rather
 * than its row count.
 *
 * The insert trigger wrote `(SELECT COUNT(*) FROM tool_effects WHERE run_id =
 * ...)`, and the table's uniqueness is `UNIQUE (run_id, attempt_epoch,
 * tool_position)`. A count allocates injectively only while nothing is ever
 * removed — but `attachment-tool-receipts.ts` deletes receipts from two paths,
 * and `_runtime_tool_invocations_delete` turns each into a
 * `DELETE FROM tool_effects`. One hole in a run's positions and the next
 * admission computes a number another row already holds; `INSERT OR IGNORE`
 * drops it, and `persistToolExecutionPlan` — reading zero changes as "someone
 * else already wrote my receipt" — looks up `(harness_run_id, tool_call_id)`,
 * finds nothing because its row was never written, and throws
 * `RunOwnershipLostError`. The run ends on a lease failure that never happened.
 *
 * The caller's conflict target is real: `INSERT OR IGNORE` resolves against
 * three constraints, and the compat schema's own `tool_effects_run_call_uq`
 * (`workstream-runtime-compat-schema.ts`) is what makes the routed
 * `ON CONFLICT(harness_run_id, tool_call_id) DO NOTHING` mean what it says
 * after the router strips the clause. It is simply not the constraint that
 * fires here — a collided *position* carries a new `tool_call_id`, so the call
 * key is untouched and the caller's fallback lookup is querying for a row that
 * the ignored insert never created.
 *
 * `MAX(tool_position) + 1` stays injective across deletes. It is scoped to the
 * run rather than to `(run_id, attempt_epoch)` so that positions keep advancing
 * across attempts exactly as the count did: narrowing the scope would restart
 * numbering at a new epoch, which is defensible but is a behavior change this
 * repair has no reason to make.
 *
 * Derived from the compat source with v3's rounding reapplied, because that
 * migration rebuilt every epoch-converting trigger and this text must continue
 * from it — starting at v1's would silently reinstate the truncation it fixed.
 */
function rebuiltToolInvocationsInsertTriggerForPositionAllocation(): string[] {
  const source = WORKSTREAM_RUNTIME_COMPAT_SCHEMA.find((statement) =>
    statement.includes("CREATE TRIGGER IF NOT EXISTS _runtime_tool_invocations_insert"));
  if (!source) throw new Error("tool invocations insert trigger not found in compat schema");
  const rounded = source.replaceAll("* 86400000 AS INTEGER", "* 86400000 + 0.5 AS INTEGER");
  const anchor = "(SELECT COUNT(*) FROM tool_effects WHERE run_id = NEW.harness_run_id),";
  if (!rounded.includes(anchor)) {
    throw new Error("tool invocations insert trigger position allocation shape changed");
  }
  const patched = rounded.replace(
    anchor,
    "(SELECT COALESCE(MAX(tool_position) + 1, 0) FROM tool_effects WHERE run_id = NEW.harness_run_id),",
  );
  return ["DROP TRIGGER IF EXISTS _runtime_tool_invocations_insert", patched];
}

/**
 * Retires `_runtime_tool_invocations` and `_runtime_tool_checkpoints`, and — the
 * part that is not a deletion — adopts the two objects the compatibility schema
 * owns that are not compatibility objects at all.
 *
 * `attachment_tool_receipts` is a real `STRICT` table holding live product data:
 * the resource version each replayable attachment read depended on. It has no
 * view and no trigger. It is here only because this is where it was written,
 * and dropping the compat schema on the strength of the file's name would lose
 * rows. `tool_effects_run_call_uq` is a unique index on real columns of a real
 * table, and it is what makes the routed
 * `ON CONFLICT(harness_run_id, tool_call_id) DO NOTHING` mean what it says once
 * the SQL router strips that clause — the replay dedup for every tool receipt.
 * Both are recreated here under the object's own schema before anything is
 * dropped, so a fresh object and a migrated one agree.
 *
 * Both are `IF NOT EXISTS`, because every object that has ever run v1 already
 * has them. This migration is what makes them the object's rather than the
 * compat layer's, so that the eventual deletion of
 * `WORKSTREAM_RUNTIME_COMPAT_SCHEMA` cannot take them along.
 *
 * The drops are derived by matching the v1 source rather than written out, and
 * the derivation throws when it matches nothing: a renamed view has to fail the
 * build rather than produce a migration that silently drops nothing. Triggers
 * before views, because dropping a view out from under its own INSTEAD OF
 * trigger is legal and leaves the trigger orphaned in `sqlite_schema`.
 */
function toolReceiptAuthorityPromotion(): string[] {
  const names = /^_runtime_tool_(?:invocations|checkpoints)/;
  const compatObjects = WORKSTREAM_RUNTIME_COMPAT_SCHEMA.flatMap((statement) => {
    const trigger = /CREATE TRIGGER IF NOT EXISTS (\S+)/.exec(statement)?.[1];
    if (trigger) return names.test(trigger) ? [`DROP TRIGGER IF EXISTS ${trigger}`] : [];
    const view = /CREATE VIEW IF NOT EXISTS (\S+)/.exec(statement)?.[1];
    return view && names.test(view) ? [`DROP VIEW IF EXISTS ${view}`] : [];
  });
  if (compatObjects.length !== 6) {
    throw new Error(`expected six tool-receipt compat objects, found ${compatObjects.length}`);
  }

  const adopt = WORKSTREAM_RUNTIME_COMPAT_SCHEMA.filter((statement) =>
    statement.includes("CREATE TABLE IF NOT EXISTS attachment_tool_receipts")
    || statement.includes("attachment_tool_receipts_invocation_idx")
    || statement.includes("tool_effects_run_call_uq"));
  if (adopt.length !== 3) {
    throw new Error(`expected three adopted tool-receipt objects, found ${adopt.length}`);
  }

  return [
    ...adopt,
    ...compatObjects.filter((statement) => statement.startsWith("DROP TRIGGER")),
    ...compatObjects.filter((statement) => statement.startsWith("DROP VIEW")),
  ];
}

/**
 * Prepared pending-input content stays immutable; `input_sequence` does not.
 * Queue order is the one live mutation a pending row admits: a drag rewrites
 * promotion order without minting a second input. `updated_at` is already
 * outside this trigger.
 */
/**
 * The mailbox's triggers and ordering index, in one place.
 *
 * Shared with the rebuild that widened its `preparation_kind` vocabulary:
 * dropping the table drops these with it, and a rebuild that recreated them by
 * hand would let the upgraded object's guards drift from a fresh object's
 * silently — the immutability triggers are the only thing preventing a
 * preparation from being retargeted after it was reserved.
 */
function pendingLoopInputMailboxGuards(): string[] {
  return [
      `CREATE TRIGGER pending_loop_input_mailbox_identity_immutable
       BEFORE UPDATE OF
         input_id, loop_id, input_sequence, admitted_after_transcript_sequence,
         client_message_id,
         preparation_kind, created_at
       ON pending_loop_input_mailbox
       WHEN NEW.input_id IS NOT OLD.input_id
         OR NEW.loop_id IS NOT OLD.loop_id
         OR NEW.input_sequence IS NOT OLD.input_sequence
         OR NEW.admitted_after_transcript_sequence IS NOT OLD.admitted_after_transcript_sequence
         OR NEW.client_message_id IS NOT OLD.client_message_id
         OR NEW.preparation_kind IS NOT OLD.preparation_kind
         OR NEW.created_at IS NOT OLD.created_at
       BEGIN
         SELECT RAISE(ABORT, 'pending_loop_input_mailbox_identity_is_immutable');
       END`,
      `CREATE TRIGGER pending_loop_input_mailbox_state_transition
       BEFORE UPDATE OF state
       ON pending_loop_input_mailbox
       WHEN NOT (
         OLD.state = 'preparing' AND NEW.state IN ('ready', 'failed', 'discarded')
       )
       BEGIN
         SELECT RAISE(ABORT, 'pending_loop_input_mailbox_state_transition_invalid');
       END`,
      `CREATE TRIGGER pending_loop_input_mailbox_envelope_immutable
       BEFORE UPDATE OF envelope_json
       ON pending_loop_input_mailbox
       WHEN OLD.state = 'preparing' AND NEW.state = 'preparing'
         AND NEW.envelope_json IS NOT OLD.envelope_json
       BEGIN
         SELECT RAISE(ABORT, 'pending_loop_input_mailbox_envelope_is_immutable');
       END`,
      `CREATE INDEX pending_loop_input_mailbox_order_idx
         ON pending_loop_input_mailbox(loop_id, state, input_sequence)`,
  ];
}

function pendingLoopInputsPreparedImmutableTrigger(): string {
  return `CREATE TRIGGER pending_loop_inputs_prepared_immutable
       BEFORE UPDATE OF
         input_id, loop_id, prepared_turn_id,
         admitted_after_transcript_sequence, mode,
         actor, author_user_id, author_name_snapshot,
         author_avatar_url_snapshot, client_message_id, external_actor_json,
         message_type, prepared_payload_id, prepared_fact_id,
         prepared_payload_audience, prepared_payload_media_type,
         prepared_payload_json, prepared_payload_sha256,
         prepared_payload_byte_length, bind_payload_json, provenance_json, authorization_json,
         attachments_json, mentions_json, created_at
       ON pending_loop_inputs
       WHEN NEW.input_id IS NOT OLD.input_id
         OR NEW.loop_id IS NOT OLD.loop_id
         OR NEW.prepared_turn_id IS NOT OLD.prepared_turn_id
         OR NEW.admitted_after_transcript_sequence IS NOT OLD.admitted_after_transcript_sequence
         OR NEW.mode IS NOT OLD.mode
         OR NEW.actor IS NOT OLD.actor
         OR NEW.author_user_id IS NOT OLD.author_user_id
         OR NEW.author_name_snapshot IS NOT OLD.author_name_snapshot
         OR NEW.author_avatar_url_snapshot IS NOT OLD.author_avatar_url_snapshot
         OR NEW.client_message_id IS NOT OLD.client_message_id
         OR NEW.external_actor_json IS NOT OLD.external_actor_json
         OR NEW.message_type IS NOT OLD.message_type
         OR NEW.prepared_payload_id IS NOT OLD.prepared_payload_id
         OR NEW.prepared_fact_id IS NOT OLD.prepared_fact_id
         OR NEW.prepared_payload_audience IS NOT OLD.prepared_payload_audience
         OR NEW.prepared_payload_media_type IS NOT OLD.prepared_payload_media_type
         OR NEW.prepared_payload_json IS NOT OLD.prepared_payload_json
         OR NEW.prepared_payload_sha256 IS NOT OLD.prepared_payload_sha256
         OR NEW.prepared_payload_byte_length IS NOT OLD.prepared_payload_byte_length
         OR NEW.bind_payload_json IS NOT OLD.bind_payload_json
         OR NEW.provenance_json IS NOT OLD.provenance_json
         OR NEW.authorization_json IS NOT OLD.authorization_json
         OR NEW.attachments_json IS NOT OLD.attachments_json
         OR NEW.mentions_json IS NOT OLD.mentions_json
         OR NEW.created_at IS NOT OLD.created_at
       BEGIN
         SELECT RAISE(ABORT, 'pending_loop_input_prepared_fields_are_immutable');
       END`;
}

/** Fast deterministic schema fingerprint; the value is evidence, not authority. */
export function workstreamObjectSchemaImplementationHash(
  migration: WorkstreamObjectSchemaMigration,
): string {
  return durableObjectMigrationHash(migration);
}

/**
 * The migration runner's component key for the workstream object's schema.
 *
 * Exported because `SubstreamAgent` reports under it while this module migrates
 * under it; a second literal there could drift from this one and file the report
 * against a component the object's own ledger does not use.
 *
 * The value is derived from the class that applies this schema, not from this
 * module, because the class is the only thing an operator reading the tracker
 * can match against the fleet. Derived, not equal: `_do` comes from the two
 * sibling keys whose classes end in `DO` (`workstream_do`, `workspace_do`)
 * rather than from `SubstreamAgent`. The key said `workstream` while this
 * history belonged to `WorkstreamRoom` and kept saying it through the class
 * rename, which left the only key derived from nothing still in the codebase
 * sitting next to `workstream_do` — a genuinely different object — under a name
 * that reads like its parent. Renaming it is safe precisely because nothing but
 * the tracker reads it: the object's own `_sql_schema_migrations` ledger has no
 * component column, so no receipt moves and no migration re-runs. Registry
 * migration v3 carries the stored history across, and `applyReport` rewrites
 * the old key on the way in until no deployed build can still send it.
 */
export const WORKSTREAM_OBJECT_SCHEMA_COMPONENT = "substream_agent_do";

export function applyWorkstreamObjectSchema(
  storage: DurableObjectStorage,
  workerVersionId: string,
  now = Date.now(),
): void {
  applyDurableObjectSqliteMigrations({
    storage,
    migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
    component: WORKSTREAM_OBJECT_SCHEMA_COMPONENT,
    workerVersionId,
    now,
    afterMigrations: (sql) => {
      sql.exec(
        `INSERT INTO object_versions
           (id, worker_version_id, contract_version, schema_version, data_version,
            projection_version, restore_generation, updated_at)
         VALUES (1, ?, ?, ?, 0, 0, 0, ?)
         ON CONFLICT(id) DO UPDATE SET
           worker_version_id = excluded.worker_version_id,
           contract_version = excluded.contract_version,
           schema_version = excluded.schema_version,
           updated_at = excluded.updated_at
         WHERE object_versions.worker_version_id != excluded.worker_version_id
            OR object_versions.contract_version != excluded.contract_version
            OR object_versions.schema_version != excluded.schema_version`,
        workerVersionId,
        WORKSTREAM_OBJECT_CONTRACT_VERSION,
        WORKSTREAM_OBJECT_SCHEMA_VERSION,
        now,
      );
    },
  });
}
