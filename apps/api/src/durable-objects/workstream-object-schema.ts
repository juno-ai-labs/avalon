/**
 * Object-local SQL schema for the existing one-room-per-work-stream namespace.
 *
 * The existing namespace migrates through `preparing` and becomes the
 * authoritative work-stream product store only after a maintenance-window
 * import verifies every normalized table. Regional D1 retains the route and
 * workspace authorization; WorkspaceDO owns cross-work-stream serving state.
 */

import { SCHEDULED_ALARM_SCHEMA_STATEMENTS } from "./scheduled-alarms";
import { WORKSTREAM_RUNTIME_COMPAT_SCHEMA } from "./workstream-runtime-compat-schema";
import {
  applyDurableObjectSqliteMigrations,
  durableObjectMigrationHash,
  type DurableObjectSqliteMigration,
} from "./sqlite-migrations";

export const WORKSTREAM_OBJECT_CONTRACT_VERSION = 1;
export const WORKSTREAM_OBJECT_SCHEMA_VERSION = 19;

export type WorkstreamObjectSchemaMigration = DurableObjectSqliteMigration;

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
  // The HyperSight context fence asks for the earliest pending tool call on
  // every refresh-eligible event; pending rows are few, so the partial index
  // answers MIN() without ranging over the whole transcript.
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
      // `_sql_schema_migrations`, so editing them strands every deployed
      // object on `substream_agent_do_schema_hash_mismatch:1`. A new object
      // therefore creates them and drops them again in the same bootstrap
      // transaction, which is the cost of an append-only history and is paid
      // once.
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
    ],
  },
];

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
 * rather than from `SubstreamAgent`, and `block_dashboard_block_agent` carries
 * a `block` its own class does not. The key said `workstream` while this
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
