-- Workflow semantic state, connector activity, suggestions, content, search,
-- migrations, exports, retention, and audit.

create table avalon_private.content_refs (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  bucket text not null check (bucket in ('workspace-content', 'connector-ingress', 'exports')),
  object_path text not null check (length(object_path) between 1 and 1024),
  state text not null default 'pending' check (state in ('pending', 'ready', 'deleting', 'deleted', 'orphaned', 'corrupt')),
  content_hash bytea not null check (octet_length(content_hash) = 32),
  byte_size bigint not null check (byte_size >= 0),
  media_type text not null check (length(media_type) between 1 and 256),
  access_container_kind text not null check (access_container_kind in ('workspace', 'workstream', 'substream', 'connector_resource')),
  access_container_id uuid not null,
  access_revision bigint not null check (access_revision > 0),
  source_kind text not null check (length(source_kind) between 1 and 64),
  source_id uuid not null,
  source_revision bigint not null check (source_revision > 0),
  uploaded_by_kind text not null check (uploaded_by_kind in ('user', 'workflow', 'connector', 'migration', 'system')),
  uploaded_by_id uuid,
  upload_operation_key text check (upload_operation_key is null or length(upload_operation_key) <= 256),
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  expires_at timestamptz,
  deleted_at timestamptz,
  verified_at timestamptz,
  unique (bucket, object_path)
);

create unique index content_refs_operation
  on avalon_private.content_refs (workspace_id, upload_operation_key)
  where upload_operation_key is not null;
create index content_refs_reconciliation
  on avalon_private.content_refs (state, expires_at, id);
create index content_refs_source
  on avalon_private.content_refs (workspace_id, source_kind, source_id, source_revision);
create index content_refs_access
  on avalon_private.content_refs (workspace_id, access_container_kind, access_container_id, access_revision);

alter table avalon_private.conversation_parts
  add constraint conversation_parts_content_ref_fk
  foreign key (content_ref_id) references avalon_private.content_refs(id);
alter table avalon_private.active_output_attempts
  add constraint active_output_terminal_content_ref_fk
  foreign key (terminal_content_ref_id) references avalon_private.content_refs(id);
alter table avalon_private.workstream_cards
  add constraint workstream_cards_preview_content_ref_fk
  foreign key (preview_content_ref_id) references avalon_private.content_refs(id);

create table avalon_private.storage_reconciliation_jobs (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  kind text not null check (kind in ('finalize', 'orphan_scan', 'verify', 'retain', 'delete')),
  content_ref_id uuid not null references avalon_private.content_refs(id) on delete cascade,
  expected_hash bytea not null check (octet_length(expected_hash) = 32),
  state text not null default 'queued' check (state in ('queued', 'running', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  result_hash bytea check (result_hash is null or octet_length(result_hash) = 32),
  last_error text check (last_error is null or length(last_error) <= 512),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index storage_jobs_one_live
  on avalon_private.storage_reconciliation_jobs (content_ref_id, kind)
  where state in ('queued', 'running');

create table avalon_private.model_provider_configs (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid references avalon_private.workspaces(id) on delete cascade,
  provider text not null check (length(provider) between 1 and 64),
  model text not null check (length(model) between 1 and 256),
  revision bigint not null check (revision > 0),
  state text not null check (state in ('active', 'superseded', 'disabled')),
  region_policy jsonb not null default '{}'::jsonb check (pg_column_size(region_policy) <= 4096),
  parameter_policy jsonb not null default '{}'::jsonb check (pg_column_size(parameter_policy) <= 8192),
  pricing_version text not null check (length(pricing_version) between 1 and 64),
  created_at timestamptz not null default now(),
  superseded_at timestamptz,
  unique nulls not distinct (workspace_id, provider, model, revision)
);

create table avalon_private.tool_policies (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  version bigint not null check (version > 0),
  state text not null check (state in ('active', 'superseded')),
  allowed_tool_kinds jsonb not null check (jsonb_typeof(allowed_tool_kinds) = 'array' and pg_column_size(allowed_tool_kinds) <= 8192),
  approval_rules jsonb not null default '{}'::jsonb check (pg_column_size(approval_rules) <= 8192),
  resource_access_revision bigint not null check (resource_access_revision > 0),
  created_at timestamptz not null default now(),
  superseded_at timestamptz,
  unique (workspace_id, version)
);

create table avalon_private.agent_runs (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  owner_kind text not null check (owner_kind in ('workstream', 'automation', 'meeting', 'digest', 'suggestion', 'compaction', 'generic')),
  owner_id uuid not null,
  execution_principal_kind text not null check (execution_principal_kind in ('user', 'workspace')),
  execution_principal_id uuid not null,
  audience_user_id uuid,
  substream_id uuid references avalon_private.substreams(id),
  admission_batch_id uuid unique references avalon_private.input_admission_batches(id)
    deferrable initially deferred,
  state text not null default 'admitted' check (state in ('admitted', 'starting', 'running', 'waiting_user', 'waiting_event', 'waiting_provider', 'interrupting', 'completed', 'failed', 'interrupted', 'cancelled')),
  run_revision bigint not null default 1 check (run_revision > 0),
  control_revision bigint not null default 1 check (control_revision > 0),
  workspace_access_revision bigint not null check (workspace_access_revision > 0),
  workstream_access_revision bigint,
  substream_access_revision bigint,
  resource_access_revision bigint,
  scope_revision bigint,
  workflow_instance_id text not null unique check (length(workflow_instance_id) between 1 and 100),
  workflow_version text not null check (length(workflow_version) between 1 and 128),
  next_action_no integer not null default 1 check (next_action_no > 0),
  model_provider text not null check (length(model_provider) between 1 and 64),
  model_name text not null check (length(model_name) between 1 and 256),
  provider_config_revision bigint not null check (provider_config_revision > 0),
  tokens_used bigint not null default 0 check (tokens_used >= 0),
  tools_used bigint not null default 0 check (tools_used >= 0),
  cost_used_micros bigint not null default 0 check (cost_used_micros >= 0),
  actions_used bigint not null default 0 check (actions_used >= 0),
  elapsed_ms bigint not null default 0 check (elapsed_ms >= 0),
  terminal_reason text check (terminal_reason is null or length(terminal_reason) <= 128),
  last_error_class text check (last_error_class is null or length(last_error_class) <= 128),
  created_at timestamptz not null default now(),
  workflow_attached_at timestamptz,
  started_at timestamptz,
  last_progress_at timestamptz,
  completed_at timestamptz,
  unique nulls not distinct (owner_kind, owner_id, admission_batch_id),
  check (
    owner_kind = 'workstream'
    or execution_principal_kind = 'workspace'
    or audience_user_id = execution_principal_id
  )
);

create index agent_runs_active_owner
  on avalon_private.agent_runs (workspace_id, owner_kind, owner_id, state, created_at desc)
  where state in ('admitted', 'starting', 'running', 'waiting_user', 'waiting_event', 'waiting_provider', 'interrupting');

alter table avalon_private.workstreams
  add constraint workstreams_active_run_fk
  foreign key (active_run_id) references avalon_private.agent_runs(id);
alter table avalon_private.input_admission_batches
  add constraint input_admission_run_fk
  foreign key (run_id) references avalon_private.agent_runs(id)
  deferrable initially deferred;
alter table avalon_private.active_output_attempts
  add constraint active_output_run_fk
  foreign key (run_id) references avalon_private.agent_runs(id) on delete cascade;
alter table avalon_private.turns
  add constraint turns_run_fk
  foreign key (run_id) references avalon_private.agent_runs(id);

create table avalon_private.agent_actions (
  id uuid primary key default avalon_private.uuid_v7(),
  run_id uuid not null references avalon_private.agent_runs(id) on delete cascade,
  action_no integer not null check (action_no > 0),
  action_kind text not null check (action_kind in ('model', 'tool', 'terminal', 'wait', 'materialize', 'finalize')),
  state text not null default 'planned' check (state in ('planned', 'started', 'succeeded', 'failed', 'superseded')),
  control_revision bigint not null check (control_revision > 0),
  input_ref uuid,
  output_ref uuid,
  semantic_outcome text check (semantic_outcome is null or semantic_outcome in (
    'completed', 'needs_input', 'failed', 'stopped'
  )),
  operation_id text not null unique check (length(operation_id) between 1 and 256),
  started_at timestamptz,
  completed_at timestamptz,
  error_class text check (error_class is null or length(error_class) <= 128),
  unique (run_id, action_no)
);

alter table avalon_private.turns
  add constraint turns_action_fk
  foreign key (action_id) references avalon_private.agent_actions(id);

create table avalon_private.run_signals (
  id uuid primary key default avalon_private.uuid_v7(),
  run_id uuid not null references avalon_private.agent_runs(id) on delete cascade,
  signal_kind text not null check (signal_kind in ('steer', 'interrupt', 'cancel', 'resume', 'provider_event')),
  operation_key text not null check (length(operation_key) between 1 and 256),
  expected_control_revision bigint not null check (expected_control_revision > 0),
  payload jsonb not null default '{}'::jsonb check (pg_column_size(payload) <= 16384),
  state text not null default 'pending' check (state in ('pending', 'delivered', 'observed', 'superseded')),
  created_at timestamptz not null default now(),
  observed_at timestamptz,
  unique (run_id, operation_key)
);

create index run_signals_pending
  on avalon_private.run_signals (run_id, state, created_at, id)
  where state = 'pending';

create table avalon_private.tool_effects (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  run_id uuid not null references avalon_private.agent_runs(id) on delete cascade,
  action_no integer not null,
  effect_kind text not null check (length(effect_kind) between 1 and 64),
  effect_key text not null check (length(effect_key) between 1 and 256),
  operation_id text not null unique check (length(operation_id) between 1 and 256),
  state text not null default 'planned' check (state in ('planned', 'started', 'succeeded', 'failed', 'response_uncertain')),
  request_hash bytea not null check (octet_length(request_hash) = 32),
  provider_reference text check (provider_reference is null or length(provider_reference) <= 512),
  response_hash bytea check (response_hash is null or octet_length(response_hash) = 32),
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique (run_id, action_no, effect_kind, effect_key),
  foreign key (run_id, action_no) references avalon_private.agent_actions(run_id, action_no)
);

create table avalon_private.workflow_starts (
  run_id uuid primary key references avalon_private.agent_runs(id) on delete cascade,
  workflow_instance_id text not null unique,
  expected_run_revision bigint not null check (expected_run_revision > 0),
  state text not null default 'queued' check (state in ('queued', 'creating', 'attached', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error_class text,
  created_at timestamptz not null default now(),
  attached_at timestamptz
);

create table avalon_private.terminal_sessions (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  run_id uuid not null references avalon_private.agent_runs(id) on delete cascade,
  provider text not null default 'daytona' check (provider = 'daytona'),
  provider_session_id text not null unique check (length(provider_session_id) between 1 and 512),
  state text not null check (state in ('creating', 'ready', 'running', 'stopping', 'closed', 'failed')),
  operation_id text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  closed_at timestamptz
);

create table avalon_private.terminal_commands (
  id uuid primary key default avalon_private.uuid_v7(),
  session_id uuid not null references avalon_private.terminal_sessions(id) on delete cascade,
  action_id uuid not null references avalon_private.agent_actions(id),
  provider_command_id text not null check (length(provider_command_id) between 1 and 512),
  operation_id text not null unique,
  state text not null check (state in ('planned', 'running', 'succeeded', 'failed', 'terminated')),
  stdout_offset bigint not null default 0 check (stdout_offset >= 0),
  stderr_offset bigint not null default 0 check (stderr_offset >= 0),
  exit_code integer,
  started_at timestamptz,
  reconciled_at timestamptz,
  finished_at timestamptz,
  unique (session_id, provider_command_id)
);

create table avalon_private.connector_installations (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  provider text not null check (length(provider) between 1 and 64),
  external_installation_id text not null check (length(external_installation_id) between 1 and 512),
  state text not null default 'active' check (state in ('active', 'paused', 'revoked', 'deleting')),
  credential_ref text not null check (length(credential_ref) between 1 and 512),
  access_revision bigint not null default 1 check (access_revision > 0),
  webhook_cursor text check (webhook_cursor is null or length(webhook_cursor) <= 2048),
  backfill_cursor text check (backfill_cursor is null or length(backfill_cursor) <= 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (workspace_id, provider, external_installation_id)
);

create index connector_installations_active
  on avalon_private.connector_installations (workspace_id, provider, state, id);

create table avalon_private.connector_resources (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  installation_id uuid not null references avalon_private.connector_installations(id) on delete cascade,
  provider_resource_kind text not null check (length(provider_resource_kind) between 1 and 128),
  provider_resource_id text not null check (length(provider_resource_id) between 1 and 1024),
  provider_version text not null check (length(provider_version) between 1 and 256),
  current_content_ref_id uuid references avalon_private.content_refs(id),
  access_mode text not null default 'workspace' check (access_mode in ('workspace', 'restricted')),
  access_revision bigint not null default 1 check (access_revision > 0),
  state text not null default 'active' check (state in ('active', 'tombstoned', 'deleted')),
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  tombstoned_at timestamptz,
  unique (installation_id, provider_resource_kind, provider_resource_id)
);

create table avalon_private.connector_resource_access (
  connector_resource_id uuid not null references avalon_private.connector_resources(id) on delete cascade,
  platform_user_id uuid not null,
  capability text not null check (capability in ('view', 'use', 'administer')),
  state text not null default 'active' check (state in ('active', 'revoked')),
  granted_by uuid not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (connector_resource_id, platform_user_id)
);

create index connector_resource_access_by_user
  on avalon_private.connector_resource_access (platform_user_id, state, connector_resource_id);

create table avalon_private.ingress_receipts (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  connector_installation_id uuid not null references avalon_private.connector_installations(id) on delete cascade,
  provider_event_id text not null check (length(provider_event_id) between 1 and 1024),
  body_hash bytea not null check (octet_length(body_hash) = 32),
  byte_size bigint not null check (byte_size >= 0),
  raw_content_ref_id uuid references avalon_private.content_refs(id),
  bounded_body bytea check (bounded_body is null or octet_length(bounded_body) <= 65536),
  provider_schema_version text not null check (length(provider_schema_version) between 1 and 128),
  signature_version text not null check (length(signature_version) between 1 and 128),
  state text not null default 'accepted' check (state in ('accepted', 'queued', 'normalized', 'rejected', 'quarantined', 'dead')),
  received_at timestamptz not null default now(),
  normalized_at timestamptz,
  last_error_class text check (last_error_class is null or length(last_error_class) <= 128),
  attempts integer not null default 0 check (attempts >= 0),
  unique (connector_installation_id, provider_event_id),
  check (num_nonnulls(raw_content_ref_id, bounded_body) = 1)
);

create index ingress_receipts_processing
  on avalon_private.ingress_receipts (state, received_at, id)
  where state in ('accepted', 'queued');

create table avalon_private.ingress_receipt_conflicts (
  id uuid primary key default avalon_private.uuid_v7(),
  canonical_receipt_id uuid not null references avalon_private.ingress_receipts(id) on delete cascade,
  conflicting_body_hash bytea not null check (octet_length(conflicting_body_hash) = 32),
  byte_size bigint not null check (byte_size >= 0),
  raw_content_ref_id uuid references avalon_private.content_refs(id),
  bounded_body bytea check (bounded_body is null or octet_length(bounded_body) <= 65536),
  signature_version text not null,
  provider_received_at timestamptz,
  state text not null default 'quarantined' check (state in ('quarantined', 'reviewed', 'discarded')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid,
  unique (canonical_receipt_id, conflicting_body_hash),
  check (num_nonnulls(raw_content_ref_id, bounded_body) = 1)
);

create table avalon_private.activity_events (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  installation_id uuid not null references avalon_private.connector_installations(id) on delete cascade,
  receipt_id uuid not null references avalon_private.ingress_receipts(id) on delete restrict,
  event_seq bigint not null default nextval('avalon_private.activity_event_sequence'),
  event_kind text not null check (length(event_kind) between 1 and 128),
  actor_kind text not null check (length(actor_kind) between 1 and 64),
  actor_ref text check (actor_ref is null or length(actor_ref) <= 1024),
  object_kind text not null check (length(object_kind) between 1 and 128),
  object_ref text not null check (length(object_ref) between 1 and 1024),
  provider_occurred_at timestamptz,
  ingested_at timestamptz not null default now(),
  normalized_payload jsonb not null check (pg_column_size(normalized_payload) <= 65536),
  content_ref_id uuid references avalon_private.content_refs(id),
  access_container_kind text not null check (access_container_kind in ('workspace', 'connector_resource')),
  access_container_id uuid not null,
  access_revision bigint not null check (access_revision > 0),
  source_version text not null check (length(source_version) between 1 and 256),
  parser_version text not null check (length(parser_version) between 1 and 128),
  supersedes_event_id uuid references avalon_private.activity_events(id),
  tombstone_for_event_id uuid references avalon_private.activity_events(id),
  content_hash bytea not null check (octet_length(content_hash) = 32),
  unique (workspace_id, event_seq),
  unique (installation_id, event_kind, object_kind, object_ref, source_version)
);

create index activity_events_time
  on avalon_private.activity_events (workspace_id, ingested_at desc, event_seq desc);
create index activity_events_object
  on avalon_private.activity_events (workspace_id, object_kind, object_ref, event_seq desc);
create index activity_events_access
  on avalon_private.activity_events (workspace_id, access_container_kind, access_container_id, access_revision, event_seq);

create table avalon_private.activity_links (
  activity_event_id uuid not null references avalon_private.activity_events(id) on delete cascade,
  target_kind text not null check (target_kind in ('user', 'workstream', 'resource', 'activity')),
  target_id uuid not null,
  relation_kind text not null check (length(relation_kind) between 1 and 64),
  created_at timestamptz not null default now(),
  primary key (activity_event_id, target_kind, target_id, relation_kind)
);

create table avalon_private.activity_cursor_state (
  installation_id uuid not null references avalon_private.connector_installations(id) on delete cascade,
  cursor_kind text not null check (length(cursor_kind) between 1 and 64),
  cursor_value text not null check (length(cursor_value) <= 2048),
  source_watermark text,
  state text not null check (state in ('active', 'backfill', 'caught_up', 'failed')),
  updated_at timestamptz not null default now(),
  primary key (installation_id, cursor_kind)
);

create table avalon_private.normalization_attempts (
  id uuid primary key default avalon_private.uuid_v7(),
  receipt_id uuid not null references avalon_private.ingress_receipts(id) on delete cascade,
  attempt_no integer not null check (attempt_no > 0),
  parser_version text not null,
  state text not null check (state in ('started', 'succeeded', 'failed', 'conflict')),
  input_hash bytea not null check (octet_length(input_hash) = 32),
  output_event_count integer not null default 0 check (output_event_count >= 0),
  output_hash bytea check (output_hash is null or octet_length(output_hash) = 32),
  error_class text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (receipt_id, attempt_no)
);

create table avalon_private.digest_schedules (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  target_user_id uuid not null,
  timezone text not null,
  cadence jsonb not null check (pg_column_size(cadence) <= 4096),
  next_due_at timestamptz not null,
  last_source_watermark bigint not null default 0 check (last_source_watermark >= 0),
  state text not null default 'active' check (state in ('active', 'paused', 'deleted')),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  unique (workspace_id, target_user_id)
);

create index digest_schedules_due
  on avalon_private.digest_schedules (next_due_at, id) where state = 'active';

create table avalon_private.digest_jobs (
  id uuid primary key default avalon_private.uuid_v7(),
  schedule_id uuid not null references avalon_private.digest_schedules(id) on delete cascade,
  source_first_seq bigint not null,
  source_last_seq bigint not null check (source_last_seq >= source_first_seq),
  workspace_access_revision bigint not null,
  prompt_version text not null,
  model_version text not null,
  state text not null default 'queued' check (state in ('queued', 'running', 'completed', 'failed', 'invalid')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (schedule_id, source_first_seq, source_last_seq, prompt_version, model_version)
);

create table avalon_private.digest_sources (
  job_id uuid not null references avalon_private.digest_jobs(id) on delete cascade,
  activity_event_id uuid not null references avalon_private.activity_events(id) on delete restrict,
  content_hash bytea not null check (octet_length(content_hash) = 32),
  primary key (job_id, activity_event_id)
);

create table avalon_private.digests (
  id uuid primary key default avalon_private.uuid_v7(),
  job_id uuid not null unique references avalon_private.digest_jobs(id) on delete cascade,
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  target_user_id uuid not null,
  access_container_kind text not null check (access_container_kind in ('workspace', 'connector_resource')),
  access_container_id uuid not null,
  access_revision bigint not null,
  inline_text text check (inline_text is null or octet_length(inline_text) <= 262144),
  content_ref_id uuid references avalon_private.content_refs(id),
  content_hash bytea not null check (octet_length(content_hash) = 32),
  revision bigint not null check (revision > 0),
  state text not null check (state in ('ready', 'delivered', 'invalidated', 'expired')),
  delivered_effect_id uuid references avalon_private.tool_effects(id),
  created_at timestamptz not null default now(),
  invalidated_at timestamptz,
  check (num_nonnulls(inline_text, content_ref_id) = 1)
);

create table avalon_private.suggestions (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  kind text not null check (kind in ('workstream', 'action')),
  target_user_id uuid,
  access_container_kind text check (access_container_kind is null or access_container_kind in ('workspace', 'workstream', 'substream', 'connector_resource')),
  access_container_id uuid,
  target_workstream_id uuid references avalon_private.workstreams(id),
  title text not null check (length(title) between 1 and 256),
  summary text not null check (length(summary) <= 4096),
  action_kind text check (action_kind is null or length(action_kind) <= 128),
  action_payload_ref_id uuid references avalon_private.content_refs(id),
  detector_version text not null,
  model_version text not null,
  prompt_version text not null,
  semantic_key text not null check (length(semantic_key) between 1 and 512),
  score numeric(8, 6) not null check (score between 0 and 1),
  explanation_ref_id uuid references avalon_private.content_refs(id),
  source_watermark bigint not null check (source_watermark >= 0),
  access_revision bigint not null check (access_revision > 0),
  scope_revision bigint not null check (scope_revision > 0),
  state text not null default 'proposed' check (state in ('proposed', 'shown', 'accepted', 'dismissed', 'expired', 'invalidated')),
  accepted_workstream_id uuid references avalon_private.workstreams(id),
  accepted_run_id uuid references avalon_private.agent_runs(id),
  accepted_effect_id uuid references avalon_private.tool_effects(id),
  created_at timestamptz not null default now(),
  shown_at timestamptz,
  decided_at timestamptz,
  expires_at timestamptz not null,
  unique nulls not distinct (workspace_id, kind, target_user_id, semantic_key),
  check ((kind = 'action') = (target_workstream_id is not null)),
  check ((access_container_kind is null) = (access_container_id is null))
);

create index suggestions_personal_rank
  on avalon_private.suggestions (workspace_id, target_user_id, state, score desc, created_at desc, id);
create index suggestions_expiry
  on avalon_private.suggestions (expires_at, id) where state in ('proposed', 'shown');

create table avalon_private.suggestion_sources (
  suggestion_id uuid not null references avalon_private.suggestions(id) on delete cascade,
  activity_event_id uuid not null references avalon_private.activity_events(id) on delete restrict,
  source_revision bigint not null,
  content_hash bytea not null check (octet_length(content_hash) = 32),
  primary key (suggestion_id, activity_event_id)
);

create table avalon_private.suggestion_feedback (
  suggestion_id uuid not null references avalon_private.suggestions(id) on delete cascade,
  platform_user_id uuid not null,
  decision text not null check (decision in ('shown', 'accepted', 'dismissed')),
  reason_code text check (reason_code is null or length(reason_code) <= 128),
  created_at timestamptz not null default now(),
  primary key (suggestion_id, platform_user_id, decision)
);

create table avalon_private.content_search_documents (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  source_kind text not null,
  source_id uuid not null,
  source_revision bigint not null,
  access_container_kind text not null check (access_container_kind in ('workspace', 'workstream', 'substream', 'connector_resource')),
  access_container_id uuid not null,
  access_revision bigint not null,
  scope_revision bigint not null,
  title text not null check (octet_length(title) <= 8192),
  body text not null check (octet_length(body) <= 1048576),
  search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) stored,
  content_hash bytea not null check (octet_length(content_hash) = 32),
  state text not null check (state in ('active', 'invalid', 'deleted')),
  created_at timestamptz not null default now(),
  invalidated_at timestamptz,
  unique (workspace_id, source_kind, source_id, source_revision)
);

create index content_search_documents_fts
  on avalon_private.content_search_documents using gin (search_vector)
  where state = 'active';
create index content_search_documents_access
  on avalon_private.content_search_documents (workspace_id, access_container_kind, access_container_id, access_revision)
  where state = 'active';

create table avalon_private.content_embeddings (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  source_kind text not null,
  source_id uuid not null,
  source_revision bigint not null,
  chunk_no integer not null check (chunk_no >= 0),
  model text not null,
  model_version text not null,
  dimensions integer not null check (dimensions = 1536),
  embedding extensions.halfvec(1536) not null,
  content_hash bytea not null check (octet_length(content_hash) = 32),
  access_container_kind text not null check (access_container_kind in ('workspace', 'workstream', 'substream', 'connector_resource')),
  access_container_id uuid not null,
  access_revision bigint not null,
  scope_revision bigint not null,
  state text not null check (state in ('active', 'invalid', 'deleted')),
  created_at timestamptz not null default now(),
  invalidated_at timestamptz,
  unique (workspace_id, source_kind, source_id, source_revision, chunk_no, model, model_version, content_hash)
);

create index content_embeddings_hnsw
  on avalon_private.content_embeddings using hnsw (embedding halfvec_cosine_ops)
  with (m = 16, ef_construction = 64)
  where state = 'active';
create index content_embeddings_access
  on avalon_private.content_embeddings (workspace_id, access_container_kind, access_container_id, access_revision)
  where state = 'active';

create table avalon_private.migration_campaigns (
  id uuid primary key default avalon_private.uuid_v7(),
  kind text not null check (kind in ('schema_backfill', 'd1_import', 'reindex', 'repair')),
  target_version text not null,
  region_key text not null,
  state text not null default 'draft' check (state in ('draft', 'running', 'paused', 'validating', 'completed', 'failed', 'cancelled')),
  code_version text not null,
  schema_min_version bigint not null,
  schema_target_version bigint not null check (schema_target_version >= schema_min_version),
  selection_predicate jsonb not null default '{}'::jsonb check (pg_column_size(selection_predicate) <= 8192),
  concurrency_limit integer not null check (concurrency_limit > 0),
  batch_size integer not null check (batch_size > 0),
  total_estimate bigint not null default 0,
  claimed_count bigint not null default 0,
  success_count bigint not null default 0,
  error_count bigint not null default 0,
  invariant_version text,
  expected_hash bytea check (expected_hash is null or octet_length(expected_hash) = 32),
  pause_epoch bigint not null default 1 check (pause_epoch > 0),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create table avalon_private.migration_jobs (
  id uuid primary key default avalon_private.uuid_v7(),
  campaign_id uuid not null references avalon_private.migration_campaigns(id) on delete cascade,
  workspace_id uuid references avalon_private.workspaces(id) on delete cascade,
  target_kind text not null,
  target_start text,
  target_end text,
  expected_source_revision bigint,
  state text not null default 'queued' check (state in ('queued', 'running', 'completed', 'failed', 'quarantined')),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  campaign_pause_epoch bigint not null,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  input_count bigint not null default 0,
  output_count bigint not null default 0,
  input_hash bytea,
  output_hash bytea,
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index migration_jobs_claim
  on avalon_private.migration_jobs (campaign_id, state, next_attempt_at, id)
  where state in ('queued', 'running');

create table avalon_private.migration_receipts (
  campaign_id uuid not null references avalon_private.migration_campaigns(id) on delete cascade,
  semantic_target_key text not null,
  target_version text not null,
  source_hash bytea not null check (octet_length(source_hash) = 32),
  result_hash bytea not null check (octet_length(result_hash) = 32),
  row_count bigint not null check (row_count >= 0),
  committed_at timestamptz not null default now(),
  primary key (campaign_id, semantic_target_key, target_version)
);

create table avalon_private.migration_exceptions (
  id uuid primary key default avalon_private.uuid_v7(),
  campaign_id uuid not null references avalon_private.migration_campaigns(id) on delete cascade,
  job_id uuid references avalon_private.migration_jobs(id) on delete cascade,
  workspace_id uuid,
  target_ref text,
  error_class text not null,
  redacted_detail jsonb not null default '{}'::jsonb check (pg_column_size(redacted_detail) <= 8192),
  state text not null default 'open' check (state in ('open', 'resolved', 'ignored')),
  operator_id uuid,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table avalon_private.import_chunks (
  id uuid primary key default avalon_private.uuid_v7(),
  campaign_id uuid not null references avalon_private.migration_campaigns(id) on delete cascade,
  workspace_id uuid not null,
  source_system text not null check (source_system in ('d1', 'r2', 'supabase')),
  source_cursor text not null,
  content_ref_id uuid not null references avalon_private.content_refs(id),
  byte_size bigint not null,
  row_count bigint not null,
  content_hash bytea not null check (octet_length(content_hash) = 32),
  state text not null check (state in ('staged', 'loaded', 'validated', 'rejected')),
  loaded_at timestamptz,
  validated_at timestamptz,
  unique (campaign_id, workspace_id, source_cursor, content_hash)
);

create table avalon_private.import_authority_receipts (
  workspace_id uuid primary key,
  authority_epoch bigint not null check (authority_epoch > 0),
  source_closure_receipt_hash bytea not null check (octet_length(source_closure_receipt_hash) = 32),
  imported_source_cursor text not null,
  imported_row_count bigint not null,
  imported_content_hash bytea not null check (octet_length(imported_content_hash) = 32),
  state text not null check (state in ('prepared', 'verified', 'active')),
  verified_at timestamptz,
  activated_at timestamptz
);

create table avalon_private.export_jobs (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  requested_by uuid not null,
  workspace_access_revision bigint not null,
  source_fence jsonb not null check (pg_column_size(source_fence) <= 8192),
  state text not null default 'queued' check (state in ('queued', 'running', 'ready', 'failed', 'expired', 'revoked')),
  manifest_content_ref_id uuid references avalon_private.content_refs(id),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table avalon_private.export_chunks (
  job_id uuid not null references avalon_private.export_jobs(id) on delete cascade,
  chunk_no integer not null check (chunk_no >= 0),
  source_kind text not null,
  source_range jsonb not null check (pg_column_size(source_range) <= 8192),
  content_ref_id uuid not null references avalon_private.content_refs(id),
  content_hash bytea not null check (octet_length(content_hash) = 32),
  byte_size bigint not null,
  state text not null check (state in ('pending', 'ready', 'failed')),
  primary key (job_id, chunk_no)
);

create table avalon_private.deletion_jobs (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null,
  phase text not null check (phase in ('admission', 'database', 'storage', 'search', 'export', 'provider', 'verify')),
  target_kind text not null,
  target_cursor text,
  state text not null default 'queued' check (state in ('queued', 'running', 'completed', 'failed', 'held')),
  legal_hold_state text not null default 'none' check (legal_hold_state in ('none', 'held')),
  deadline_at timestamptz not null,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table avalon_private.deletion_receipts (
  workspace_id uuid not null,
  target_kind text not null,
  target_key_hash bytea not null check (octet_length(target_key_hash) = 32),
  deletion_version text not null,
  result text not null check (result in ('deleted', 'absent', 'expired', 'held')),
  verified_at timestamptz not null default now(),
  primary key (workspace_id, target_kind, target_key_hash, deletion_version)
);

create table avalon_private.product_audit_events (
  id bigint generated always as identity primary key,
  workspace_id uuid,
  actor_kind text not null check (actor_kind in ('user', 'workflow', 'connector', 'system', 'operator')),
  actor_id uuid,
  action text not null check (length(action) between 1 and 128),
  target_kind text not null check (length(target_kind) between 1 and 64),
  target_id uuid,
  access_container_kind text,
  access_container_id uuid,
  access_revision bigint,
  decision text check (decision is null or decision in ('allowed', 'denied', 'not_applicable')),
  request_id text check (request_id is null or length(request_id) <= 256),
  operation_key text check (operation_key is null or length(operation_key) <= 256),
  source_ip_hash bytea check (source_ip_hash is null or octet_length(source_ip_hash) = 32),
  detail jsonb not null default '{}'::jsonb check (pg_column_size(detail) <= 8192),
  created_at timestamptz not null default now()
);

create index product_audit_tenant_time
  on avalon_private.product_audit_events (workspace_id, created_at desc, id);
create index product_audit_actor_time
  on avalon_private.product_audit_events (actor_kind, actor_id, created_at desc, id);
create index product_audit_target
  on avalon_private.product_audit_events (target_kind, target_id, created_at desc, id);
