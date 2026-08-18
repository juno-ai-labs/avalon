/**
 * Object-local SQL schema for the existing one-room-per-work-stream namespace.
 *
 * The existing namespace migrates through `preparing` and becomes the
 * authoritative work-stream product store only after a maintenance-window
 * import verifies every normalized table. Regional D1 retains only the route,
 * workspace authorization, and rebuildable directory projections afterwards.
 */

import { WORKSTREAM_RUNTIME_COMPAT_SCHEMA } from "./workstream-runtime-compat-schema";
import {
  applyDurableObjectSqliteMigrations,
  durableObjectMigrationHash,
  type DurableObjectSqliteMigration,
} from "./sqlite-migrations";

export const WORKSTREAM_OBJECT_CONTRACT_VERSION = 1;
export const WORKSTREAM_OBJECT_SCHEMA_VERSION = 1;

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
    CHECK (payload_json IS NULL OR json_valid(payload_json))
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
  `CREATE TABLE IF NOT EXISTS grant_sessions (
    grant_id TEXT PRIMARY KEY,
    grant_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    membership_epoch INTEGER NOT NULL,
    authority_epoch INTEGER NOT NULL,
    scope_epoch INTEGER NOT NULL,
    source_authorization_epoch INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS grant_sessions_user_expiry_idx
     ON grant_sessions(user_id, expires_at)`,
  `CREATE INDEX IF NOT EXISTS grant_sessions_expiry_idx ON grant_sessions(expires_at)`,
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
  `CREATE TABLE IF NOT EXISTS run_events (
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    attempt_epoch INTEGER NOT NULL,
    event_seq INTEGER NOT NULL,
    event_kind TEXT NOT NULL,
    through_frame_seq INTEGER NOT NULL,
    payload_hash TEXT NOT NULL,
    semantic_part_id TEXT REFERENCES parts(id),
    received_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, attempt_epoch, event_seq)
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
  `CREATE TABLE IF NOT EXISTS legacy_artifacts (
    artifact_id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
    artifact_type TEXT NOT NULL,
    title TEXT NOT NULL,
    content_ref TEXT,
    preview_text TEXT,
    status TEXT NOT NULL,
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
    created_at INTEGER NOT NULL,
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
  `CREATE TABLE IF NOT EXISTS hypersight_configuration_versions (
    configuration_version_id TEXT PRIMARY KEY,
    version_number INTEGER NOT NULL CHECK (version_number > 0),
    blocks_json TEXT NOT NULL CHECK (json_valid(blocks_json)),
    created_by_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (version_number)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS hypersight_block_runs (
    block_run_id TEXT PRIMARY KEY,
    configuration_version_id TEXT NOT NULL
      REFERENCES hypersight_configuration_versions(configuration_version_id) ON DELETE CASCADE,
    block_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    trigger_sequence INTEGER NOT NULL CHECK (trigger_sequence >= 0),
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    markdown TEXT,
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS hypersight_block_runs_status_idx
     ON hypersight_block_runs(status, created_at, block_run_id)`,
  `CREATE TABLE IF NOT EXISTS hypersight_user_preferences (
    user_id TEXT PRIMARY KEY,
    visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS activity_delivery_receipts (
    delivery_id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    source_authorization_epoch INTEGER NOT NULL,
    authorization_selector_hash TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    incorporated_part_id TEXT REFERENCES parts(id),
    result_code TEXT NOT NULL,
    received_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS activity_delivery_source_idx
     ON activity_delivery_receipts(activity_id, source_revision)`,
  `CREATE INDEX IF NOT EXISTS activity_delivery_part_idx
     ON activity_delivery_receipts(incorporated_part_id)
     WHERE incorporated_part_id IS NOT NULL`,
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
  `CREATE TABLE IF NOT EXISTS workstream_events (
    event_seq INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    recipient_user_id TEXT,
    kind TEXT NOT NULL,
    run_id TEXT REFERENCES runs(run_id),
    attempt_epoch INTEGER,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS workstream_events_recipient_idx
     ON workstream_events(recipient_user_id, event_seq)`,
  `CREATE INDEX IF NOT EXISTS workstream_events_expiry_idx
     ON workstream_events(expires_at, event_seq)`,
  `CREATE INDEX IF NOT EXISTS workstream_events_run_idx
     ON workstream_events(run_id, event_seq) WHERE run_id IS NOT NULL`,
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
  // remains in compaction_jobs/compaction_checkpoints.
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
];

/** Fast deterministic schema fingerprint; the value is evidence, not authority. */
export function workstreamObjectSchemaImplementationHash(
  migration: WorkstreamObjectSchemaMigration,
): string {
  return durableObjectMigrationHash(migration);
}

export function applyWorkstreamObjectSchema(
  storage: DurableObjectStorage,
  workerVersionId: string,
  now = Date.now(),
): void {
  applyDurableObjectSqliteMigrations({
    storage,
    migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
    component: "workstream",
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
