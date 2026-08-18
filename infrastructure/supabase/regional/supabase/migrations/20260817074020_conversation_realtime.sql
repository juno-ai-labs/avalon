-- Conversation normalization, resumable output, compaction, and durable events.

create table avalon_private.substreams (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  workstream_id uuid not null references avalon_private.workstreams(id) on delete cascade,
  kind text not null check (kind in (
    'main', 'private_chat', 'human_fork', 'subagent_fresh',
    'subagent_fork', 'document_chat'
  )),
  parent_substream_id uuid references avalon_private.substreams(id),
  base_seq bigint check (base_seq is null or base_seq >= 0),
  inheritance_mode text not null default 'none' check (inheritance_mode in ('none', 'frozen', 'document_version')),
  access_mode text not null default 'inherit_workstream' check (access_mode in ('inherit_workstream', 'restricted')),
  resource_id uuid,
  resource_revision bigint check (resource_revision is null or resource_revision > 0),
  scope_revision bigint not null default 1 check (scope_revision > 0),
  access_revision bigint not null default 1 check (access_revision > 0),
  depth smallint not null default 0 check (depth between 0 and 4),
  state text not null default 'active' check (state in ('active', 'completed', 'abandoned', 'deleted')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, workstream_id, id),
  check (
    (kind = 'main' and parent_substream_id is null and inheritance_mode = 'none'
      and base_seq is null and access_mode = 'inherit_workstream' and depth = 0)
    or (kind = 'subagent_fresh' and parent_substream_id is null
      and inheritance_mode = 'none' and base_seq is null
      and access_mode = 'restricted' and depth = 0)
    or (kind in ('private_chat', 'human_fork', 'subagent_fork')
      and parent_substream_id is not null and inheritance_mode = 'frozen'
      and base_seq is not null and access_mode = 'restricted')
    or (kind = 'document_chat' and parent_substream_id is not null
      and inheritance_mode in ('frozen', 'document_version') and base_seq is not null
      and resource_id is not null and resource_revision is not null
      and access_mode = 'restricted')
  )
);

create unique index substreams_one_main
  on avalon_private.substreams (workstream_id)
  where kind = 'main' and state <> 'deleted';
create index substreams_lineage
  on avalon_private.substreams (workstream_id, parent_substream_id, id);
create index substreams_resource
  on avalon_private.substreams (workspace_id, resource_id, resource_revision)
  where resource_id is not null;

alter table avalon_private.workstreams
  add constraint workstreams_root_substream_fk
  foreign key (root_substream_id) references avalon_private.substreams(id);

create table avalon_private.substream_access (
  substream_id uuid not null references avalon_private.substreams(id) on delete cascade,
  platform_user_id uuid not null,
  capability text not null check (capability in ('view', 'contribute', 'administer')),
  state text not null default 'active' check (state in ('active', 'revoked')),
  granted_by uuid not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (substream_id, platform_user_id)
);

create index substream_access_by_user
  on avalon_private.substream_access (platform_user_id, state, substream_id);

create table avalon_private.turns (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  workstream_id uuid not null references avalon_private.workstreams(id) on delete cascade,
  substream_id uuid not null references avalon_private.substreams(id) on delete cascade,
  kind text not null check (kind in ('user', 'agent', 'tool_exchange', 'control')),
  first_seq bigint check (first_seq is null or first_seq > 0),
  last_seq bigint check (last_seq is null or last_seq >= first_seq),
  admission_ordinal bigint check (admission_ordinal is null or admission_ordinal > 0),
  status text not null default 'open' check (status in ('open', 'complete', 'superseded', 'redacted')),
  run_id uuid,
  action_id uuid,
  admission_batch_id uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, workstream_id, substream_id, id),
  check ((status = 'open') = (completed_at is null))
);

create unique index turns_admission_order
  on avalon_private.turns (substream_id, admission_ordinal)
  where admission_ordinal is not null;
create index turns_by_substream
  on avalon_private.turns (substream_id, first_seq, id);
create index turns_by_run
  on avalon_private.turns (run_id, id) where run_id is not null;

create table avalon_private.conversation_parts (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  workstream_id uuid not null references avalon_private.workstreams(id) on delete cascade,
  substream_id uuid not null references avalon_private.substreams(id) on delete cascade,
  turn_id uuid not null references avalon_private.turns(id) on delete cascade,
  seq bigint not null check (seq > 0),
  ordinal_in_turn smallint not null check (ordinal_in_turn >= 0),
  role text not null check (role in ('system', 'user', 'assistant', 'tool')),
  kind text not null check (kind in ('text', 'tool_call', 'tool_result', 'attachment', 'terminal', 'summary', 'control', 'error', 'citation')),
  author_kind text not null check (author_kind in ('human', 'agent', 'subagent', 'connector', 'system', 'tool')),
  author_id uuid,
  inline_text text check (inline_text is null or octet_length(inline_text) <= 262144),
  content_ref_id uuid,
  structured_payload jsonb check (structured_payload is null or pg_column_size(structured_payload) <= 65536),
  provider_call_id text check (provider_call_id is null or length(provider_call_id) <= 512),
  related_part_id uuid references avalon_private.conversation_parts(id),
  content_hash bytea not null check (octet_length(content_hash) = 32),
  source_operation_key text check (source_operation_key is null or length(source_operation_key) <= 256),
  created_at timestamptz not null default now(),
  sealed_at timestamptz not null default now(),
  redacted_by_part_id uuid references avalon_private.conversation_parts(id),
  unique (workstream_id, seq),
  unique (turn_id, ordinal_in_turn),
  check (num_nonnulls(inline_text, content_ref_id, structured_payload) = 1)
);

create index conversation_parts_substream_range
  on avalon_private.conversation_parts (substream_id, seq, id);
create index conversation_parts_turn
  on avalon_private.conversation_parts (turn_id, ordinal_in_turn);
create unique index conversation_parts_source_operation
  on avalon_private.conversation_parts (workstream_id, source_operation_key)
  where source_operation_key is not null;
create unique index conversation_parts_provider_call
  on avalon_private.conversation_parts (workstream_id, provider_call_id, kind)
  where provider_call_id is not null and kind in ('tool_call', 'tool_result');

alter table avalon_private.part_mentions
  add constraint part_mentions_part_fk
  foreign key (part_id) references avalon_private.conversation_parts(id) on delete cascade;
alter table avalon_private.part_mentions
  add constraint part_mentions_substream_fk
  foreign key (substream_id) references avalon_private.substreams(id) on delete cascade;
alter table avalon_private.workstream_attention_events
  add constraint workstream_attention_part_fk
  foreign key (part_id) references avalon_private.conversation_parts(id) on delete cascade;

create table avalon_private.input_admission_batches (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  workstream_id uuid not null references avalon_private.workstreams(id) on delete cascade,
  substream_id uuid not null references avalon_private.substreams(id) on delete cascade,
  first_seq bigint not null check (first_seq > 0),
  last_seq bigint not null check (last_seq >= first_seq),
  mode text not null check (mode in ('queue', 'steer', 'system')),
  control_revision bigint not null check (control_revision > 0),
  run_id uuid,
  state text not null default 'pending' check (state in ('pending', 'admitted', 'superseded', 'cancelled')),
  interrupt_requested_at timestamptz,
  requested_boundary text check (requested_boundary is null or requested_boundary in (
    'after_current_semantic_action', 'after_model', 'after_tool', 'after_terminal_checkpoint'
  )),
  created_at timestamptz not null default now(),
  admitted_at timestamptz,
  check ((mode = 'steer') = (interrupt_requested_at is not null)),
  check ((mode = 'steer') = (requested_boundary is not null))
);

create index input_admission_pending
  on avalon_private.input_admission_batches (workstream_id, state, created_at, id)
  where state = 'pending';

create table avalon_private.input_admission_batch_turns (
  batch_id uuid not null references avalon_private.input_admission_batches(id) on delete cascade,
  turn_id uuid not null references avalon_private.turns(id) on delete cascade,
  admission_ordinal bigint not null check (admission_ordinal > 0),
  primary key (batch_id, admission_ordinal),
  unique (batch_id, turn_id)
);

alter table avalon_private.turns
  add constraint turns_admission_batch_fk
  foreign key (admission_batch_id) references avalon_private.input_admission_batches(id);

create table avalon_private.active_output_attempts (
  run_id uuid not null,
  attempt_id uuid not null default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  workstream_id uuid not null references avalon_private.workstreams(id) on delete cascade,
  substream_id uuid not null references avalon_private.substreams(id) on delete cascade,
  turn_id uuid not null references avalon_private.turns(id) on delete cascade,
  part_id uuid not null unique,
  control_revision bigint not null check (control_revision > 0),
  reserved_seq bigint not null check (reserved_seq > 0),
  status text not null default 'streaming' check (status in ('streaming', 'sealing', 'sealed', 'superseded')),
  created_at timestamptz not null default now(),
  sealed_at timestamptz,
  expires_at timestamptz not null,
  final_checkpoint_revision bigint check (final_checkpoint_revision is null or final_checkpoint_revision >= 0),
  final_byte_offset bigint check (final_byte_offset is null or final_byte_offset >= 0),
  final_content_hash bytea check (final_content_hash is null or octet_length(final_content_hash) = 32),
  terminal_content_ref_id uuid,
  primary key (run_id, attempt_id)
);

create unique index active_output_one_winner
  on avalon_private.active_output_attempts (run_id, turn_id)
  where status in ('streaming', 'sealing');
create index active_output_expiry
  on avalon_private.active_output_attempts (expires_at, run_id, attempt_id)
  where status in ('streaming', 'superseded');

create table avalon_private.active_output_chunks (
  run_id uuid not null,
  attempt_id uuid not null,
  chunk_index integer not null check (chunk_index >= 0),
  byte_start bigint not null check (byte_start >= 0),
  byte_end bigint not null check (byte_end >= byte_start),
  checkpoint_revision bigint not null check (checkpoint_revision >= 0),
  first_frame_seq bigint not null check (first_frame_seq >= 0),
  through_frame_seq bigint not null check (through_frame_seq >= first_frame_seq),
  token_estimate_through bigint not null default 0 check (token_estimate_through >= 0),
  text_buffer text not null check (octet_length(text_buffer) <= 16384),
  chunk_hash bytea not null check (octet_length(chunk_hash) = 32),
  attempt_hash_through bytea not null check (octet_length(attempt_hash_through) = 32),
  provider_cursor jsonb check (provider_cursor is null or pg_column_size(provider_cursor) <= 4096),
  status text not null check (status in ('open', 'sealed', 'abandoned')),
  checkpointed_at timestamptz not null default now(),
  primary key (run_id, attempt_id, chunk_index),
  foreign key (run_id, attempt_id)
    references avalon_private.active_output_attempts(run_id, attempt_id) on delete cascade
);

create unique index active_output_one_open_chunk
  on avalon_private.active_output_chunks (run_id, attempt_id)
  where status = 'open';
create index active_output_chunks_by_offset
  on avalon_private.active_output_chunks (run_id, attempt_id, byte_start);

create table avalon_private.compaction_jobs (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  workstream_id uuid not null references avalon_private.workstreams(id) on delete cascade,
  substream_id uuid not null references avalon_private.substreams(id) on delete cascade,
  first_seq bigint not null check (first_seq > 0),
  last_seq bigint not null check (last_seq >= first_seq),
  source_merkle_hash bytea not null check (octet_length(source_merkle_hash) = 32),
  workspace_access_revision bigint not null check (workspace_access_revision > 0),
  workstream_access_revision bigint not null check (workstream_access_revision > 0),
  substream_access_revision bigint not null check (substream_access_revision > 0),
  resource_access_revision bigint,
  scope_revision bigint not null check (scope_revision > 0),
  format_version text not null,
  model text not null,
  model_version text not null,
  prompt_version text not null,
  compaction_key text not null unique check (length(compaction_key) between 1 and 512),
  state text not null default 'queued' check (state in ('queued', 'running', 'ready', 'invalid', 'failed')),
  summary_part_id uuid unique references avalon_private.conversation_parts(id),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (last_error is null or length(last_error) <= 512),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table avalon_private.compaction_sources (
  job_id uuid not null references avalon_private.compaction_jobs(id) on delete cascade,
  part_id uuid not null references avalon_private.conversation_parts(id) on delete restrict,
  seq bigint not null,
  content_hash bytea not null check (octet_length(content_hash) = 32),
  primary key (job_id, seq),
  unique (job_id, part_id)
);

create table avalon_private.substream_promotions (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  workstream_id uuid not null references avalon_private.workstreams(id) on delete cascade,
  source_substream_id uuid not null references avalon_private.substreams(id),
  target_substream_id uuid not null references avalon_private.substreams(id),
  source_first_seq bigint not null check (source_first_seq > 0),
  source_last_seq bigint not null check (source_last_seq >= source_first_seq),
  source_scope_revision bigint not null,
  source_access_revision bigint not null,
  target_access_revision bigint not null,
  promoted_part_id uuid not null unique references avalon_private.conversation_parts(id),
  content_hash bytea not null check (octet_length(content_hash) = 32),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  check (source_substream_id <> target_substream_id)
);

create table avalon_private.workspace_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  workspace_seq bigint not null default nextval('avalon_private.workspace_event_sequence'),
  kind text not null check (length(kind) between 1 and 64),
  subject_kind text not null check (length(subject_kind) between 1 and 64),
  subject_id uuid,
  common_revision bigint,
  user_revision bigint,
  target_user_id uuid,
  access_container_kind text check (access_container_kind is null or access_container_kind in ('workspace', 'workstream', 'substream', 'connector_resource')),
  access_container_id uuid,
  access_revision bigint,
  payload jsonb not null default '{}'::jsonb check (pg_column_size(payload) <= 16384),
  created_at timestamptz not null default now(),
  unique (workspace_id, workspace_seq),
  check ((access_container_kind is null) = (access_container_id is null)),
  check ((access_container_kind is null) = (access_revision is null))
);

create index workspace_events_catchup
  on avalon_private.workspace_events (workspace_id, workspace_seq, target_user_id);
create index workspace_events_retention
  on avalon_private.workspace_events (created_at, id);

create table avalon_private.workstream_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  workstream_id uuid not null references avalon_private.workstreams(id) on delete cascade,
  workstream_seq bigint not null check (workstream_seq > 0),
  kind text not null check (length(kind) between 1 and 64),
  run_id uuid,
  attempt_id uuid,
  part_id uuid references avalon_private.conversation_parts(id),
  byte_offset bigint check (byte_offset is null or byte_offset >= 0),
  target_user_id uuid,
  common_revision bigint,
  user_revision bigint,
  access_container_kind text not null check (access_container_kind in ('workspace', 'workstream', 'substream', 'connector_resource')),
  access_container_id uuid not null,
  access_revision bigint not null check (access_revision > 0),
  payload jsonb not null default '{}'::jsonb check (pg_column_size(payload) <= 16384),
  created_at timestamptz not null default now(),
  unique (workstream_id, workstream_seq)
);

create index workstream_events_catchup
  on avalon_private.workstream_events (workstream_id, workstream_seq, target_user_id);
create index workstream_events_access
  on avalon_private.workstream_events (access_container_kind, access_container_id, access_revision, workstream_seq);
create index workstream_events_retention
  on avalon_private.workstream_events (created_at, id);

create table avalon_private.command_receipts (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  workstream_id uuid references avalon_private.workstreams(id) on delete cascade,
  actor_id uuid not null,
  operation_key text not null check (length(operation_key) between 1 and 256),
  operation_kind text not null check (length(operation_kind) between 1 and 128),
  request_hash bytea not null check (octet_length(request_hash) = 32),
  state text not null default 'started' check (state in ('started', 'completed', 'rejected')),
  result_kind text check (result_kind is null or length(result_kind) <= 64),
  result_id uuid,
  result_revision bigint,
  result_payload jsonb check (result_payload is null or pg_column_size(result_payload) <= 16384),
  error_code text check (error_code is null or length(error_code) <= 128),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null,
  unique (workspace_id, actor_id, operation_key)
);

create index command_receipts_workstream_expiry
  on avalon_private.command_receipts (workspace_id, workstream_id, expires_at)
  where workstream_id is not null;

create table avalon_private.queue_inbox_receipts (
  queue_name text not null,
  semantic_key text not null,
  message_id bigint,
  request_hash bytea not null check (octet_length(request_hash) = 32),
  state text not null check (state in ('started', 'completed', 'failed', 'quarantined')),
  claim_token uuid,
  lease_expires_at timestamptz,
  result_ref uuid,
  attempts integer not null default 1 check (attempts > 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check ((state = 'started') = (claim_token is not null and lease_expires_at is not null)),
  primary key (queue_name, semantic_key)
);

create table avalon_private.outbox_messages (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  destination_kind text not null check (length(destination_kind) between 1 and 64),
  destination_ref text not null check (length(destination_ref) between 1 and 512),
  operation_key text not null check (length(operation_key) between 1 and 256),
  payload_ref uuid not null,
  state text not null default 'pending' check (state in ('pending', 'delivering', 'delivered', 'failed', 'quarantined')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text check (last_error is null or length(last_error) <= 512),
  created_at timestamptz not null default now(),
  unique (workspace_id, destination_kind, operation_key)
);

create index outbox_messages_due
  on avalon_private.outbox_messages (state, next_attempt_at, id)
  where state in ('pending', 'delivering');

create table avalon_private.dead_letters (
  id uuid primary key default avalon_private.uuid_v7(),
  source_queue text not null,
  semantic_key text not null,
  message_snapshot jsonb not null check (pg_column_size(message_snapshot) <= 16384),
  error_class text not null check (length(error_class) between 1 and 128),
  attempts integer not null check (attempts > 0),
  quarantined_at timestamptz not null default now(),
  replayed_at timestamptz,
  operator_id uuid,
  unique (source_queue, semantic_key)
);

create or replace function avalon_private.assign_turn_admission(p_turn_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  target avalon_private.turns%rowtype;
  next_ordinal bigint;
begin
  select * into target from avalon_private.turns where id = p_turn_id for update;
  if not found or target.status <> 'complete' then
    raise exception using errcode = '40001', message = 'only a complete turn can be admitted';
  end if;
  if target.admission_ordinal is not null then return target.admission_ordinal; end if;
  perform 1 from avalon_private.substreams where id = target.substream_id for update;
  select coalesce(max(admission_ordinal), 0) + 1 into next_ordinal
  from avalon_private.turns where substream_id = target.substream_id;
  update avalon_private.turns set admission_ordinal = next_ordinal where id = target.id;
  return next_ordinal;
end
$$;

create or replace function avalon_private.admit_batch_turns(p_batch_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  batch avalon_private.input_admission_batches%rowtype;
  batch_turn record;
  admitted_count bigint := 0;
begin
  select * into batch from avalon_private.input_admission_batches
  where id = p_batch_id for update;
  if not found or batch.state <> 'admitted' then
    raise exception using errcode = '40001', message = 'batch is not admitted';
  end if;
  for batch_turn in
    select membership.turn_id
    from avalon_private.input_admission_batch_turns membership
    where membership.batch_id = batch.id
    order by membership.admission_ordinal
  loop
    perform avalon_private.assign_turn_admission(batch_turn.turn_id);
    admitted_count := admitted_count + 1;
  end loop;
  return admitted_count;
end
$$;

revoke all on function avalon_private.assign_turn_admission(uuid) from public;
revoke all on function avalon_private.admit_batch_turns(uuid) from public;

create or replace function avalon_private.can_access_substream(
  p_substream_id uuid,
  p_capability text default 'view'
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from avalon_private.substreams substream
    where substream.id = p_substream_id
      and substream.state <> 'deleted'
      and avalon_private.can_access_workstream(substream.workstream_id, p_capability)
      and (
        substream.access_mode = 'inherit_workstream'
        or exists (
          select 1
          from avalon_private.substream_access access
          where access.substream_id = substream.id
            and access.platform_user_id = avalon_private.current_platform_user_id()
            and access.state = 'active'
            and case p_capability
              when 'administer' then access.capability = 'administer'
              when 'contribute' then access.capability in ('contribute', 'administer')
              else access.capability in ('view', 'contribute', 'administer')
            end
        )
      )
  )
$$;

create or replace function avalon_private.safe_realtime_send(
  p_payload jsonb,
  p_event text,
  p_topic text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_column_size(p_payload) > 196608
     or length(p_event) not between 1 and 128
     or length(p_topic) not between 1 and 512 then
    raise exception using errcode = '22023', message = 'realtime envelope exceeds application bounds';
  end if;
  begin
    perform realtime.send(p_payload, p_event, p_topic, true);
    return true;
  exception
    when others then
      return false;
  end;
end
$$;

revoke all on function avalon_private.can_access_substream(uuid, text) from public;
revoke all on function avalon_private.safe_realtime_send(jsonb, text, text) from public;
grant execute on function avalon_private.can_access_substream(uuid, text) to authenticated;
