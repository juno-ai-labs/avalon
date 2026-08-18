-- Executable product commands that keep Cloudflare Workers and Workflows on a
-- narrow, fenced RPC surface. Canonical content remains in Postgres/Storage;
-- callers receive only the state they are authorized to act on.

create or replace function avalon_private.workflow_materialize_run(
  p_run_id uuid,
  p_expected_control_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  run avalon_private.agent_runs%rowtype;
  workspace avalon_private.workspaces%rowtype;
  workstream avalon_private.workstreams%rowtype;
  substream avalon_private.substreams%rowtype;
  compaction avalon_private.compaction_jobs%rowtype;
  parts jsonb;
begin
  select * into run from avalon_private.agent_runs where id = p_run_id;
  if not found or run.control_revision <> p_expected_control_revision
     or run.state not in ('running', 'interrupting', 'waiting_user', 'waiting_event', 'waiting_provider') then
    raise exception using errcode = '40001', message = 'run materialization fence mismatch';
  end if;
  if run.owner_kind <> 'workstream' or run.substream_id is null then
    raise exception using errcode = '0A000', message = 'this materializer requires a workstream owner';
  end if;

  select * into workspace from avalon_private.workspaces where id = run.workspace_id;
  select * into workstream from avalon_private.workstreams where id = run.owner_id;
  select * into substream from avalon_private.substreams where id = run.substream_id;
  if workspace.state <> 'active'
     or not exists (
       select 1 from avalon_private.workspace_route_gates gate
       where gate.workspace_id = workspace.id and gate.route_epoch = workspace.route_epoch
         and gate.authority_state = 'writable'
     )
     or workstream.state in ('completed', 'cancelled_cleanly', 'archived', 'deleting')
     or substream.state <> 'active'
     or workspace.access_revision <> run.workspace_access_revision
     or workstream.access_revision is distinct from run.workstream_access_revision
     or substream.access_revision is distinct from run.substream_access_revision
     or substream.scope_revision is distinct from run.scope_revision then
    raise exception using errcode = '42501', message = 'run authority snapshot is no longer current';
  end if;

  select job.* into compaction
  from avalon_private.compaction_jobs job
  where job.substream_id = substream.id and job.state = 'ready'
    and job.workspace_access_revision = workspace.access_revision
    and job.workstream_access_revision = workstream.access_revision
    and job.substream_access_revision = substream.access_revision
    and job.scope_revision = substream.scope_revision
    and job.resource_access_revision is not distinct from run.resource_access_revision
  order by job.last_seq desc, job.completed_at desc, job.id desc
  limit 1;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'id', part.id,
      'seq', part.seq,
      'ordinal_in_turn', part.ordinal_in_turn,
      'turn_id', part.turn_id,
      'role', part.role,
      'kind', part.kind,
      'text', part.inline_text,
      'content_ref_id', part.content_ref_id,
      'structured_payload', part.structured_payload,
      'provider_call_id', part.provider_call_id,
      'related_part_id', part.related_part_id,
      'content_hash', encode(part.content_hash, 'hex')
    )) order by
      case when compaction.id is not null and part.id = compaction.summary_part_id then 0 else 1 end,
      turn.admission_ordinal, part.ordinal_in_turn), '[]'::jsonb)
  into parts
  from avalon_private.conversation_parts part
  join avalon_private.turns turn on turn.id = part.turn_id
  where part.substream_id = substream.id
    and part.redacted_by_part_id is null
    and turn.status = 'complete'
    and turn.admission_ordinal is not null
    and (
      compaction.id is null
      or part.id = compaction.summary_part_id
      or part.seq > compaction.last_seq
    );

  return jsonb_build_object(
    'version', 1,
    'run_id', run.id,
    'workspace_id', workspace.id,
    'workstream_id', workstream.id,
    'substream_id', substream.id,
    'run_revision', run.run_revision,
    'control_revision', run.control_revision,
    'workspace_access_revision', workspace.access_revision,
    'workstream_access_revision', workstream.access_revision,
    'substream_access_revision', substream.access_revision,
    'scope_revision', substream.scope_revision,
    'model_provider', run.model_provider,
    'model_name', run.model_name,
    'execution_principal_kind', run.execution_principal_kind,
    'execution_principal_id', run.execution_principal_id,
    'provider_config_revision', run.provider_config_revision,
    'compaction', case when compaction.id is null then null else jsonb_build_object(
      'job_id', compaction.id,
      'first_seq', compaction.first_seq,
      'last_seq', compaction.last_seq,
      'summary_part_id', compaction.summary_part_id,
      'source_merkle_hash', encode(compaction.source_merkle_hash, 'hex'),
      'format_version', compaction.format_version
    ) end,
    'parts', parts
  );
end
$$;

create or replace function avalon_private.workflow_prepare_compaction(
  p_run_id uuid,
  p_expected_control_revision bigint,
  p_through_seq bigint,
  p_format_version text,
  p_model text,
  p_model_version text,
  p_prompt_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  run avalon_private.agent_runs%rowtype;
  workstream avalon_private.workstreams%rowtype;
  substream avalon_private.substreams%rowtype;
  job avalon_private.compaction_jobs%rowtype;
  first_source_seq bigint;
  source_hash bytea;
  key text;
begin
  select * into run from avalon_private.agent_runs where id = p_run_id;
  if not found or run.control_revision <> p_expected_control_revision
     or run.state <> 'running' or run.owner_kind <> 'workstream'
     or run.substream_id is null or p_through_seq < 1
     or length(p_format_version) not between 1 and 64
     or length(p_model) not between 1 and 256
     or length(p_model_version) not between 1 and 128
     or length(p_prompt_version) not between 1 and 128 then
    raise exception using errcode = '40001', message = 'compaction preparation fence mismatch';
  end if;
  select * into workstream from avalon_private.workstreams
  where id = run.owner_id and active_run_id = run.id;
  select * into substream from avalon_private.substreams where id = run.substream_id;
  if workstream.id is null or substream.id is null
     or p_through_seq > workstream.latest_seq
     or run.workspace_access_revision <> (
       select workspace.access_revision from avalon_private.workspaces workspace
       where workspace.id = run.workspace_id
     )
     or run.workstream_access_revision <> workstream.access_revision
     or run.substream_access_revision <> substream.access_revision
     or run.scope_revision <> substream.scope_revision then
    raise exception using errcode = '42501', message = 'compaction authority snapshot changed';
  end if;

  select min(part.seq), extensions.digest(convert_to(
    string_agg(encode(part.content_hash, 'hex'), ':' order by turn.admission_ordinal, part.ordinal_in_turn),
    'utf8'), 'sha256')
  into first_source_seq, source_hash
  from avalon_private.conversation_parts part
  join avalon_private.turns turn on turn.id = part.turn_id
  where part.substream_id = substream.id and part.seq <= p_through_seq
    and part.redacted_by_part_id is null and turn.status = 'complete'
    and turn.admission_ordinal is not null;
  if first_source_seq is null then
    raise exception using errcode = '22023', message = 'compaction has no admitted source';
  end if;
  key := concat_ws(':', substream.id, p_through_seq, encode(source_hash, 'hex'),
    run.workspace_access_revision, run.workstream_access_revision,
    run.substream_access_revision, coalesce(run.resource_access_revision, 0),
    run.scope_revision, p_format_version, p_model_version, p_prompt_version);
  select * into job from avalon_private.compaction_jobs where compaction_key = key for update;
  if found then
    return jsonb_build_object('job_id', job.id, 'state', job.state,
      'first_seq', job.first_seq, 'last_seq', job.last_seq,
      'source_hash', encode(job.source_merkle_hash, 'hex'));
  end if;
  insert into avalon_private.compaction_jobs (
    workspace_id, workstream_id, substream_id, first_seq, last_seq,
    source_merkle_hash, workspace_access_revision, workstream_access_revision,
    substream_access_revision, resource_access_revision, scope_revision,
    format_version, model, model_version, prompt_version, compaction_key,
    state, attempts
  ) values (
    run.workspace_id, workstream.id, substream.id, first_source_seq, p_through_seq,
    source_hash, run.workspace_access_revision, run.workstream_access_revision,
    run.substream_access_revision, run.resource_access_revision, run.scope_revision,
    p_format_version, p_model, p_model_version, p_prompt_version, key,
    'running', 1
  ) returning * into job;
  insert into avalon_private.compaction_sources (job_id, part_id, seq, content_hash)
  select job.id, part.id, part.seq, part.content_hash
  from avalon_private.conversation_parts part
  join avalon_private.turns turn on turn.id = part.turn_id
  where part.substream_id = substream.id and part.seq <= p_through_seq
    and part.redacted_by_part_id is null and turn.status = 'complete'
    and turn.admission_ordinal is not null
  order by turn.admission_ordinal, part.ordinal_in_turn;
  return jsonb_build_object('job_id', job.id, 'state', job.state,
    'first_seq', job.first_seq, 'last_seq', job.last_seq,
    'source_hash', encode(job.source_merkle_hash, 'hex'));
end
$$;

create or replace function avalon_private.workflow_finalize_compaction(
  p_run_id uuid,
  p_expected_control_revision bigint,
  p_job_id uuid,
  p_summary text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  run avalon_private.agent_runs%rowtype;
  job avalon_private.compaction_jobs%rowtype;
  workstream avalon_private.workstreams%rowtype;
  substream avalon_private.substreams%rowtype;
  new_summary_part_id uuid := avalon_private.uuid_v7();
  summary_turn_id uuid := avalon_private.uuid_v7();
  source_hash bytea;
  summary_seq bigint;
begin
  if octet_length(p_summary) not between 1 and 262144 then
    raise exception using errcode = '22023', message = 'invalid compaction summary';
  end if;
  select * into run from avalon_private.agent_runs where id = p_run_id for update;
  select * into job from avalon_private.compaction_jobs where id = p_job_id for update;
  if run.id is null or job.id is null or run.control_revision <> p_expected_control_revision
     or run.state <> 'running' or job.state not in ('running', 'ready')
     or job.workspace_id <> run.workspace_id or job.workstream_id <> run.owner_id
     or job.substream_id <> run.substream_id then
    raise exception using errcode = '40001', message = 'compaction finalization fence mismatch';
  end if;
  if job.state = 'ready' then return job.summary_part_id; end if;
  select * into workstream from avalon_private.workstreams where id = job.workstream_id for update;
  select * into substream from avalon_private.substreams where id = job.substream_id;
  if workstream.active_run_id <> run.id
     or job.workspace_access_revision <> run.workspace_access_revision
     or job.workstream_access_revision <> workstream.access_revision
     or job.substream_access_revision <> substream.access_revision
     or job.scope_revision <> substream.scope_revision
     or job.resource_access_revision is distinct from run.resource_access_revision then
    update avalon_private.compaction_jobs set state = 'invalid',
      last_error = 'authorization_snapshot_changed' where id = job.id;
    raise exception using errcode = '42501', message = 'compaction authorization changed';
  end if;
  select extensions.digest(convert_to(
    string_agg(encode(part.content_hash, 'hex'), ':' order by turn.admission_ordinal, part.ordinal_in_turn),
    'utf8'), 'sha256')
  into source_hash
  from avalon_private.compaction_sources source
  join avalon_private.conversation_parts part
    on part.id = source.part_id and part.seq = source.seq
      and part.content_hash = source.content_hash and part.redacted_by_part_id is null
  join avalon_private.turns turn on turn.id = part.turn_id and turn.status = 'complete'
  where source.job_id = job.id;
  if source_hash is distinct from job.source_merkle_hash
     or (select count(*) from avalon_private.compaction_sources where job_id = job.id)
       <> (select count(*) from avalon_private.compaction_sources source
           join avalon_private.conversation_parts part on part.id = source.part_id
             and part.seq = source.seq and part.content_hash = source.content_hash
             and part.redacted_by_part_id is null
           where source.job_id = job.id) then
    update avalon_private.compaction_jobs set state = 'invalid',
      last_error = 'source_snapshot_changed' where id = job.id;
    raise exception using errcode = '40001', message = 'compaction source changed';
  end if;
  summary_seq := workstream.next_seq;
  insert into avalon_private.turns (
    id, workspace_id, workstream_id, substream_id, kind, first_seq, last_seq,
    status, run_id, completed_at
  ) values (
    summary_turn_id, run.workspace_id, workstream.id, substream.id, 'control',
    summary_seq, summary_seq, 'complete', run.id, now()
  );
  perform avalon_private.assign_turn_admission(summary_turn_id);
  insert into avalon_private.conversation_parts (
    id, workspace_id, workstream_id, substream_id, turn_id, seq,
    ordinal_in_turn, role, kind, author_kind, inline_text, content_hash
  ) values (
    new_summary_part_id, run.workspace_id, workstream.id, substream.id,
    summary_turn_id, summary_seq, 0, 'system', 'summary', 'system', p_summary,
    extensions.digest(convert_to(p_summary, 'utf8'), 'sha256')
  );
  update avalon_private.workstreams
  set next_seq = next_seq + 1, latest_seq = summary_seq,
      revision = revision + 1, updated_at = now()
  where id = workstream.id;
  update avalon_private.compaction_jobs
  set state = 'ready', summary_part_id = new_summary_part_id,
      completed_at = now(), last_error = null
  where id = job.id;
  return new_summary_part_id;
end
$$;

create or replace function avalon_private.regional_workflow_wake_descriptor(
  p_workspace_id uuid,
  p_workstream_id uuid,
  p_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  run avalon_private.agent_runs%rowtype;
  workflow_start avalon_private.workflow_starts%rowtype;
  signals jsonb;
begin
  select candidate.* into run
  from avalon_private.agent_runs candidate
  join avalon_private.workstreams workstream
    on workstream.id = candidate.owner_id
   and candidate.owner_kind = 'workstream'
  join avalon_private.workspace_route_gates gate
    on gate.workspace_id = candidate.workspace_id
  where candidate.id = p_run_id
    and candidate.workspace_id = p_workspace_id
    and candidate.owner_id = p_workstream_id
    and workstream.workspace_id = p_workspace_id
    and gate.authority_state = 'writable'
    and candidate.state not in ('completed', 'failed', 'interrupted', 'cancelled')
  for update of candidate;
  if not found then
    raise exception using errcode = '42501', message = 'run wake descriptor denied';
  end if;
  select * into workflow_start from avalon_private.workflow_starts
  where run_id = run.id;
  select coalesce(jsonb_agg(jsonb_build_object(
      'signal_id', signal.id,
      'control_revision', signal.expected_control_revision,
      'signal_kind', signal.signal_kind
    ) order by signal.created_at, signal.id), '[]'::jsonb)
  into signals
  from avalon_private.run_signals signal
  where signal.run_id = run.id and signal.state in ('pending', 'delivered');
  return jsonb_build_object(
    'run_id', run.id,
    'workflow_instance_id', run.workflow_instance_id,
    'expected_run_revision', coalesce(workflow_start.expected_run_revision, 1),
    'state', run.state,
    'signals', signals
  );
end
$$;

create or replace function avalon_private.workspace_authority_descriptor(
  p_workspace_id uuid,
  p_expected_route_epoch bigint,
  p_source_closure_hash bytea
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace avalon_private.workspaces%rowtype;
  gate avalon_private.workspace_route_gates%rowtype;
  receipt avalon_private.import_authority_receipts%rowtype;
begin
  select * into workspace from avalon_private.workspaces where id = p_workspace_id;
  select * into gate from avalon_private.workspace_route_gates where workspace_id = p_workspace_id;
  select * into receipt from avalon_private.import_authority_receipts where workspace_id = p_workspace_id;
  if workspace.id is null or gate.workspace_id is null or receipt.workspace_id is null
     or workspace.route_epoch <> p_expected_route_epoch
     or gate.route_epoch <> p_expected_route_epoch or gate.authority_state <> 'writable'
     or gate.source_closure_hash is distinct from p_source_closure_hash
     or receipt.authority_epoch <> p_expected_route_epoch or receipt.state <> 'active'
     or receipt.source_closure_receipt_hash <> p_source_closure_hash then
    return jsonb_build_object('writable', false, 'workspace_id', p_workspace_id,
      'route_epoch', p_expected_route_epoch);
  end if;
  return jsonb_build_object('writable', true, 'workspace_id', workspace.id,
    'route_epoch', workspace.route_epoch, 'shard_id', workspace.shard_id,
    'region_key', workspace.region_key,
    'source_closure_hash', encode(p_source_closure_hash, 'hex'));
end
$$;

create or replace function avalon_private.workflow_admit_next_batch(
  p_workstream_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  workstream avalon_private.workstreams%rowtype;
  workspace avalon_private.workspaces%rowtype;
  substream avalon_private.substreams%rowtype;
  batch avalon_private.input_admission_batches%rowtype;
  new_run_id uuid := avalon_private.uuid_v7();
  instance_id text;
begin
  select * into workstream from avalon_private.workstreams
  where id = p_workstream_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'workstream not found';
  end if;
  if workstream.active_run_id is not null then
    return null;
  end if;
  select * into workspace from avalon_private.workspaces
  where id = workstream.workspace_id;
  if workspace.state <> 'active' or workstream.state in ('completed', 'cancelled_cleanly', 'archived', 'deleting') then
    return null;
  end if;

  select queued.* into batch
  from avalon_private.input_admission_batches queued
  where queued.workstream_id = workstream.id
    and queued.state = 'pending' and queued.run_id is null
  order by queued.created_at, queued.id
  limit 1
  for update skip locked;
  if not found then
    return null;
  end if;
  select * into substream from avalon_private.substreams
  where id = batch.substream_id and state = 'active';
  if not found then
    update avalon_private.input_admission_batches
    set state = 'cancelled'
    where id = batch.id;
    return null;
  end if;

  instance_id := 'workstream/' || workstream.id::text || '/run/' || new_run_id::text;
  insert into avalon_private.agent_runs (
    id, workspace_id, owner_kind, owner_id,
    execution_principal_kind, execution_principal_id, substream_id,
    admission_batch_id, workspace_access_revision,
    workstream_access_revision, substream_access_revision, scope_revision,
    workflow_instance_id, workflow_version, model_provider, model_name,
    provider_config_revision
  ) values (
    new_run_id, workspace.id, 'workstream', workstream.id,
    'user', (
      select part.author_id
      from avalon_private.input_admission_batch_turns batch_turn
      join avalon_private.conversation_parts part on part.turn_id = batch_turn.turn_id
      where batch_turn.batch_id = batch.id and part.author_kind = 'human'
      order by batch_turn.admission_ordinal, part.ordinal_in_turn
      limit 1
    ),
    substream.id, batch.id, workspace.access_revision, workstream.access_revision,
    substream.access_revision, substream.scope_revision,
    instance_id, 'postgres-v1', 'openrouter', 'runtime-selected', 1
  );
  update avalon_private.input_admission_batches
  set run_id = new_run_id, state = 'admitted', admitted_at = now(),
      control_revision = 1
  where id = batch.id;
  update avalon_private.turns
  set run_id = new_run_id
  where admission_batch_id = batch.id;
  perform avalon_private.admit_batch_turns(batch.id);
  insert into avalon_private.workflow_starts (
    run_id, workflow_instance_id, expected_run_revision
  ) values (new_run_id, instance_id, 1);
  perform pgmq.send('workflow_starts', jsonb_build_object(
    'version', 1, 'run_id', new_run_id,
    'workflow_instance_id', instance_id, 'expected_run_revision', 1
  ));
  update avalon_private.workstreams
  set active_run_id = new_run_id, revision = revision + 1,
      state = 'running', state_reason = null, error_at = null,
      updated_at = now()
  where id = workstream.id;
  update avalon_private.workstream_cards
  set exact_state = 'running', lifecycle_family = 'in_progress',
      state_reason = null, error_at = null,
      active_run_summary = jsonb_build_object(
        'run_id', new_run_id, 'state', 'admitted', 'queued_input', false
      ),
      common_revision = common_revision + 1
  where workstream_id = workstream.id;
  return jsonb_build_object(
    'run_id', new_run_id,
    'workflow_instance_id', instance_id,
    'expected_run_revision', 1,
    'admission_batch_id', batch.id
  );
end
$$;

create or replace function avalon_private.workflow_finish_run(
  p_run_id uuid,
  p_expected_control_revision bigint,
  p_outcome text,
  p_terminal_reason text default null,
  p_error_class text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  run avalon_private.agent_runs%rowtype;
  next_run jsonb;
  terminal boolean;
  next_state text;
begin
  if p_outcome not in ('completed', 'waiting_user', 'waiting_event', 'waiting_provider', 'failed', 'interrupted', 'cancelled')
     or (p_terminal_reason is not null and length(p_terminal_reason) > 128)
     or (p_error_class is not null and length(p_error_class) > 128) then
    raise exception using errcode = '22023', message = 'invalid run outcome';
  end if;
  select * into run from avalon_private.agent_runs where id = p_run_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'run not found';
  end if;
  terminal := p_outcome in ('completed', 'failed', 'interrupted', 'cancelled');
  if run.state in ('completed', 'failed', 'interrupted', 'cancelled') then
    if run.state <> p_outcome then
      raise exception using errcode = '40001', message = 'run already has a different terminal outcome';
    end if;
  elsif run.control_revision <> p_expected_control_revision then
    raise exception using errcode = '40001', message = 'run completion fence mismatch';
  else
    update avalon_private.agent_runs
    set state = p_outcome, run_revision = run_revision + 1,
        terminal_reason = case when terminal then coalesce(p_terminal_reason, p_outcome) else null end,
        last_error_class = p_error_class,
        completed_at = case when terminal then now() else null end,
        last_progress_at = now()
    where id = run.id;
  end if;

  if run.owner_kind = 'workstream' then
    if terminal then
      update avalon_private.active_output_attempts
      set status = 'superseded', sealed_at = now()
      where run_id = run.id and status = 'streaming';
      update avalon_private.active_output_chunks chunk
      set status = 'abandoned'
      where chunk.run_id = run.id and chunk.status <> 'abandoned'
        and exists (
          select 1 from avalon_private.active_output_attempts attempt
          where attempt.run_id = chunk.run_id and attempt.attempt_id = chunk.attempt_id
            and attempt.status = 'superseded'
        );
      update avalon_private.turns
      set status = 'superseded', completed_at = now()
      where run_id = run.id and status = 'open';
    end if;
    next_state := case
      when p_outcome = 'waiting_user' then 'needs_input'
      when p_outcome in ('waiting_event', 'waiting_provider') then 'waiting_capacity'
      when p_outcome = 'failed' then 'failed'
      when p_outcome = 'cancelled' then 'cancelled_cleanly'
      else 'scheduled'
    end;
    update avalon_private.workstreams
    set active_run_id = case when terminal then null else run.id end,
        state = next_state,
        state_reason = case when next_state in ('needs_input', 'waiting_capacity', 'failed') then coalesce(p_terminal_reason, p_outcome) else null end,
        error_at = case when next_state = 'failed' then now() else null end,
        revision = revision + 1, updated_at = now()
    where id = run.owner_id and active_run_id = run.id;
    update avalon_private.workstream_cards
    set exact_state = next_state,
        lifecycle_family = case when next_state = 'failed' then 'error' else 'in_progress' end,
        state_reason = case when next_state in ('needs_input', 'waiting_capacity', 'failed') then coalesce(p_terminal_reason, p_outcome) else null end,
        error_at = case when next_state = 'failed' then now() else null end,
        needs_input = next_state = 'needs_input',
        active_run_summary = case when terminal then '{}'::jsonb else jsonb_build_object('run_id', run.id, 'state', p_outcome) end,
        common_revision = common_revision + 1
    where workstream_id = run.owner_id;
    if terminal then
      -- `workflow_admit_next_batch` locks this same work-stream row. The
      -- terminal owner is therefore released and its oldest queued batch is
      -- admitted inside this transaction; an appender can observe neither the
      -- temporary NULL owner nor overtake the pending batch.
      next_run := avalon_private.workflow_admit_next_batch(run.owner_id);
    end if;
  end if;
  return jsonb_build_object('run_id', run.id, 'state', p_outcome,
    'terminal', terminal, 'next_run', next_run);
end
$$;

create or replace function avalon_private.workflow_record_progress(
  p_run_id uuid,
  p_expected_control_revision bigint,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_elapsed_ms bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_input_tokens < 0 or p_output_tokens < 0 or p_elapsed_ms < 0 then
    raise exception using errcode = '22023', message = 'invalid run progress';
  end if;
  update avalon_private.agent_runs
  set tokens_used = tokens_used + p_input_tokens + p_output_tokens,
      elapsed_ms = elapsed_ms + p_elapsed_ms,
      run_revision = run_revision + 1, last_progress_at = now()
  where id = p_run_id and control_revision = p_expected_control_revision
    and state in ('running', 'waiting_provider');
  if not found then
    raise exception using errcode = '40001', message = 'run progress fence mismatch';
  end if;
end
$$;

create or replace function avalon_private.workflow_begin_tool_effect(
  p_run_id uuid,
  p_action_id uuid,
  p_expected_control_revision bigint,
  p_effect_kind text,
  p_effect_key text,
  p_operation_id text,
  p_request_hash bytea
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  run avalon_private.agent_runs%rowtype;
  action avalon_private.agent_actions%rowtype;
  effect avalon_private.tool_effects%rowtype;
  new_effect_id uuid := avalon_private.uuid_v7();
  created boolean;
begin
  if length(p_effect_kind) not between 1 and 64
     or length(p_effect_key) not between 1 and 256
     or length(p_operation_id) not between 1 and 256
     or octet_length(p_request_hash) <> 32 then
    raise exception using errcode = '22023', message = 'invalid tool effect';
  end if;
  select * into run from avalon_private.agent_runs where id = p_run_id for update;
  select * into action from avalon_private.agent_actions
  where id = p_action_id and run_id = p_run_id for update;
  if not found or run.control_revision <> p_expected_control_revision
     or run.state <> 'running' or action.control_revision <> run.control_revision
     or action.action_kind not in ('tool', 'terminal') or action.state <> 'started' then
    raise exception using errcode = '40001', message = 'tool effect fence mismatch';
  end if;
  insert into avalon_private.tool_effects (
    id, workspace_id, run_id, action_no, effect_kind, effect_key,
    operation_id, state, request_hash, attempts, started_at
  ) values (
    new_effect_id, run.workspace_id, run.id, action.action_no,
    p_effect_kind, p_effect_key, p_operation_id, 'started',
    p_request_hash, 1, now()
  ) on conflict (operation_id) do nothing;
  created := found;
  if created then
    select * into effect from avalon_private.tool_effects where id = new_effect_id;
  else
    select * into effect from avalon_private.tool_effects
    where operation_id = p_operation_id for update;
    if effect.run_id <> run.id or effect.action_no <> action.action_no
       or effect.request_hash <> p_request_hash then
      raise exception using errcode = '23505', message = 'conflicting tool effect replay';
    end if;
  end if;
  return jsonb_build_object('effect_id', effect.id, 'state', effect.state,
    'recovered', not created,
    'attempts', effect.attempts, 'provider_reference', effect.provider_reference,
    'response_hash', case when effect.response_hash is null then null else encode(effect.response_hash, 'hex') end);
end
$$;

create or replace function avalon_private.workflow_settle_tool_effect(
  p_effect_id uuid,
  p_state text,
  p_provider_reference text,
  p_response_hash bytea
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  effect avalon_private.tool_effects%rowtype;
begin
  if p_state not in ('succeeded', 'failed', 'response_uncertain')
     or (p_provider_reference is not null and length(p_provider_reference) > 512)
     or (p_response_hash is not null and octet_length(p_response_hash) <> 32) then
    raise exception using errcode = '22023', message = 'invalid tool effect settlement';
  end if;
  select * into effect from avalon_private.tool_effects where id = p_effect_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'tool effect not found';
  end if;
  if effect.state in ('succeeded', 'failed', 'response_uncertain') then
    if effect.state <> p_state
       or effect.provider_reference is distinct from p_provider_reference
       or effect.response_hash is distinct from p_response_hash then
      raise exception using errcode = '40001', message = 'tool effect already settled differently';
    end if;
  else
    update avalon_private.tool_effects
    set state = p_state, provider_reference = p_provider_reference,
        response_hash = p_response_hash, completed_at = now()
    where id = effect.id;
  end if;
  return jsonb_build_object('effect_id', effect.id, 'state', p_state);
end
$$;

create or replace function avalon_private.workflow_begin_tool_exchange(
  p_run_id uuid,
  p_action_id uuid,
  p_expected_control_revision bigint,
  p_provider_call_id text,
  p_tool_name text,
  p_plugin_id text,
  p_tool_input jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  run avalon_private.agent_runs%rowtype;
  action avalon_private.agent_actions%rowtype;
  workstream avalon_private.workstreams%rowtype;
  substream avalon_private.substreams%rowtype;
  call_part_id uuid := avalon_private.uuid_v7();
  turn_id uuid := avalon_private.uuid_v7();
  call_payload jsonb;
  call_seq bigint;
begin
  if length(p_provider_call_id) not between 1 and 512
     or length(p_tool_name) not between 1 and 256
     or length(p_plugin_id) not between 1 and 256
     or pg_column_size(p_tool_input) > 60000 then
    raise exception using errcode = '22023', message = 'invalid tool call';
  end if;
  select * into run from avalon_private.agent_runs where id = p_run_id for update;
  select * into action from avalon_private.agent_actions
  where id = p_action_id and run_id = p_run_id for update;
  if not found or run.control_revision <> p_expected_control_revision
     or run.state <> 'running' or action.control_revision <> run.control_revision
     or action.action_kind not in ('tool', 'terminal') or action.state <> 'started' then
    raise exception using errcode = '40001', message = 'tool call fence mismatch';
  end if;
  select * into workstream from avalon_private.workstreams
  where id = run.owner_id and run.owner_kind = 'workstream' for update;
  if not found or workstream.active_run_id <> run.id then
    raise exception using errcode = '40001', message = 'workstream run ownership lost';
  end if;
  select * into substream from avalon_private.substreams where id = run.substream_id;
  if run.workspace_access_revision <> (
       select workspace.access_revision from avalon_private.workspaces workspace
       where workspace.id = run.workspace_id
     )
     or run.workstream_access_revision <> workstream.access_revision
     or substream.id is null
     or run.substream_access_revision <> substream.access_revision
     or run.scope_revision <> substream.scope_revision then
    update avalon_private.agent_actions
    set state = 'superseded', completed_at = now(),
        error_class = 'authorization_changed'
    where id = action.id and state = 'started';
    update avalon_private.turns
    set status = 'superseded', completed_at = now()
    where action_id = action.id and status = 'open';
    return jsonb_build_object('duplicate', false, 'superseded', true,
      'reason', 'authorization_changed');
  end if;
  select part.id, part.turn_id, part.seq into call_part_id, turn_id, call_seq
  from avalon_private.conversation_parts part
  where part.workstream_id = workstream.id
    and part.provider_call_id = p_provider_call_id and part.kind = 'tool_call';
  if found then
    return jsonb_build_object('duplicate', true, 'turn_id', turn_id,
      'call_part_id', call_part_id, 'call_seq', call_seq);
  end if;
  -- SELECT INTO clears its targets when no row is found, including variables
  -- initialized in DECLARE. Allocate the new physical records only after the
  -- replay lookup has missed.
  call_part_id := avalon_private.uuid_v7();
  turn_id := avalon_private.uuid_v7();
  call_seq := workstream.next_seq;
  call_payload := jsonb_build_object('tool_name', p_tool_name,
    'plugin_id', p_plugin_id, 'input', p_tool_input);
  insert into avalon_private.turns (
    id, workspace_id, workstream_id, substream_id, kind,
    first_seq, last_seq, admission_ordinal, status, run_id, action_id
  ) values (
    turn_id, run.workspace_id, workstream.id, run.substream_id,
    'tool_exchange', call_seq, call_seq, null, 'open', run.id, action.id
  );
  insert into avalon_private.conversation_parts (
    id, workspace_id, workstream_id, substream_id, turn_id, seq,
    ordinal_in_turn, role, kind, author_kind, structured_payload,
    provider_call_id, content_hash
  ) values (
    call_part_id, run.workspace_id, workstream.id, run.substream_id,
    turn_id, call_seq, 0, 'assistant', 'tool_call', 'agent',
    call_payload, p_provider_call_id,
    extensions.digest(convert_to(call_payload::text, 'utf8'), 'sha256')
  );
  update avalon_private.workstreams
  set next_seq = next_seq + 1, latest_seq = call_seq,
      revision = revision + 1, last_activity_at = now(), updated_at = now()
  where id = workstream.id;
  return jsonb_build_object('duplicate', false, 'turn_id', turn_id,
    'call_part_id', call_part_id, 'call_seq', call_seq);
end
$$;

create or replace function avalon_private.workflow_commit_tool_exchange(
  p_run_id uuid,
  p_action_id uuid,
  p_expected_control_revision bigint,
  p_provider_call_id text,
  p_tool_name text,
  p_plugin_id text,
  p_tool_input jsonb,
  p_tool_result jsonb,
  p_succeeded boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  run avalon_private.agent_runs%rowtype;
  action avalon_private.agent_actions%rowtype;
  workstream avalon_private.workstreams%rowtype;
  substream avalon_private.substreams%rowtype;
  call_part_id uuid;
  result_part_id uuid := avalon_private.uuid_v7();
  turn_id uuid;
  result_payload jsonb;
  first_seq bigint;
  result_seq bigint;
  topic text;
  overlap jsonb;
begin
  if length(p_provider_call_id) not between 1 and 512
     or length(p_tool_name) not between 1 and 256
     or length(p_plugin_id) not between 1 and 256
     or pg_column_size(p_tool_input) > 60000
     or pg_column_size(p_tool_result) > 60000 then
    raise exception using errcode = '22023', message = 'invalid tool exchange';
  end if;
  select * into run from avalon_private.agent_runs where id = p_run_id for update;
  select * into action from avalon_private.agent_actions
  where id = p_action_id and run_id = p_run_id for update;
  if not found
     or run.state not in ('running', 'interrupting')
     or action.control_revision <> p_expected_control_revision
     or action.action_kind not in ('tool', 'terminal') or action.state <> 'started'
     or not exists (
       select 1 from avalon_private.tool_effects effect
       where effect.run_id = run.id and effect.action_no = action.action_no
         and effect.state in ('succeeded', 'failed', 'response_uncertain')
     ) then
    raise exception using errcode = '40001', message = 'tool exchange fence mismatch';
  end if;
  if run.control_revision <> p_expected_control_revision then
    update avalon_private.agent_actions
    set state = 'superseded', completed_at = now(),
        error_class = 'control_revision_changed'
    where id = action.id and state = 'started';
    update avalon_private.turns
    set status = 'superseded', completed_at = now()
    where action_id = action.id and status = 'open';
    return jsonb_build_object('duplicate', false, 'superseded', true,
      'reason', 'control_revision_changed');
  end if;
  select * into workstream from avalon_private.workstreams
  where id = run.owner_id and run.owner_kind = 'workstream' for update;
  if not found or workstream.active_run_id <> run.id then
    raise exception using errcode = '40001', message = 'workstream run ownership lost';
  end if;
  select * into substream from avalon_private.substreams where id = run.substream_id;
  if run.workspace_access_revision <> (
       select workspace.access_revision from avalon_private.workspaces workspace
       where workspace.id = run.workspace_id
     )
     or run.workstream_access_revision <> workstream.access_revision
     or substream.id is null
     or run.substream_access_revision <> substream.access_revision
     or run.scope_revision <> substream.scope_revision then
    update avalon_private.agent_actions
    set state = 'superseded', completed_at = now(),
        error_class = 'authorization_changed'
    where id = action.id and state = 'started';
    update avalon_private.turns
    set status = 'superseded', completed_at = now()
    where action_id = action.id and status = 'open';
    return jsonb_build_object('duplicate', false, 'superseded', true,
      'reason', 'authorization_changed');
  end if;
  select part.id, part.turn_id, part.seq into call_part_id, turn_id, first_seq
  from avalon_private.conversation_parts part
  where part.workstream_id = workstream.id
    and part.provider_call_id = p_provider_call_id and part.kind = 'tool_call'
  for update;
  if not found then
    raise exception using errcode = '40001', message = 'tool result has no durable call';
  end if;
  if exists (
    select 1 from avalon_private.conversation_parts part
    where part.workstream_id = workstream.id
      and part.provider_call_id = p_provider_call_id and part.kind = 'tool_result'
  ) then
    return (
      select jsonb_build_object(
        'duplicate', true,
        'call_part_id', (
          select part.id from avalon_private.conversation_parts part
          where part.workstream_id = workstream.id
            and part.provider_call_id = p_provider_call_id
            and part.kind = 'tool_call' limit 1
        ),
        'result_part_id', (
          select part.id from avalon_private.conversation_parts part
          where part.workstream_id = workstream.id
            and part.provider_call_id = p_provider_call_id
            and part.kind = 'tool_result' limit 1
        )
      )
    );
  end if;

  result_seq := workstream.next_seq;
  result_payload := jsonb_build_object('tool_name', p_tool_name,
    'plugin_id', p_plugin_id, 'succeeded', p_succeeded,
    'result', p_tool_result);
  insert into avalon_private.conversation_parts (
    id, workspace_id, workstream_id, substream_id, turn_id, seq,
    ordinal_in_turn, role, kind, author_kind, structured_payload,
    provider_call_id, content_hash
  ) values (
    result_part_id, run.workspace_id, workstream.id, run.substream_id,
    turn_id, result_seq, 1, 'tool', 'tool_result', 'tool',
    result_payload, p_provider_call_id,
    extensions.digest(convert_to(result_payload::text, 'utf8'), 'sha256')
  );
  update avalon_private.conversation_parts
  set related_part_id = call_part_id
  where id = result_part_id;
  update avalon_private.turns
  set last_seq = result_seq, status = 'complete', completed_at = now()
  where id = turn_id and status = 'open';
  if not found then
    raise exception using errcode = '40001', message = 'tool turn is not open';
  end if;
  perform avalon_private.assign_turn_admission(turn_id);
  update avalon_private.agent_actions
  set state = case when p_succeeded then 'succeeded' else 'failed' end,
      output_ref = result_part_id, completed_at = now(),
      error_class = case when p_succeeded then null else 'tool_failed' end
  where id = action.id;
  update avalon_private.agent_runs
  set tools_used = tools_used + 1, run_revision = run_revision + 1,
      last_progress_at = now()
  where id = run.id;
  update avalon_private.workstreams
  set next_seq = next_seq + 1, latest_seq = result_seq,
      revision = revision + 1, last_activity_at = now(), updated_at = now()
  where id = workstream.id;
  update avalon_private.workstream_cards
  set latest_seq = result_seq, last_activity_at = now(),
      preview_text = p_tool_name, common_revision = common_revision + 1
  where workstream_id = workstream.id;
  insert into avalon_private.workstream_events (
    workspace_id, workstream_id, workstream_seq, kind, run_id,
    part_id, common_revision, access_container_kind, access_container_id,
    access_revision, payload
  ) values (
    run.workspace_id, workstream.id, workstream.revision + 1,
    'tool_exchange_committed', run.id, result_part_id,
    workstream.revision + 1, 'substream', run.substream_id,
    (select access_revision from avalon_private.substreams where id = run.substream_id),
    jsonb_build_object('version', 1, 'turn_id', turn_id,
      'call_part_id', call_part_id, 'result_part_id', result_part_id,
      'first_seq', first_seq, 'last_seq', result_seq,
      'tool_name', p_tool_name, 'plugin_id', p_plugin_id,
      'input', p_tool_input, 'result', p_tool_result,
      'succeeded', p_succeeded)
  );
  select avalon_private.content_topic_for_substream(run.substream_id) into topic;
  select coalesce(jsonb_agg(item order by item_seq), '[]'::jsonb) into overlap
  from (
    select part.seq as item_seq,
      jsonb_build_object('part_id', part.id, 'turn_id', part.turn_id,
        'seq', part.seq, 'role', part.role, 'kind', part.kind,
        'text', case when octet_length(part.inline_text) <= 16384 then part.inline_text else null end,
        'structured_payload', case when pg_column_size(part.structured_payload) <= 16384
          then part.structured_payload else null end,
        'content_ref_id', part.content_ref_id,
        'provider_call_id', part.provider_call_id,
        'related_part_id', part.related_part_id,
        'content_hash', encode(part.content_hash, 'hex'),
        'requires_fetch', coalesce(octet_length(part.inline_text), 0) > 16384
          or coalesce(pg_column_size(part.structured_payload), 0) > 16384) as item
    from avalon_private.conversation_parts part
    where part.substream_id = run.substream_id and part.seq < result_seq
      and part.kind in ('text', 'tool_call', 'tool_result')
    order by part.seq desc
    limit 2
  ) prior;
  perform avalon_private.safe_realtime_send(
    jsonb_build_object('version', 1, 'turn_id', turn_id,
      'call_part_id', call_part_id, 'result_part_id', result_part_id,
      'first_seq', first_seq, 'last_seq', result_seq,
      'provider_call_id', p_provider_call_id, 'tool_name', p_tool_name,
      'plugin_id', p_plugin_id, 'input', p_tool_input,
      'result', p_tool_result, 'succeeded', p_succeeded,
      'previous_batches', overlap),
    'tool_exchange', topic
  );
  return jsonb_build_object('duplicate', false, 'turn_id', turn_id,
    'call_part_id', call_part_id, 'result_part_id', result_part_id,
    'first_seq', first_seq, 'last_seq', result_seq);
end
$$;

create or replace function avalon_private.workflow_find_tool_result(
  p_run_id uuid,
  p_provider_call_id text,
  p_plugin_id text,
  p_tool_name text,
  p_request_hash bytea
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when effect.id is null then null else result.structured_payload -> 'result' end
  from avalon_private.conversation_parts call
  join avalon_private.turns turn on turn.id = call.turn_id and turn.run_id = p_run_id
  join avalon_private.agent_actions action on action.id = turn.action_id
  join avalon_private.tool_effects effect
    on effect.run_id = action.run_id and effect.action_no = action.action_no
      and effect.request_hash = p_request_hash and effect.state = 'succeeded'
  join avalon_private.conversation_parts result
    on result.turn_id = turn.id and result.kind = 'tool_result'
      and result.provider_call_id = call.provider_call_id
  where call.provider_call_id = p_provider_call_id and call.kind = 'tool_call'
    and call.structured_payload ->> 'plugin_id' = p_plugin_id
    and call.structured_payload ->> 'tool_name' = p_tool_name
    and turn.status = 'complete'
  limit 1
$$;

create or replace function avalon_private.workflow_supersede_output(
  p_run_id uuid,
  p_attempt_id uuid,
  p_expected_attempt_control_revision bigint,
  p_supersede_action boolean default true
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt avalon_private.active_output_attempts%rowtype;
begin
  select * into attempt from avalon_private.active_output_attempts
  where run_id = p_run_id and attempt_id = p_attempt_id for update;
  if not found or attempt.control_revision <> p_expected_attempt_control_revision then
    raise exception using errcode = '40001', message = 'output supersession fence mismatch';
  end if;
  if attempt.status = 'superseded' then
    return false;
  end if;
  if attempt.status <> 'streaming' then
    raise exception using errcode = '40001', message = 'sealed output cannot be superseded';
  end if;
  update avalon_private.active_output_attempts
  set status = 'superseded', sealed_at = now()
  where run_id = p_run_id and attempt_id = p_attempt_id;
  update avalon_private.active_output_chunks
  set status = 'abandoned'
  where run_id = p_run_id and attempt_id = p_attempt_id and status <> 'abandoned';
  update avalon_private.turns
  set status = 'superseded', completed_at = now()
  where id = attempt.turn_id and status = 'open';
  if p_supersede_action then
    update avalon_private.agent_actions
    set state = 'superseded', completed_at = now()
    where id = (select action_id from avalon_private.turns where id = attempt.turn_id)
      and state = 'started';
  end if;
  perform avalon_private.safe_realtime_send(
    jsonb_build_object('version', 1, 'run_id', attempt.run_id,
      'attempt_id', attempt.attempt_id, 'part_id', attempt.part_id,
      'reserved_seq', attempt.reserved_seq, 'status', 'superseded'),
    'output_superseded',
    avalon_private.content_topic_for_substream(attempt.substream_id)
  );
  return true;
end
$$;

create or replace function avalon_private.accept_connector_ingress(
  p_workspace_id uuid,
  p_installation_id uuid,
  p_provider_event_id text,
  p_body_hash bytea,
  p_byte_size bigint,
  p_bounded_body bytea,
  p_raw_content_ref_id uuid,
  p_provider_schema_version text,
  p_signature_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  installation avalon_private.connector_installations%rowtype;
  receipt avalon_private.ingress_receipts%rowtype;
  new_receipt_id uuid := avalon_private.uuid_v7();
begin
  if length(p_provider_event_id) not between 1 and 1024
     or octet_length(p_body_hash) <> 32 or p_byte_size < 0
     or num_nonnulls(p_bounded_body, p_raw_content_ref_id) <> 1
     or (p_bounded_body is not null and octet_length(p_bounded_body) > 65536)
     or length(p_provider_schema_version) not between 1 and 128
     or length(p_signature_version) not between 1 and 128 then
    raise exception using errcode = '22023', message = 'invalid connector ingress';
  end if;
  select * into installation from avalon_private.connector_installations
  where id = p_installation_id and workspace_id = p_workspace_id
  for update;
  if not found or installation.state <> 'active' then
    raise exception using errcode = '42501', message = 'connector installation is not active';
  end if;
  if p_raw_content_ref_id is not null and not exists (
    select 1 from avalon_private.content_refs content
    where content.id = p_raw_content_ref_id and content.workspace_id = p_workspace_id
      and content.bucket = 'connector-ingress' and content.state = 'ready'
      and content.content_hash = p_body_hash and content.byte_size = p_byte_size
  ) then
    raise exception using errcode = '22023', message = 'connector content reference is not ready';
  end if;

  select * into receipt from avalon_private.ingress_receipts
  where connector_installation_id = p_installation_id
    and provider_event_id = p_provider_event_id
  for update;
  if found then
    if receipt.body_hash = p_body_hash and receipt.byte_size = p_byte_size then
      return jsonb_build_object('receipt_id', receipt.id,
        'state', receipt.state, 'duplicate', true, 'conflict', false);
    end if;
    insert into avalon_private.ingress_receipt_conflicts (
      canonical_receipt_id, conflicting_body_hash, byte_size,
      raw_content_ref_id, bounded_body, signature_version
    ) values (
      receipt.id, p_body_hash, p_byte_size,
      p_raw_content_ref_id, p_bounded_body, p_signature_version
    ) on conflict (canonical_receipt_id, conflicting_body_hash) do nothing;
    update avalon_private.ingress_receipts
    set state = 'quarantined', last_error_class = 'provider_event_id_body_conflict'
    where id = receipt.id;
    return jsonb_build_object('receipt_id', receipt.id,
      'state', 'quarantined', 'duplicate', false, 'conflict', true);
  end if;

  insert into avalon_private.ingress_receipts (
    id, workspace_id, connector_installation_id, provider_event_id,
    body_hash, byte_size, raw_content_ref_id, bounded_body,
    provider_schema_version, signature_version, state
  ) values (
    new_receipt_id, p_workspace_id, p_installation_id, p_provider_event_id,
    p_body_hash, p_byte_size, p_raw_content_ref_id, p_bounded_body,
    p_provider_schema_version, p_signature_version, 'queued'
  );
  perform pgmq.send('connector_ingress', jsonb_build_object(
    'version', 1, 'receipt_id', new_receipt_id,
    'workspace_id', p_workspace_id, 'parser_version', p_provider_schema_version
  ));
  return jsonb_build_object('receipt_id', new_receipt_id,
    'state', 'queued', 'duplicate', false, 'conflict', false);
end
$$;

create or replace function avalon_private.commit_connector_activity(
  p_receipt_id uuid,
  p_parser_version text,
  p_events jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  receipt avalon_private.ingress_receipts%rowtype;
  installation avalon_private.connector_installations%rowtype;
  event jsonb;
  event_id uuid;
  event_payload jsonb;
  event_hash bytea;
  event_access_kind text;
  event_access_id uuid;
  event_access_revision bigint;
  inserted_count integer := 0;
  max_event_seq bigint := 0;
  attempt_no integer;
  attempt_id uuid := avalon_private.uuid_v7();
begin
  if length(p_parser_version) not between 1 and 128
     or jsonb_typeof(p_events) <> 'array'
     or jsonb_array_length(p_events) > 100
     or pg_column_size(p_events) > 1048576 then
    raise exception using errcode = '22023', message = 'invalid normalized activity batch';
  end if;
  select * into receipt from avalon_private.ingress_receipts
  where id = p_receipt_id for update;
  if not found or receipt.state not in ('queued', 'normalized') then
    raise exception using errcode = '40001', message = 'ingress receipt is not normalizable';
  end if;
  if receipt.state = 'normalized' then
    return jsonb_build_object('receipt_id', receipt.id,
      'state', 'normalized', 'duplicate', true, 'inserted_count', 0);
  end if;
  select * into installation from avalon_private.connector_installations
  where id = receipt.connector_installation_id;
  if installation.state <> 'active' then
    raise exception using errcode = '42501', message = 'connector installation is not active';
  end if;
  attempt_no := receipt.attempts + 1;
  insert into avalon_private.normalization_attempts (
    id, receipt_id, attempt_no, parser_version, state, input_hash
  ) values (
    attempt_id, receipt.id, attempt_no, p_parser_version, 'started', receipt.body_hash
  );

  for event in select value from jsonb_array_elements(p_events)
  loop
    event_payload := event -> 'payload';
    event_access_kind := coalesce(event ->> 'access_container_kind', 'workspace');
    event_access_id := coalesce((event ->> 'access_container_id')::uuid, receipt.workspace_id);
    if jsonb_typeof(event_payload) <> 'object'
       or length(event ->> 'event_kind') not between 1 and 128
       or length(event ->> 'actor_kind') not between 1 and 64
       or length(event ->> 'object_kind') not between 1 and 128
       or length(event ->> 'object_ref') not between 1 and 1024
       or length(event ->> 'source_version') not between 1 and 256
       or event_access_kind not in ('workspace', 'connector_resource') then
      raise exception using errcode = '22023', message = 'invalid normalized activity event';
    end if;
    if event_access_kind = 'workspace' then
      if event_access_id <> receipt.workspace_id then
        raise exception using errcode = '42501', message = 'activity workspace access mismatch';
      end if;
      select access_revision into event_access_revision
      from avalon_private.workspaces where id = receipt.workspace_id;
    else
      select resource.access_revision into event_access_revision
      from avalon_private.connector_resources resource
      where resource.id = event_access_id
        and resource.workspace_id = receipt.workspace_id
        and resource.installation_id = installation.id
        and resource.state = 'active';
      if not found then
        raise exception using errcode = '42501', message = 'activity resource access mismatch';
      end if;
    end if;
    event_hash := extensions.digest(convert_to(event_payload::text, 'utf8'), 'sha256');
    event_id := coalesce((event ->> 'id')::uuid, avalon_private.uuid_v7());
    insert into avalon_private.activity_events (
      id, workspace_id, installation_id, receipt_id, event_kind,
      actor_kind, actor_ref, object_kind, object_ref, provider_occurred_at,
      normalized_payload, access_container_kind, access_container_id,
      access_revision, source_version, parser_version, content_hash
    ) values (
      event_id, receipt.workspace_id, installation.id, receipt.id,
      event ->> 'event_kind', event ->> 'actor_kind', event ->> 'actor_ref',
      event ->> 'object_kind', event ->> 'object_ref',
      (event ->> 'provider_occurred_at')::timestamptz,
      event_payload, event_access_kind, event_access_id,
      event_access_revision, event ->> 'source_version',
      p_parser_version, event_hash
    ) on conflict (installation_id, event_kind, object_kind, object_ref, source_version)
      do nothing
    returning event_seq into max_event_seq;
    if found then
      inserted_count := inserted_count + 1;
    end if;
  end loop;
  update avalon_private.ingress_receipts
  set state = 'normalized', normalized_at = now(),
      attempts = attempt_no, last_error_class = null
  where id = receipt.id;
  update avalon_private.normalization_attempts
  set state = 'succeeded', output_event_count = inserted_count,
      output_hash = extensions.digest(convert_to(p_events::text, 'utf8'), 'sha256'),
      finished_at = now()
  where id = attempt_id;
  perform pgmq.send('derived_content', jsonb_build_object(
    'version', 1, 'kind', 'activity_changed',
    'workspace_id', receipt.workspace_id,
    'receipt_id', receipt.id, 'through_event_seq', max_event_seq
  ));
  return jsonb_build_object('receipt_id', receipt.id,
    'state', 'normalized', 'duplicate', false,
    'inserted_count', inserted_count, 'through_event_seq', max_event_seq);
end
$$;

create or replace function api.decide_suggestion(
  p_suggestion_id uuid,
  p_decision text,
  p_operation_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := avalon_private.current_platform_user_id();
  suggestion avalon_private.suggestions%rowtype;
  receipt avalon_private.command_receipts%rowtype;
  request_hash bytea;
  created record;
  outcome_id uuid;
begin
  if actor is null or p_decision not in ('shown', 'accepted', 'dismissed')
     or length(p_operation_key) not between 1 and 256 then
    raise exception using errcode = '22023', message = 'invalid suggestion decision';
  end if;
  select * into suggestion from avalon_private.suggestions
  where id = p_suggestion_id for update;
  if not found
     or (suggestion.target_user_id is not null and suggestion.target_user_id <> actor)
     or not avalon_private.can_access_workspace(suggestion.workspace_id, 'guest')
     or (suggestion.access_container_kind is not null
       and not avalon_private.can_access_container_at_revision(
         suggestion.access_container_kind, suggestion.access_container_id,
         suggestion.access_revision, 'view'
       )) then
    raise exception using errcode = '42501', message = 'suggestion is not actionable';
  end if;
  request_hash := extensions.digest(convert_to(jsonb_build_object(
    'suggestion_id', p_suggestion_id, 'decision', p_decision
  )::text, 'utf8'), 'sha256');
  select * into receipt from avalon_private.command_receipts
  where workspace_id = suggestion.workspace_id and actor_id = actor
    and operation_key = p_operation_key for update;
  if found then
    if receipt.request_hash <> request_hash then
      raise exception using errcode = '23505', message = 'operation key reused with different request';
    end if;
    return receipt.result_payload;
  end if;
  if suggestion.expires_at <= now()
     or suggestion.state not in ('proposed', 'shown') then
    raise exception using errcode = '40001', message = 'suggestion is no longer actionable';
  end if;
  if p_decision = 'accepted' and (
    not exists (
      select 1 from avalon_private.suggestion_sources source
      where source.suggestion_id = suggestion.id
    )
    or exists (
      select 1
      from avalon_private.suggestion_sources source
      left join avalon_private.activity_events event
        on event.id = source.activity_event_id
      where source.suggestion_id = suggestion.id
        and (event.id is null or event.event_seq <> source.source_revision
          or event.event_seq > suggestion.source_watermark
          or event.content_hash <> source.content_hash
          or not avalon_private.can_access_container_at_revision(
            event.access_container_kind, event.access_container_id,
            event.access_revision, 'view'
          ))
    )
  ) then
    update avalon_private.suggestions
    set state = 'invalidated', decided_at = now()
    where id = suggestion.id;
    insert into avalon_private.command_receipts (
      workspace_id, workstream_id, actor_id, operation_key,
      operation_kind, request_hash, result_kind, result_id,
      result_revision, result_payload, state, completed_at, expires_at
    ) values (
      suggestion.workspace_id, suggestion.target_workstream_id, actor,
      p_operation_key, 'decide_suggestion', request_hash,
      'suggestion_decision', suggestion.id, 1,
      jsonb_build_object('suggestion_id', suggestion.id,
        'decision', 'invalidated', 'reason', 'source_changed'),
      'completed', now(), now() + interval '7 days'
    );
    return jsonb_build_object('suggestion_id', suggestion.id,
      'decision', 'invalidated', 'reason', 'source_changed');
  end if;
  insert into avalon_private.command_receipts (
    workspace_id, workstream_id, actor_id, operation_key,
    operation_kind, request_hash, expires_at
  ) values (
    suggestion.workspace_id, suggestion.target_workstream_id, actor,
    p_operation_key, 'decide_suggestion', request_hash, now() + interval '7 days'
  ) returning * into receipt;

  if p_decision = 'accepted' and suggestion.kind = 'workstream' then
    select * into created from api.create_workstream(
      suggestion.workspace_id, suggestion.title, suggestion.summary,
      left(p_operation_key || ':workstream', 256)
    );
    outcome_id := created.workstream_id;
    update avalon_private.suggestions
    set state = 'accepted', accepted_workstream_id = outcome_id,
        decided_at = now()
    where id = suggestion.id;
  elsif p_decision = 'accepted' then
    update avalon_private.suggestions set state = 'accepted', decided_at = now()
    where id = suggestion.id;
    perform pgmq.send('derived_content', jsonb_build_object(
      'version', 1, 'kind', 'accepted_suggested_action',
      'suggestion_id', suggestion.id, 'workspace_id', suggestion.workspace_id,
      'target_workstream_id', suggestion.target_workstream_id
    ));
    outcome_id := suggestion.id;
  else
    update avalon_private.suggestions
    set state = case when p_decision = 'shown' then 'shown' else 'dismissed' end,
        shown_at = case when p_decision = 'shown' then coalesce(shown_at, now()) else shown_at end,
        decided_at = case when p_decision = 'dismissed' then now() else decided_at end
    where id = suggestion.id;
    outcome_id := suggestion.id;
  end if;
  insert into avalon_private.suggestion_feedback (
    suggestion_id, platform_user_id, decision
  ) values (suggestion.id, actor, p_decision)
  on conflict do nothing;
  update avalon_private.command_receipts
  set state = 'completed', result_kind = 'suggestion_decision',
      result_id = outcome_id, result_revision = 1,
      result_payload = jsonb_build_object('suggestion_id', suggestion.id,
        'decision', p_decision, 'result_id', outcome_id),
      completed_at = now()
  where id = receipt.id;
  return jsonb_build_object('suggestion_id', suggestion.id,
    'decision', p_decision, 'result_id', outcome_id);
end
$$;

create or replace function api.search_content(
  p_workspace_id uuid,
  p_query text,
  p_limit integer default 25
)
returns table (
  document_id uuid,
  source_kind text,
  source_id uuid,
  source_revision bigint,
  title text,
  excerpt text,
  rank real
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  query tsquery;
begin
  if not avalon_private.can_access_workspace(p_workspace_id, 'guest')
     or length(trim(p_query)) not between 1 and 512 or p_limit not between 1 and 100 then
    raise exception using errcode = '42501', message = 'search denied';
  end if;
  query := websearch_to_tsquery('english', p_query);
  return query
  select document.id, document.source_kind, document.source_id,
    document.source_revision, document.title,
    ts_headline('english', document.body, query,
      'MaxWords=40, MinWords=12, ShortWord=3, HighlightAll=false'),
    ts_rank_cd(document.search_vector, query)
  from avalon_private.content_search_documents document
  where document.workspace_id = p_workspace_id and document.state = 'active'
    and document.search_vector @@ query
    and avalon_private.can_access_container_at_revision(
      document.access_container_kind, document.access_container_id,
      document.access_revision, 'view'
    )
  order by ts_rank_cd(document.search_vector, query) desc,
    document.source_revision desc, document.id
  limit p_limit;
end
$$;

create or replace function avalon_private.claim_migration_jobs(
  p_campaign_id uuid,
  p_lease_owner text,
  p_limit integer default 16
)
returns table (
  job_id uuid,
  lease_token uuid,
  campaign_pause_epoch bigint,
  workspace_id uuid,
  target_kind text,
  target_start text,
  target_end text,
  expected_source_revision bigint,
  attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  campaign avalon_private.migration_campaigns%rowtype;
  active_claims integer;
  available_claims integer;
begin
  if length(p_lease_owner) not between 1 and 256 or p_limit < 1 or p_limit > 64 then
    raise exception using errcode = '22023', message = 'invalid migration claim';
  end if;
  select * into campaign from avalon_private.migration_campaigns
  where id = p_campaign_id for update;
  if not found or campaign.state <> 'running' then
    return;
  end if;
  select count(*)::integer into active_claims
  from avalon_private.migration_jobs job
  where job.campaign_id = campaign.id and job.state = 'running'
    and job.lease_expires_at > now()
    and job.campaign_pause_epoch = campaign.pause_epoch;
  available_claims := greatest(0,
    least(p_limit, campaign.concurrency_limit - active_claims));
  return query
  with candidates as (
    select job.id
    from avalon_private.migration_jobs job
    where job.campaign_id = campaign.id
      and job.state in ('queued', 'running')
      and job.next_attempt_at <= now()
      and (job.state = 'queued' or job.lease_expires_at <= now())
      and job.campaign_pause_epoch = campaign.pause_epoch
    order by job.next_attempt_at, job.id
    limit available_claims
    for update skip locked
  ), claimed as (
    update avalon_private.migration_jobs job
    set state = 'running', lease_owner = p_lease_owner,
        lease_token = avalon_private.uuid_v7(),
        lease_expires_at = now() + interval '60 seconds',
        attempts = job.attempts + 1
    from candidates
    where job.id = candidates.id
    returning job.*
  ), campaign_progress as (
    update avalon_private.migration_campaigns progress
    set claimed_count = progress.claimed_count + (select count(*) from claimed)
    where progress.id = campaign.id
    returning progress.id
  )
  select claimed.id, claimed.lease_token, claimed.campaign_pause_epoch,
    claimed.workspace_id, claimed.target_kind, claimed.target_start,
    claimed.target_end, claimed.expected_source_revision, claimed.attempts
  from claimed
  cross join (select count(*) from campaign_progress) progress_guard;
end
$$;

create or replace function avalon_private.renew_migration_job(
  p_job_id uuid,
  p_lease_owner text,
  p_lease_token uuid,
  p_campaign_pause_epoch bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update avalon_private.migration_jobs job
  set lease_expires_at = now() + interval '60 seconds'
  where job.id = p_job_id and job.state = 'running'
    and job.lease_owner = p_lease_owner and job.lease_token = p_lease_token
    and job.campaign_pause_epoch = p_campaign_pause_epoch
    and exists (
      select 1 from avalon_private.migration_campaigns campaign
      where campaign.id = job.campaign_id and campaign.state = 'running'
        and campaign.pause_epoch = p_campaign_pause_epoch
    );
  return found;
end
$$;

create or replace function avalon_private.finish_migration_job(
  p_job_id uuid,
  p_lease_owner text,
  p_lease_token uuid,
  p_campaign_pause_epoch bigint,
  p_outcome text,
  p_semantic_target_key text,
  p_input_count bigint,
  p_output_count bigint,
  p_input_hash bytea,
  p_output_hash bytea,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job avalon_private.migration_jobs%rowtype;
  campaign avalon_private.migration_campaigns%rowtype;
begin
  if p_outcome not in ('completed', 'failed', 'quarantined')
     or length(p_semantic_target_key) not between 1 and 512
     or p_input_count < 0 or p_output_count < 0
     or octet_length(p_input_hash) <> 32 or octet_length(p_output_hash) <> 32
     or (p_error is not null and length(p_error) > 2048) then
    raise exception using errcode = '22023', message = 'invalid migration settlement';
  end if;
  select * into job from avalon_private.migration_jobs
  where id = p_job_id for update;
  if not found or job.state <> 'running'
     or job.lease_owner <> p_lease_owner or job.lease_token <> p_lease_token
     or job.campaign_pause_epoch <> p_campaign_pause_epoch then
    raise exception using errcode = '40001', message = 'migration lease fence mismatch';
  end if;
  select * into campaign from avalon_private.migration_campaigns
  where id = job.campaign_id for update;
  if campaign.state <> 'running' or campaign.pause_epoch <> p_campaign_pause_epoch then
    raise exception using errcode = '40001', message = 'migration campaign is paused or superseded';
  end if;
  if p_outcome = 'completed' then
    insert into avalon_private.migration_receipts (
      campaign_id, semantic_target_key, target_version,
      source_hash, result_hash, row_count
    ) values (
      campaign.id, p_semantic_target_key, campaign.target_version,
      p_input_hash, p_output_hash, p_output_count
    ) on conflict (campaign_id, semantic_target_key, target_version) do update
      set source_hash = excluded.source_hash,
          result_hash = excluded.result_hash,
          row_count = excluded.row_count,
          committed_at = now()
    where migration_receipts.source_hash = excluded.source_hash
      and migration_receipts.result_hash = excluded.result_hash
      and migration_receipts.row_count = excluded.row_count;
    if not found then
      raise exception using errcode = '23505', message = 'conflicting migration receipt';
    end if;
  end if;
  update avalon_private.migration_jobs
  set state = p_outcome, input_count = p_input_count,
      output_count = p_output_count, input_hash = p_input_hash,
      output_hash = p_output_hash, last_error = p_error,
      lease_owner = null, lease_token = null, lease_expires_at = null,
      completed_at = case when p_outcome = 'completed' then now() else null end,
      next_attempt_at = case when p_outcome = 'failed' then now() + interval '5 minutes' else next_attempt_at end
  where id = job.id;
  update avalon_private.migration_campaigns
  set success_count = success_count + case when p_outcome = 'completed' then 1 else 0 end,
      error_count = error_count + case when p_outcome <> 'completed' then 1 else 0 end
  where id = campaign.id;
  return jsonb_build_object('job_id', job.id, 'outcome', p_outcome,
    'campaign_id', campaign.id, 'pause_epoch', campaign.pause_epoch);
end
$$;

revoke all on function avalon_private.workflow_materialize_run(uuid, bigint) from public;
revoke all on function avalon_private.workflow_prepare_compaction(uuid, bigint, bigint, text, text, text, text) from public;
revoke all on function avalon_private.workflow_finalize_compaction(uuid, bigint, uuid, text) from public;
revoke all on function avalon_private.regional_workflow_wake_descriptor(uuid, uuid, uuid) from public;
revoke all on function avalon_private.workspace_authority_descriptor(uuid, bigint, bytea) from public;
revoke all on function avalon_private.workflow_admit_next_batch(uuid) from public;
revoke all on function avalon_private.workflow_finish_run(uuid, bigint, text, text, text) from public;
revoke all on function avalon_private.workflow_record_progress(uuid, bigint, bigint, bigint, bigint) from public;
revoke all on function avalon_private.workflow_begin_tool_effect(uuid, uuid, bigint, text, text, text, bytea) from public;
revoke all on function avalon_private.workflow_settle_tool_effect(uuid, text, text, bytea) from public;
revoke all on function avalon_private.workflow_begin_tool_exchange(uuid, uuid, bigint, text, text, text, jsonb) from public;
revoke all on function avalon_private.workflow_commit_tool_exchange(uuid, uuid, bigint, text, text, text, jsonb, jsonb, boolean) from public;
revoke all on function avalon_private.workflow_find_tool_result(uuid, text, text, text, bytea) from public;
revoke all on function avalon_private.workflow_supersede_output(uuid, uuid, bigint, boolean) from public;
revoke all on function avalon_private.accept_connector_ingress(uuid, uuid, text, bytea, bigint, bytea, uuid, text, text) from public;
revoke all on function avalon_private.commit_connector_activity(uuid, text, jsonb) from public;
revoke all on function api.decide_suggestion(uuid, text, text) from public, anon;
revoke all on function api.search_content(uuid, text, integer) from public, anon;
revoke all on function avalon_private.claim_migration_jobs(uuid, text, integer) from public;
revoke all on function avalon_private.renew_migration_job(uuid, text, uuid, bigint) from public;
revoke all on function avalon_private.finish_migration_job(uuid, text, uuid, bigint, text, text, bigint, bigint, bytea, bytea, text) from public;

grant execute on function avalon_private.workflow_materialize_run(uuid, bigint) to avalon_workflow_runner;
grant execute on function avalon_private.workflow_prepare_compaction(uuid, bigint, bigint, text, text, text, text) to avalon_workflow_runner;
grant execute on function avalon_private.workflow_finalize_compaction(uuid, bigint, uuid, text) to avalon_workflow_runner;
grant execute on function avalon_private.regional_workflow_wake_descriptor(uuid, uuid, uuid) to avalon_regional_router;
grant execute on function avalon_private.workspace_authority_descriptor(uuid, bigint, bytea) to avalon_regional_router;
grant execute on function avalon_private.workflow_admit_next_batch(uuid) to avalon_workflow_runner;
grant execute on function avalon_private.workflow_finish_run(uuid, bigint, text, text, text) to avalon_workflow_runner;
grant execute on function avalon_private.workflow_record_progress(uuid, bigint, bigint, bigint, bigint) to avalon_workflow_runner;
grant execute on function avalon_private.workflow_begin_tool_effect(uuid, uuid, bigint, text, text, text, bytea) to avalon_workflow_runner;
grant execute on function avalon_private.workflow_settle_tool_effect(uuid, text, text, bytea) to avalon_workflow_runner;
grant execute on function avalon_private.workflow_begin_tool_exchange(uuid, uuid, bigint, text, text, text, jsonb) to avalon_workflow_runner;
grant execute on function avalon_private.workflow_commit_tool_exchange(uuid, uuid, bigint, text, text, text, jsonb, jsonb, boolean) to avalon_workflow_runner;
grant execute on function avalon_private.workflow_find_tool_result(uuid, text, text, text, bytea) to avalon_workflow_runner;
grant execute on function avalon_private.workflow_supersede_output(uuid, uuid, bigint, boolean) to avalon_workflow_runner;
grant execute on function avalon_private.accept_connector_ingress(uuid, uuid, text, bytea, bigint, bytea, uuid, text, text) to avalon_regional_router;
grant execute on function avalon_private.commit_connector_activity(uuid, text, jsonb) to avalon_queue_runner;
grant execute on function api.decide_suggestion(uuid, text, text) to authenticated;
grant execute on function api.search_content(uuid, text, integer) to authenticated;
grant execute on function avalon_private.claim_migration_jobs(uuid, text, integer) to avalon_queue_runner;
grant execute on function avalon_private.renew_migration_job(uuid, text, uuid, bigint) to avalon_queue_runner;
grant execute on function avalon_private.finish_migration_job(uuid, text, uuid, bigint, text, text, bigint, bigint, bytea, bytea, text) to avalon_queue_runner;
