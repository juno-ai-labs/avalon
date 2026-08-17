-- RLS, Realtime and Storage authorization, Data API functions, queue wrappers,
-- and the Cloudflare Workflow RPC surface.

create extension if not exists pg_cron;

select pgmq.create('workflow_starts');
select pgmq.create('workflow_signals');
select pgmq.create('connector_ingress');
select pgmq.create('sidebar_attention');
select pgmq.create('derived_content');
select pgmq.create('maintenance');

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('workspace-content', 'workspace-content', false, 536870912),
  ('connector-ingress', 'connector-ingress', false, 536870912),
  ('exports', 'exports', false, 536870912)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit;

insert into avalon_private.model_provider_configs (
  workspace_id, provider, model, revision, state, region_policy,
  parameter_policy, pricing_version
)
values (
  null, 'openrouter', 'runtime-selected', 1, 'active',
  '{"selection":"cloudflare-worker-flags"}'::jsonb,
  '{"temperature":"runtime-policy"}'::jsonb,
  'runtime'
)
on conflict (workspace_id, provider, model, revision) do nothing;

create or replace function avalon_private.can_access_connector_resource(
  p_resource_id uuid,
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
    from avalon_private.connector_resources resource
    where resource.id = p_resource_id
      and resource.state = 'active'
      and avalon_private.can_access_workspace(resource.workspace_id, 'guest')
      and (
        resource.access_mode = 'workspace'
        or exists (
          select 1
          from avalon_private.connector_resource_access access
          where access.connector_resource_id = resource.id
            and access.platform_user_id = avalon_private.current_platform_user_id()
            and access.state = 'active'
            and case p_capability
              when 'administer' then access.capability = 'administer'
              when 'use' then access.capability in ('use', 'administer')
              else access.capability in ('view', 'use', 'administer')
            end
        )
      )
  )
$$;

create or replace function avalon_private.can_access_container(
  p_kind text,
  p_id uuid,
  p_capability text default 'view'
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_kind
    when 'workspace' then avalon_private.can_access_workspace(p_id, 'guest')
    when 'workstream' then avalon_private.can_access_workstream(p_id, p_capability)
    when 'substream' then avalon_private.can_access_substream(p_id, p_capability)
    when 'connector_resource' then avalon_private.can_access_connector_resource(p_id, case when p_capability = 'contribute' then 'use' else p_capability end)
    else false
  end
$$;

revoke all on function avalon_private.can_access_connector_resource(uuid, text) from public;
revoke all on function avalon_private.can_access_container(text, uuid, text) from public;
grant execute on function avalon_private.can_access_connector_resource(uuid, text) to authenticated;
grant execute on function avalon_private.can_access_container(text, uuid, text) to authenticated;

do $$
declare
  target record;
begin
  for target in
    select table_name
    from information_schema.tables
    where table_schema = 'avalon_private'
      and table_type = 'BASE TABLE'
  loop
    execute format('alter table avalon_private.%I enable row level security', target.table_name);
  end loop;
end
$$;

create policy platform_identities_read_self
  on avalon_private.platform_identities for select to authenticated
  using (auth_user_id = (select auth.uid()) and state = 'active');
create policy workspaces_read_member
  on avalon_private.workspaces for select to authenticated
  using (avalon_private.can_access_workspace(id, 'guest'));
create policy workspace_route_gates_read_member
  on avalon_private.workspace_route_gates for select to authenticated
  using (avalon_private.can_access_workspace(workspace_id, 'guest'));
create policy retention_policies_read_member
  on avalon_private.retention_policies for select to authenticated
  using (avalon_private.can_access_workspace(workspace_id, 'guest'));
create policy workspace_members_read_member
  on avalon_private.workspace_members for select to authenticated
  using (avalon_private.can_access_workspace(workspace_id, 'guest'));
create policy workstreams_read_authorized
  on avalon_private.workstreams for select to authenticated
  using (avalon_private.can_access_workstream(id, 'view'));
create policy workstream_access_read_authorized
  on avalon_private.workstream_access for select to authenticated
  using (avalon_private.can_access_workstream(workstream_id, 'view'));
create policy workstream_cards_read_authorized
  on avalon_private.workstream_cards for select to authenticated
  using (avalon_private.can_access_workstream(workstream_id, 'view'));
create policy workstream_user_state_read_self
  on avalon_private.workstream_user_state for select to authenticated
  using (
    platform_user_id = avalon_private.current_platform_user_id()
    and avalon_private.can_access_workstream(workstream_id, 'view')
  );
create policy workstream_attention_read_authorized
  on avalon_private.workstream_attention_events for select to authenticated
  using (
    avalon_private.can_access_workstream(workstream_id, 'view')
    and avalon_private.can_access_container(access_container_kind, access_container_id, 'view')
  );
create policy part_mentions_read_authorized
  on avalon_private.part_mentions for select to authenticated
  using (avalon_private.can_access_workstream(workstream_id, 'view'));
create policy workstream_participants_read_authorized
  on avalon_private.workstream_participants for select to authenticated
  using (avalon_private.can_access_workstream(workstream_id, 'view'));
create policy workstream_assignments_read_authorized
  on avalon_private.workstream_assignments for select to authenticated
  using (avalon_private.can_access_workstream(workstream_id, 'view'));
create policy substreams_read_authorized
  on avalon_private.substreams for select to authenticated
  using (avalon_private.can_access_substream(id, 'view'));
create policy substream_access_read_authorized
  on avalon_private.substream_access for select to authenticated
  using (avalon_private.can_access_substream(substream_id, 'view'));
create policy turns_read_authorized
  on avalon_private.turns for select to authenticated
  using (avalon_private.can_access_substream(substream_id, 'view'));
create policy conversation_parts_read_authorized
  on avalon_private.conversation_parts for select to authenticated
  using (avalon_private.can_access_substream(substream_id, 'view'));
create policy input_batches_read_authorized
  on avalon_private.input_admission_batches for select to authenticated
  using (avalon_private.can_access_substream(substream_id, 'view'));
create policy active_attempts_read_authorized
  on avalon_private.active_output_attempts for select to authenticated
  using (avalon_private.can_access_substream(substream_id, 'view'));
create policy active_chunks_read_authorized
  on avalon_private.active_output_chunks for select to authenticated
  using (exists (
    select 1
    from avalon_private.active_output_attempts attempt
    where attempt.run_id = active_output_chunks.run_id
      and attempt.attempt_id = active_output_chunks.attempt_id
      and avalon_private.can_access_substream(attempt.substream_id, 'view')
  ));
create policy compactions_read_authorized
  on avalon_private.compaction_jobs for select to authenticated
  using (avalon_private.can_access_substream(substream_id, 'view'));
create policy workspace_events_read_authorized
  on avalon_private.workspace_events for select to authenticated
  using (
    avalon_private.can_access_workspace(workspace_id, 'guest')
    and (target_user_id is null or target_user_id = avalon_private.current_platform_user_id())
    and (access_container_kind is null or avalon_private.can_access_container(access_container_kind, access_container_id, 'view'))
  );
create policy workstream_events_read_authorized
  on avalon_private.workstream_events for select to authenticated
  using (
    avalon_private.can_access_workstream(workstream_id, 'view')
    and (target_user_id is null or target_user_id = avalon_private.current_platform_user_id())
  );
create policy agent_runs_read_authorized
  on avalon_private.agent_runs for select to authenticated
  using (
    (owner_kind = 'workstream' and avalon_private.can_access_workstream(owner_id, 'view'))
    or (owner_kind <> 'workstream' and avalon_private.can_access_workspace(workspace_id, 'guest'))
  );
create policy agent_actions_read_authorized
  on avalon_private.agent_actions for select to authenticated
  using (exists (
    select 1 from avalon_private.agent_runs run
    where run.id = agent_actions.run_id
      and ((run.owner_kind = 'workstream' and avalon_private.can_access_workstream(run.owner_id, 'view'))
        or (run.owner_kind <> 'workstream' and avalon_private.can_access_workspace(run.workspace_id, 'guest')))
  ));
create policy content_refs_read_authorized
  on avalon_private.content_refs for select to authenticated
  using (state = 'ready' and avalon_private.can_access_container(access_container_kind, access_container_id, 'view'));
create policy connector_installations_read_member
  on avalon_private.connector_installations for select to authenticated
  using (avalon_private.can_access_workspace(workspace_id, 'member'));
create policy connector_resources_read_authorized
  on avalon_private.connector_resources for select to authenticated
  using (avalon_private.can_access_connector_resource(id, 'view'));
create policy connector_resource_access_read_authorized
  on avalon_private.connector_resource_access for select to authenticated
  using (avalon_private.can_access_connector_resource(connector_resource_id, 'view'));
create policy activity_events_read_authorized
  on avalon_private.activity_events for select to authenticated
  using (avalon_private.can_access_container(access_container_kind, access_container_id, 'view'));
create policy activity_links_read_authorized
  on avalon_private.activity_links for select to authenticated
  using (exists (
    select 1 from avalon_private.activity_events event
    where event.id = activity_links.activity_event_id
      and avalon_private.can_access_container(event.access_container_kind, event.access_container_id, 'view')
  ));
create policy digest_schedules_read_self
  on avalon_private.digest_schedules for select to authenticated
  using (target_user_id = avalon_private.current_platform_user_id() and avalon_private.can_access_workspace(workspace_id, 'guest'));
create policy digests_read_self
  on avalon_private.digests for select to authenticated
  using (
    target_user_id = avalon_private.current_platform_user_id()
    and state in ('ready', 'delivered')
    and avalon_private.can_access_container(access_container_kind, access_container_id, 'view')
  );
create policy suggestions_read_authorized
  on avalon_private.suggestions for select to authenticated
  using (
    state in ('proposed', 'shown')
    and (target_user_id is null or target_user_id = avalon_private.current_platform_user_id())
    and avalon_private.can_access_workspace(workspace_id, 'guest')
    and (access_container_kind is null or avalon_private.can_access_container(access_container_kind, access_container_id, 'view'))
  );
create policy suggestion_sources_read_authorized
  on avalon_private.suggestion_sources for select to authenticated
  using (exists (
    select 1 from avalon_private.suggestions suggestion
    where suggestion.id = suggestion_sources.suggestion_id
      and suggestion.state in ('proposed', 'shown')
      and (suggestion.target_user_id is null or suggestion.target_user_id = avalon_private.current_platform_user_id())
      and (suggestion.access_container_kind is null or avalon_private.can_access_container(suggestion.access_container_kind, suggestion.access_container_id, 'view'))
  ));
create policy search_documents_read_authorized
  on avalon_private.content_search_documents for select to authenticated
  using (state = 'active' and avalon_private.can_access_container(access_container_kind, access_container_id, 'view'));
create policy embeddings_read_authorized
  on avalon_private.content_embeddings for select to authenticated
  using (state = 'active' and avalon_private.can_access_container(access_container_kind, access_container_id, 'view'));

grant select on avalon_private.platform_identities,
  avalon_private.workspaces,
  avalon_private.workspace_route_gates,
  avalon_private.retention_policies,
  avalon_private.workspace_members,
  avalon_private.workstreams,
  avalon_private.workstream_access,
  avalon_private.workstream_cards,
  avalon_private.workstream_user_state,
  avalon_private.workstream_attention_events,
  avalon_private.part_mentions,
  avalon_private.workstream_participants,
  avalon_private.workstream_assignments,
  avalon_private.substreams,
  avalon_private.substream_access,
  avalon_private.turns,
  avalon_private.conversation_parts,
  avalon_private.input_admission_batches,
  avalon_private.active_output_attempts,
  avalon_private.active_output_chunks,
  avalon_private.compaction_jobs,
  avalon_private.workspace_events,
  avalon_private.workstream_events,
  avalon_private.agent_runs,
  avalon_private.agent_actions,
  avalon_private.content_refs,
  avalon_private.connector_installations,
  avalon_private.connector_resources,
  avalon_private.connector_resource_access,
  avalon_private.activity_events,
  avalon_private.activity_links,
  avalon_private.digest_schedules,
  avalon_private.digests,
  avalon_private.suggestions,
  avalon_private.suggestion_sources,
  avalon_private.content_search_documents,
  avalon_private.content_embeddings
to authenticated;

create view api.workstream_sidebar
with (security_invoker = true)
as
select card.workspace_id, card.workstream_id, card.title,
  card.short_description, card.origin_kind, card.exact_state,
  card.state_reason, card.lifecycle_family, card.last_activity_at,
  card.completed_at, card.error_at, card.latest_seq,
  card.attention_ordinal, card.preview_text, card.preview_content_ref_id,
  card.active_run_summary, card.needs_input, card.participant_count,
  card.activity_count, card.common_revision, card.access_revision,
  coalesce(user_state.seen_attention_ordinal, 0) as seen_attention_ordinal,
  greatest(coalesce(user_state.latest_unread_ordinal, 0) - coalesce(user_state.seen_attention_ordinal, 0), 0) > 0 as has_unread,
  coalesce(user_state.unread_count, 0) as unread_count,
  coalesce(user_state.latest_mention_ordinal, 0) > coalesce(user_state.seen_attention_ordinal, 0) as you_are_mentioned,
  coalesce(user_state.needs_your_input, false) as needs_your_input,
  user_state.assignment_state,
  coalesce(user_state.pinned, false) as pinned,
  coalesce(user_state.muted, false) as muted,
  coalesce(user_state.interest_reason_bits, 0) as interest_reason_bits,
  coalesce(user_state.user_revision, 0) as user_revision
from avalon_private.workstream_cards card
left join avalon_private.workstream_user_state user_state
  on user_state.workspace_id = card.workspace_id
 and user_state.workstream_id = card.workstream_id
 and user_state.platform_user_id = avalon_private.current_platform_user_id();

create view api.workstreams
with (security_invoker = true)
as
select workstream.id, workstream.workspace_id, workstream.title,
  workstream.description, workstream.origin_kind, workstream.state,
  workstream.state_reason, workstream.root_substream_id,
  workstream.access_revision, workstream.context_scope_revision,
  workstream.revision, workstream.attention_ordinal,
  workstream.next_seq, workstream.active_run_id,
  workstream.last_activity_at, workstream.completed_at,
  workstream.error_at, workstream.created_at, workstream.updated_at
from avalon_private.workstreams workstream;

create view api.conversation_parts
with (security_invoker = true)
as
select part.id, part.workspace_id, part.workstream_id, part.substream_id,
  part.turn_id, part.seq, part.ordinal_in_turn, part.role, part.kind,
  part.author_kind, part.author_id, part.inline_text, part.content_ref_id,
  part.structured_payload, part.provider_call_id, part.related_part_id,
  encode(part.content_hash, 'hex') as content_hash, part.created_at,
  part.sealed_at, part.redacted_by_part_id
from avalon_private.conversation_parts part;

create view api.active_outputs
with (security_invoker = true)
as
select attempt.run_id, attempt.attempt_id, attempt.workspace_id,
  attempt.workstream_id, attempt.substream_id, attempt.turn_id,
  attempt.part_id, attempt.control_revision, attempt.reserved_seq,
  attempt.status, attempt.created_at, attempt.sealed_at,
  attempt.final_checkpoint_revision, attempt.final_byte_offset,
  encode(attempt.final_content_hash, 'hex') as final_content_hash
from avalon_private.active_output_attempts attempt
where attempt.status in ('streaming', 'sealing', 'sealed');

create view api.suggestions
with (security_invoker = true)
as
select id, workspace_id, kind, target_user_id, access_container_kind,
  access_container_id, target_workstream_id, title, summary, action_kind,
  score, source_watermark, access_revision, scope_revision, state,
  created_at, shown_at, expires_at
from avalon_private.suggestions;

create view api.activity_events
with (security_invoker = true)
as
select event.id, event.workspace_id, event.installation_id,
  event.event_seq, event.event_kind, event.actor_kind, event.actor_ref,
  event.object_kind, event.object_ref, event.provider_occurred_at,
  event.ingested_at, event.normalized_payload, event.content_ref_id,
  event.access_container_kind, event.access_container_id,
  event.access_revision, event.source_version, event.parser_version,
  encode(event.content_hash, 'hex') as content_hash
from avalon_private.activity_events event;

revoke all on api.workstream_sidebar, api.workstreams, api.conversation_parts,
  api.active_outputs, api.suggestions, api.activity_events from public, anon;
grant select on api.workstream_sidebar, api.workstreams, api.conversation_parts,
  api.active_outputs, api.suggestions, api.activity_events to authenticated;

create or replace function api.create_workstream(
  p_workspace_id uuid,
  p_title text,
  p_description text,
  p_operation_key text
)
returns table (workstream_id uuid, root_substream_id uuid, common_revision bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := avalon_private.current_platform_user_id();
  request_hash bytea;
  receipt avalon_private.command_receipts%rowtype;
  new_workstream_id uuid := avalon_private.uuid_v7();
  new_substream_id uuid := avalon_private.uuid_v7();
  workspace_revision bigint;
begin
  if actor is null or not avalon_private.can_access_workspace(p_workspace_id, 'member') then
    raise exception using errcode = '42501', message = 'workspace access denied';
  end if;
  if length(p_title) not between 1 and 256 or length(p_description) > 4096
     or length(p_operation_key) not between 1 and 256 then
    raise exception using errcode = '22023', message = 'invalid workstream command';
  end if;

  request_hash := extensions.digest(convert_to(jsonb_build_object(
    'workspace_id', p_workspace_id, 'title', p_title,
    'description', p_description
  )::text, 'utf8'), 'sha256');

  select * into receipt
  from avalon_private.command_receipts
  where workspace_id = p_workspace_id
    and actor_id = actor
    and operation_key = p_operation_key
  for update;
  if found then
    if receipt.request_hash <> request_hash then
      raise exception using errcode = '23505', message = 'operation key reused with different request';
    end if;
    return query select receipt.result_id, (receipt.result_payload ->> 'root_substream_id')::uuid,
      receipt.result_revision;
    return;
  end if;

  insert into avalon_private.command_receipts (
    workspace_id, actor_id, operation_key, operation_kind, request_hash, expires_at
  ) values (
    p_workspace_id, actor, p_operation_key, 'create_workstream', request_hash, now() + interval '7 days'
  ) returning * into receipt;

  select access_revision into workspace_revision
  from avalon_private.workspaces
  where id = p_workspace_id and state = 'active'
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'workspace is not active';
  end if;

  insert into avalon_private.workstreams (
    id, workspace_id, title, description, origin_kind, created_by, root_substream_id
  ) values (
    new_workstream_id, p_workspace_id, p_title, p_description, 'human', actor, null
  );
  insert into avalon_private.substreams (
    id, workspace_id, workstream_id, kind, created_by
  ) values (
    new_substream_id, p_workspace_id, new_workstream_id, 'main', actor
  );
  update avalon_private.workstreams
  set root_substream_id = new_substream_id
  where id = new_workstream_id;

  insert into avalon_private.workstream_cards (
    workstream_id, workspace_id, title, short_description, origin_kind,
    exact_state, lifecycle_family, last_activity_at, latest_seq,
    attention_ordinal, common_revision, access_revision
  ) values (
    new_workstream_id, p_workspace_id, p_title, left(p_description, 512),
    'human', 'active', 'in_progress', now(), 0, 0, 1, 1
  );
  insert into avalon_private.workstream_user_state (
    workspace_id, workstream_id, platform_user_id, access_revision,
    interest_reason_bits, last_interest_at
  ) values (p_workspace_id, new_workstream_id, actor, 1, 1, now());
  insert into avalon_private.workstream_participants (
    workspace_id, workstream_id, platform_user_id, participant_kind
  ) values (p_workspace_id, new_workstream_id, actor, 'creator');

  insert into avalon_private.workspace_events (
    workspace_id, kind, subject_kind, subject_id, common_revision,
    access_container_kind, access_container_id, access_revision,
    payload
  ) values (
    p_workspace_id, 'workstream_created', 'workstream', new_workstream_id, 1,
    'workstream', new_workstream_id, 1,
    jsonb_build_object('version', 1, 'workstream_id', new_workstream_id,
      'title', p_title, 'description', left(p_description, 512),
      'state', 'active', 'lifecycle_family', 'in_progress')
  );

  perform avalon_private.safe_realtime_send(
    jsonb_build_object('version', 1, 'workstream_id', new_workstream_id,
      'common_revision', 1, 'access_revision', 1, 'title', p_title,
      'short_description', left(p_description, 512), 'exact_state', 'active',
      'lifecycle_family', 'in_progress', 'last_activity_at', now()),
    'workstream_card_upsert',
    'workspace:' || p_workspace_id::text || ':r' || workspace_revision::text
  );

  update avalon_private.command_receipts
  set workstream_id = new_workstream_id, state = 'completed',
      result_kind = 'workstream', result_id = new_workstream_id,
      result_revision = 1,
      result_payload = jsonb_build_object('root_substream_id', new_substream_id),
      completed_at = now()
  where id = receipt.id;

  return query select new_workstream_id, new_substream_id, 1::bigint;
end
$$;

create or replace function api.append_user_message(
  p_workstream_id uuid,
  p_substream_id uuid,
  p_text text,
  p_operation_key text,
  p_mode text default 'queue',
  p_expected_workstream_revision bigint default null
)
returns table (
  part_id uuid,
  turn_id uuid,
  seq bigint,
  admission_mode text,
  run_id uuid,
  workstream_revision bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := avalon_private.current_platform_user_id();
  workstream avalon_private.workstreams%rowtype;
  substream avalon_private.substreams%rowtype;
  receipt avalon_private.command_receipts%rowtype;
  request_hash bytea;
  new_part_id uuid := avalon_private.uuid_v7();
  new_turn_id uuid := avalon_private.uuid_v7();
  new_batch_id uuid := avalon_private.uuid_v7();
  selected_run_id uuid;
  selected_mode text;
  selected_control_revision bigint;
  existing_batch_id uuid;
  batch_turn_ordinal bigint;
  new_attention bigint;
  overlap jsonb;
  workspace_revision bigint;
  new_signal_id uuid := avalon_private.uuid_v7();
begin
  if actor is null or length(p_operation_key) not between 1 and 256
     or octet_length(p_text) > 262144 or p_mode not in ('queue', 'steer') then
    raise exception using errcode = '22023', message = 'invalid message command';
  end if;
  if not avalon_private.can_access_substream(p_substream_id, 'contribute') then
    raise exception using errcode = '42501', message = 'substream contribution denied';
  end if;

  request_hash := extensions.digest(convert_to(jsonb_build_object(
    'workstream_id', p_workstream_id, 'substream_id', p_substream_id,
    'text', p_text, 'mode', p_mode,
    'expected_workstream_revision', p_expected_workstream_revision
  )::text, 'utf8'), 'sha256');

  select * into workstream
  from avalon_private.workstreams
  where id = p_workstream_id
  for update;
  if not found or workstream.state in ('completed', 'cancelled', 'deleting', 'deleted') then
    raise exception using errcode = 'P0001', message = 'workstream does not accept messages';
  end if;
  if p_expected_workstream_revision is not null
     and workstream.revision <> p_expected_workstream_revision then
    raise exception using errcode = '40001', message = 'workstream revision mismatch';
  end if;
  select * into substream
  from avalon_private.substreams
  where id = p_substream_id and workstream_id = p_workstream_id
  for update;
  if not found or substream.state <> 'active' then
    raise exception using errcode = 'P0001', message = 'substream does not accept messages';
  end if;

  select * into receipt
  from avalon_private.command_receipts
  where workspace_id = workstream.workspace_id
    and actor_id = actor
    and operation_key = p_operation_key
  for update;
  if found then
    if receipt.request_hash <> request_hash then
      raise exception using errcode = '23505', message = 'operation key reused with different request';
    end if;
    return query select receipt.result_id,
      (receipt.result_payload ->> 'turn_id')::uuid,
      (receipt.result_payload ->> 'seq')::bigint,
      receipt.result_payload ->> 'admission_mode',
      (receipt.result_payload ->> 'run_id')::uuid,
      receipt.result_revision;
    return;
  end if;

  insert into avalon_private.command_receipts (
    workspace_id, workstream_id, actor_id, operation_key, operation_kind,
    request_hash, expires_at
  ) values (
    workstream.workspace_id, workstream.id, actor, p_operation_key,
    'append_user_message', request_hash, now() + interval '7 days'
  ) returning * into receipt;

  new_attention := workstream.attention_ordinal + 1;
  insert into avalon_private.turns (
    id, workspace_id, workstream_id, substream_id, kind, first_seq,
    last_seq, admission_ordinal, status, created_at, completed_at
  ) values (
    new_turn_id, workstream.workspace_id, workstream.id, substream.id,
    'user', workstream.next_seq, workstream.next_seq,
    workstream.next_seq, 'complete', now(), now()
  );
  insert into avalon_private.conversation_parts (
    id, workspace_id, workstream_id, substream_id, turn_id, seq,
    ordinal_in_turn, role, kind, author_kind, author_id, inline_text,
    content_hash, source_operation_key
  ) values (
    new_part_id, workstream.workspace_id, workstream.id, substream.id,
    new_turn_id, workstream.next_seq, 0, 'user', 'text', 'human', actor,
    p_text, extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), p_operation_key
  );

  if workstream.active_run_id is null then
    selected_mode := 'queue';
    selected_run_id := avalon_private.uuid_v7();
    selected_control_revision := 1;
    insert into avalon_private.input_admission_batches (
      id, workspace_id, workstream_id, substream_id, first_seq, last_seq,
      mode, control_revision, run_id, state, admitted_at
    ) values (
      new_batch_id, workstream.workspace_id, workstream.id, substream.id,
      workstream.next_seq, workstream.next_seq, selected_mode, 1,
      selected_run_id, 'admitted', now()
    );
    insert into avalon_private.agent_runs (
      id, workspace_id, owner_kind, owner_id,
      execution_principal_kind, execution_principal_id, substream_id,
      admission_batch_id, workspace_access_revision,
      workstream_access_revision, substream_access_revision, scope_revision,
      workflow_instance_id, workflow_version, model_provider, model_name,
      provider_config_revision
    ) values (
      selected_run_id, workstream.workspace_id, 'workstream', workstream.id,
      'user', actor, substream.id, new_batch_id,
      (select access_revision from avalon_private.workspaces where id = workstream.workspace_id),
      workstream.access_revision, substream.access_revision, substream.scope_revision,
      'workstream/' || workstream.id::text || '/run/' || selected_run_id::text,
      'postgres-v1', 'openrouter', 'runtime-selected', 1
    );
    insert into avalon_private.workflow_starts (
      run_id, workflow_instance_id, expected_run_revision
    ) values (
      selected_run_id,
      'workstream/' || workstream.id::text || '/run/' || selected_run_id::text,
      1
    );
    perform pgmq.send('workflow_starts', jsonb_build_object(
      'version', 1, 'run_id', selected_run_id,
      'workflow_instance_id', 'workstream/' || workstream.id::text || '/run/' || selected_run_id::text,
      'expected_run_revision', 1
    ));
  elsif p_mode = 'queue' then
    selected_mode := 'queue';
    selected_run_id := null;
    select run.control_revision into selected_control_revision
    from avalon_private.agent_runs run
    where run.id = workstream.active_run_id
      and run.state not in ('completed', 'failed', 'interrupted', 'cancelled')
    for update;
    if not found then
      raise exception using errcode = '40001', message = 'active run changed during queueing';
    end if;
    select batch.id into existing_batch_id
    from avalon_private.input_admission_batches batch
    where batch.workstream_id = workstream.id
      and batch.substream_id = substream.id
      and batch.mode = 'queue' and batch.state = 'pending'
      and batch.run_id is null
    order by batch.created_at, batch.id
    limit 1
    for update;
    if found then
      new_batch_id := existing_batch_id;
      update avalon_private.input_admission_batches
      set last_seq = workstream.next_seq
      where id = new_batch_id;
    else
      insert into avalon_private.input_admission_batches (
        id, workspace_id, workstream_id, substream_id, first_seq, last_seq,
        mode, control_revision, run_id, state
      ) values (
        new_batch_id, workstream.workspace_id, workstream.id, substream.id,
        workstream.next_seq, workstream.next_seq, selected_mode,
        selected_control_revision, null, 'pending'
      );
    end if;
  else
    selected_mode := 'steer';
    selected_run_id := workstream.active_run_id;
    update avalon_private.agent_runs
    set control_revision = control_revision + 1,
        run_revision = run_revision + 1,
        state = case when state in ('completed', 'failed', 'interrupted', 'cancelled') then state else 'interrupting' end,
        last_progress_at = now()
    where id = selected_run_id
      and state not in ('completed', 'failed', 'interrupted', 'cancelled')
    returning control_revision into selected_control_revision;
    if not found then
      raise exception using errcode = '40001', message = 'active run changed during steering';
    end if;
    insert into avalon_private.input_admission_batches (
      id, workspace_id, workstream_id, substream_id, first_seq, last_seq,
      mode, control_revision, run_id, state, admitted_at
    ) values (
      new_batch_id, workstream.workspace_id, workstream.id, substream.id,
      workstream.next_seq, workstream.next_seq, selected_mode,
      selected_control_revision, selected_run_id, 'admitted', now()
    );
    insert into avalon_private.run_signals (
      id, run_id, signal_kind, operation_key, expected_control_revision, payload
    ) values (
      new_signal_id, selected_run_id, 'steer', p_operation_key, selected_control_revision,
      jsonb_build_object('admission_batch_id', new_batch_id, 'turn_id', new_turn_id)
    );
    perform pgmq.send('workflow_signals', jsonb_build_object(
      'version', 1, 'signal_id', new_signal_id,
      'run_id', selected_run_id,
      'workflow_instance_id', (
        select workflow_instance_id from avalon_private.agent_runs where id = selected_run_id
      ),
      'control_revision', selected_control_revision,
      'signal_kind', 'steer'
    ));
  end if;

  select coalesce(max(batch_turn.admission_ordinal), 0) + 1
  into batch_turn_ordinal
  from avalon_private.input_admission_batch_turns batch_turn
  where batch_turn.batch_id = new_batch_id;
  insert into avalon_private.input_admission_batch_turns (batch_id, turn_id, admission_ordinal)
  values (new_batch_id, new_turn_id, batch_turn_ordinal);
  update avalon_private.turns
  set admission_batch_id = new_batch_id, run_id = selected_run_id
  where id = new_turn_id;

  update avalon_private.workstreams
  set next_seq = next_seq + 1, latest_seq = workstream.next_seq,
      attention_ordinal = new_attention, revision = revision + 1,
      active_run_id = coalesce(selected_run_id, workstream.active_run_id), state = 'active',
      state_reason = null, updated_at = now(), last_activity_at = now()
  where id = workstream.id;
  update avalon_private.workstream_cards
  set exact_state = 'active', lifecycle_family = 'in_progress',
      state_reason = null, last_activity_at = now(), latest_seq = workstream.next_seq,
      attention_ordinal = new_attention, preview_text = left(p_text, 512),
      active_run_summary = case
        when selected_run_id is null then active_run_summary || jsonb_build_object('queued_input', true)
        else jsonb_build_object('run_id', selected_run_id, 'state', case when selected_mode = 'steer' then 'interrupting' else 'admitted' end)
      end,
      common_revision = common_revision + 1
  where workstream_id = workstream.id;
  insert into avalon_private.workstream_user_state (
    workspace_id, workstream_id, platform_user_id, seen_attention_ordinal,
    latest_unread_ordinal, access_revision, interest_reason_bits,
    last_opened_at, last_interest_at
  ) values (
    workstream.workspace_id, workstream.id, actor, new_attention,
    new_attention, workstream.access_revision, 1, now(), now()
  ) on conflict (workspace_id, workstream_id, platform_user_id) do update
    set seen_attention_ordinal = greatest(workstream_user_state.seen_attention_ordinal, excluded.seen_attention_ordinal),
        latest_unread_ordinal = greatest(workstream_user_state.latest_unread_ordinal, excluded.latest_unread_ordinal),
        last_opened_at = now(), last_interest_at = now(),
        interest_reason_bits = workstream_user_state.interest_reason_bits | 1,
        user_revision = workstream_user_state.user_revision + 1,
        access_revision = excluded.access_revision;
  insert into avalon_private.workstream_attention_events (
    workspace_id, workstream_id, attention_ordinal, part_id, kind,
    access_container_kind, access_container_id, access_revision
  ) values (
    workstream.workspace_id, workstream.id, new_attention, new_part_id,
    'message', 'substream', substream.id, substream.access_revision
  );
  insert into avalon_private.workspace_events (
    workspace_id, kind, subject_kind, subject_id, common_revision,
    access_container_kind, access_container_id, access_revision,
    payload
  ) values (
    workstream.workspace_id, 'workstream_changed', 'workstream', workstream.id,
    workstream.revision + 1, 'workstream', workstream.id, workstream.access_revision,
    jsonb_build_object('version', 1, 'workstream_id', workstream.id,
      'latest_seq', workstream.next_seq, 'attention_ordinal', new_attention,
      'last_activity_at', now(), 'exact_state', 'active')
  );
  insert into avalon_private.workstream_events (
    workspace_id, workstream_id, workstream_seq, kind, run_id, part_id,
    common_revision, payload
  ) values (
    workstream.workspace_id, workstream.id, workstream.revision + 1,
    'part_committed', selected_run_id, new_part_id, workstream.revision + 1,
    jsonb_build_object('version', 1, 'substream_id', substream.id,
      'turn_id', new_turn_id, 'part_id', new_part_id, 'seq', workstream.next_seq,
      'role', 'user', 'kind', 'text')
  );

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
    where part.substream_id = substream.id and part.seq < workstream.next_seq
      and part.kind in ('text', 'tool_call', 'tool_result')
    order by part.seq desc
    limit 2
  ) prior;

  perform avalon_private.safe_realtime_send(
    jsonb_build_object('version', 1, 'part_id', new_part_id,
      'turn_id', new_turn_id, 'seq', workstream.next_seq,
      'role', 'user', 'kind', 'text',
      'text', case when octet_length(p_text) <= 131072 then p_text else null end,
      'content_hash', encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'),
      'requires_fetch', octet_length(p_text) > 131072,
      'previous_batches', overlap),
    'conversation_part',
    'substream:' || substream.id::text || ':r' || substream.access_revision::text
  );
  select access_revision into workspace_revision
  from avalon_private.workspaces where id = workstream.workspace_id;
  perform avalon_private.safe_realtime_send(
    jsonb_build_object('version', 1, 'workstream_id', workstream.id,
      'common_revision', workstream.revision + 1,
      'access_revision', workstream.access_revision,
      'latest_seq', workstream.next_seq, 'attention_ordinal', new_attention,
      'preview_text', left(p_text, 512), 'exact_state', 'active',
      'last_activity_at', now()),
    'workstream_card_patch',
    'workspace:' || workstream.workspace_id::text || ':r' || workspace_revision::text
  );

  update avalon_private.command_receipts
  set state = 'completed', result_kind = 'conversation_part',
      result_id = new_part_id, result_revision = workstream.revision + 1,
      result_payload = jsonb_build_object('turn_id', new_turn_id,
        'seq', workstream.next_seq, 'admission_mode', selected_mode,
        'run_id', selected_run_id), completed_at = now()
  where id = receipt.id;

  return query select new_part_id, new_turn_id, workstream.next_seq,
    selected_mode, selected_run_id, workstream.revision + 1;
end
$$;

create or replace function api.mark_workstream_seen(
  p_workstream_id uuid,
  p_seen_attention_ordinal bigint,
  p_operation_key text
)
returns table (seen_attention_ordinal bigint, user_revision bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := avalon_private.current_platform_user_id();
  workstream avalon_private.workstreams%rowtype;
  overlay avalon_private.workstream_user_state%rowtype;
begin
  if actor is null or not avalon_private.can_access_workstream(p_workstream_id, 'view')
     or p_seen_attention_ordinal < 0
     or length(p_operation_key) not between 1 and 256 then
    raise exception using errcode = '42501', message = 'workstream access denied';
  end if;
  select * into workstream from avalon_private.workstreams where id = p_workstream_id;
  insert into avalon_private.workstream_user_state (
    workspace_id, workstream_id, platform_user_id, seen_attention_ordinal,
    latest_unread_ordinal, unread_count, access_revision, last_opened_at
  ) values (
    workstream.workspace_id, workstream.id, actor,
    least(p_seen_attention_ordinal, workstream.attention_ordinal),
    workstream.attention_ordinal, 0, workstream.access_revision, now()
  ) on conflict (workspace_id, workstream_id, platform_user_id) do update
    set seen_attention_ordinal = greatest(workstream_user_state.seen_attention_ordinal,
          least(excluded.seen_attention_ordinal, workstream.attention_ordinal)),
        unread_count = 0, last_opened_at = now(),
        user_revision = workstream_user_state.user_revision + 1,
        access_revision = excluded.access_revision
  returning * into overlay;
  perform avalon_private.safe_realtime_send(
    jsonb_build_object('version', 1, 'workstream_id', workstream.id,
      'seen_attention_ordinal', overlay.seen_attention_ordinal,
      'user_revision', overlay.user_revision, 'has_unread', false),
    'workstream_user_patch',
    'user:' || actor::text || ':r' || (select account_epoch from avalon_private.platform_identities where platform_user_id = actor)::text
  );
  return query select overlay.seen_attention_ordinal, overlay.user_revision;
end
$$;

create or replace function api.workspace_event_page(
  p_workspace_id uuid,
  p_after bigint default 0,
  p_limit integer default 200
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  oldest bigint;
  scanned bigint;
  events jsonb;
begin
  if not avalon_private.can_access_workspace(p_workspace_id, 'guest')
     or p_limit < 1 or p_limit > 500 or p_after < 0 then
    raise exception using errcode = '42501', message = 'workspace event access denied';
  end if;
  select min(workspace_seq) into oldest
  from avalon_private.workspace_events
  where workspace_id = p_workspace_id and created_at >= now() - interval '7 days';
  if p_after > 0 and oldest is not null and p_after < oldest - 1 then
    return jsonb_build_object('snapshot_required', true, 'scanned_through', oldest - 1, 'events', '[]'::jsonb);
  end if;
  select coalesce(max(workspace_seq), p_after) into scanned
  from (
    select workspace_seq
    from avalon_private.workspace_events
    where workspace_id = p_workspace_id and workspace_seq > p_after
      and created_at >= now() - interval '7 days'
    order by workspace_seq
    limit p_limit
  ) scanned_rows;
  select coalesce(jsonb_agg(to_jsonb(event) order by event.workspace_seq), '[]'::jsonb) into events
  from (
    select *
    from avalon_private.workspace_events
    where workspace_id = p_workspace_id and workspace_seq > p_after
      and workspace_seq <= scanned
      and created_at >= now() - interval '7 days'
      and (target_user_id is null or target_user_id = avalon_private.current_platform_user_id())
      and (access_container_kind is null or avalon_private.can_access_container(access_container_kind, access_container_id, 'view'))
    order by workspace_seq
  ) event;
  return jsonb_build_object('snapshot_required', false, 'scanned_through', scanned, 'events', events);
end
$$;

create or replace function api.active_output_after(
  p_run_id uuid,
  p_attempt_id uuid,
  p_byte_offset bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt avalon_private.active_output_attempts%rowtype;
  chunks jsonb;
  total_offset bigint;
  latest_revision bigint;
  through_frame bigint;
  prefix_hash text;
begin
  select * into attempt
  from avalon_private.active_output_attempts
  where run_id = p_run_id and attempt_id = p_attempt_id;
  if not found or not avalon_private.can_access_substream(attempt.substream_id, 'view') or p_byte_offset < 0 then
    raise exception using errcode = '42501', message = 'active output access denied';
  end if;
  select coalesce(max(byte_end), 0), coalesce(max(checkpoint_revision), 0),
    coalesce(max(through_frame_seq), 0),
    encode((array_agg(attempt_hash_through order by chunk_index desc))[1], 'hex')
  into total_offset, latest_revision, through_frame, prefix_hash
  from avalon_private.active_output_chunks
  where run_id = p_run_id and attempt_id = p_attempt_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'chunk_index', chunk_index, 'byte_start', greatest(byte_start, p_byte_offset),
    'byte_end', byte_end,
    'text', case when p_byte_offset <= byte_start then text_buffer
      else convert_from(substring(convert_to(text_buffer, 'utf8') from (p_byte_offset - byte_start + 1)::integer), 'utf8') end,
    'checkpoint_revision', checkpoint_revision,
    'through_frame_seq', through_frame_seq,
    'chunk_hash', encode(chunk_hash, 'hex')
  ) order by chunk_index), '[]'::jsonb) into chunks
  from avalon_private.active_output_chunks
  where run_id = p_run_id and attempt_id = p_attempt_id
    and byte_end > p_byte_offset and status <> 'abandoned';
  return jsonb_build_object('run_id', p_run_id, 'attempt_id', p_attempt_id,
    'status', attempt.status, 'chunks', chunks, 'byte_offset', total_offset,
    'checkpoint_revision', latest_revision, 'through_frame_seq', through_frame,
    'prefix_hash', prefix_hash);
end
$$;

revoke all on function api.create_workstream(uuid, text, text, text) from public, anon;
revoke all on function api.append_user_message(uuid, uuid, text, text, text, bigint) from public, anon;
revoke all on function api.mark_workstream_seen(uuid, bigint, text) from public, anon;
revoke all on function api.workspace_event_page(uuid, bigint, integer) from public, anon;
revoke all on function api.active_output_after(uuid, uuid, bigint) from public, anon;
grant execute on function api.create_workstream(uuid, text, text, text) to authenticated;
grant execute on function api.append_user_message(uuid, uuid, text, text, text, bigint) to authenticated;
grant execute on function api.mark_workstream_seen(uuid, bigint, text) to authenticated;
grant execute on function api.workspace_event_page(uuid, bigint, integer) to authenticated;
grant execute on function api.active_output_after(uuid, uuid, bigint) to authenticated;

create or replace function avalon_private.apply_global_workspace_command(
  p_command_id uuid,
  p_workspace_id uuid,
  p_route_epoch bigint,
  p_local_shard_id text,
  p_region_key text,
  p_operation_kind text,
  p_payload_hash bytea,
  p_source_closure_cursor text default null,
  p_source_closure_hash bytea default null
)
returns table (receipt_id uuid, result_state text, result_hash bytea)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing avalon_private.global_command_receipts%rowtype;
  new_state text;
  response_hash bytea;
begin
  if p_route_epoch < 1 or octet_length(p_payload_hash) <> 32
     or p_operation_kind not in ('create_workspace', 'suspend_workspace', 'delete_workspace', 'prepare_move', 'activate_move', 'apply_invitation', 'apply_entitlement') then
    raise exception using errcode = '22023', message = 'invalid global workspace command';
  end if;
  select * into existing
  from avalon_private.global_command_receipts
  where command_id = p_command_id
  for update;
  if found then
    if existing.workspace_id <> p_workspace_id or existing.route_epoch <> p_route_epoch
       or existing.operation_kind <> p_operation_kind or existing.payload_hash <> p_payload_hash then
      raise exception using errcode = '23505', message = 'conflicting global command replay';
    end if;
    return query select existing.command_id, existing.result_state, existing.result_hash;
    return;
  end if;

  if p_operation_kind = 'create_workspace' then
    insert into avalon_private.workspaces (
      id, region_key, shard_id, route_epoch, name, state
    ) values (
      p_workspace_id, p_region_key, p_local_shard_id, p_route_epoch,
      'Untitled workspace', 'active'
    ) on conflict (id) do update
      set route_epoch = excluded.route_epoch, updated_at = now()
    where workspaces.region_key = excluded.region_key
      and workspaces.shard_id = excluded.shard_id
      and workspaces.route_epoch <= excluded.route_epoch;
    insert into avalon_private.workspace_route_gates (
      workspace_id, local_shard_id, region_key, route_epoch, authority_state
    ) values (
      p_workspace_id, p_local_shard_id, p_region_key, p_route_epoch, 'writable'
    ) on conflict (workspace_id) do update
      set route_epoch = excluded.route_epoch, authority_state = 'writable', updated_at = now()
    where workspace_route_gates.local_shard_id = excluded.local_shard_id
      and workspace_route_gates.region_key = excluded.region_key
      and workspace_route_gates.route_epoch <= excluded.route_epoch;
    new_state := 'writable';
  elsif p_operation_kind = 'suspend_workspace' then
    update avalon_private.workspace_route_gates
    set route_epoch = p_route_epoch, authority_state = 'read_only', updated_at = now()
    where workspace_id = p_workspace_id and route_epoch <= p_route_epoch;
    update avalon_private.workspaces
    set route_epoch = p_route_epoch, state = 'suspended', updated_at = now()
    where id = p_workspace_id and route_epoch <= p_route_epoch;
    new_state := 'read_only';
  elsif p_operation_kind = 'prepare_move' then
    if p_source_closure_cursor is null or octet_length(p_source_closure_hash) <> 32 then
      raise exception using errcode = '22023', message = 'move requires source closure evidence';
    end if;
    update avalon_private.workspace_route_gates
    set route_epoch = p_route_epoch, authority_state = 'read_only',
        source_closure_cursor = p_source_closure_cursor,
        source_closure_hash = p_source_closure_hash, updated_at = now()
    where workspace_id = p_workspace_id and route_epoch <= p_route_epoch;
    new_state := 'read_only';
  elsif p_operation_kind = 'activate_move' then
    if not exists (
      select 1 from avalon_private.import_authority_receipts receipt
      where receipt.workspace_id = p_workspace_id
        and receipt.authority_epoch = p_route_epoch
        and receipt.state = 'verified'
        and receipt.source_closure_receipt_hash = p_source_closure_hash
    ) then
      raise exception using errcode = 'P0001', message = 'verified import authority receipt required';
    end if;
    update avalon_private.workspace_route_gates
    set authority_state = 'writable', route_epoch = p_route_epoch, updated_at = now()
    where workspace_id = p_workspace_id and route_epoch = p_route_epoch;
    update avalon_private.import_authority_receipts
    set state = 'active', activated_at = now()
    where workspace_id = p_workspace_id and authority_epoch = p_route_epoch;
    new_state := 'writable';
  elsif p_operation_kind = 'delete_workspace' then
    update avalon_private.workspace_route_gates
    set route_epoch = p_route_epoch, authority_state = 'closed', updated_at = now()
    where workspace_id = p_workspace_id and route_epoch <= p_route_epoch;
    update avalon_private.workspaces
    set route_epoch = p_route_epoch, state = 'deleting', deleting_at = now(), updated_at = now()
    where id = p_workspace_id and route_epoch <= p_route_epoch;
    new_state := 'closed';
  else
    if not exists (
      select 1 from avalon_private.workspace_route_gates gate
      where gate.workspace_id = p_workspace_id
        and gate.route_epoch = p_route_epoch
        and gate.authority_state in ('writable', 'read_only')
    ) then
      raise exception using errcode = 'P0001', message = 'workspace route gate mismatch';
    end if;
    new_state := 'applied';
  end if;

  response_hash := extensions.digest(convert_to(jsonb_build_object(
    'command_id', p_command_id, 'workspace_id', p_workspace_id,
    'route_epoch', p_route_epoch, 'result_state', new_state
  )::text, 'utf8'), 'sha256');
  insert into avalon_private.global_command_receipts (
    command_id, workspace_id, route_epoch, operation_kind, payload_hash,
    result_state, result_hash
  ) values (
    p_command_id, p_workspace_id, p_route_epoch, p_operation_kind,
    p_payload_hash, new_state, response_hash
  );
  return query select p_command_id, new_state, response_hash;
end
$$;

create or replace function avalon_private.link_platform_identity(
  p_auth_user_id uuid,
  p_issuer text,
  p_subject text,
  p_platform_user_id uuid,
  p_account_epoch bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_account_epoch < 1 or length(p_issuer) not between 1 and 2048
     or length(p_subject) not between 1 and 512
     or not exists (select 1 from auth.users where id = p_auth_user_id) then
    raise exception using errcode = '22023', message = 'invalid verified platform identity';
  end if;
  insert into avalon_private.platform_identities (
    auth_user_id, issuer, subject, platform_user_id, account_epoch, state
  ) values (
    p_auth_user_id, p_issuer, p_subject, p_platform_user_id, p_account_epoch, 'active'
  ) on conflict (auth_user_id) do update
    set issuer = excluded.issuer, subject = excluded.subject,
        platform_user_id = excluded.platform_user_id,
        account_epoch = greatest(platform_identities.account_epoch, excluded.account_epoch),
        state = 'active', updated_at = now()
  where platform_identities.issuer = excluded.issuer
    and platform_identities.subject = excluded.subject
    and platform_identities.platform_user_id = excluded.platform_user_id;
  if not found then
    raise exception using errcode = '23505', message = 'platform identity conflict';
  end if;
end
$$;

create or replace function avalon_private.workflow_claim_run(
  p_run_id uuid,
  p_expected_run_revision bigint,
  p_workflow_instance_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  run avalon_private.agent_runs%rowtype;
begin
  select * into run from avalon_private.agent_runs where id = p_run_id for update;
  if not found or run.workflow_instance_id <> p_workflow_instance_id then
    raise exception using errcode = 'P0001', message = 'workflow identity mismatch';
  end if;
  if run.state in ('completed', 'failed', 'interrupted', 'cancelled') then
    return jsonb_build_object('state', run.state, 'run_revision', run.run_revision,
      'control_revision', run.control_revision, 'terminal', true);
  end if;
  if run.run_revision <> p_expected_run_revision and run.state = 'admitted' then
    raise exception using errcode = '40001', message = 'run revision mismatch';
  end if;
  update avalon_private.agent_runs
  set state = 'running', run_revision = run_revision + 1,
      workflow_attached_at = coalesce(workflow_attached_at, now()),
      started_at = coalesce(started_at, now()), last_progress_at = now()
  where id = p_run_id
  returning * into run;
  update avalon_private.workflow_starts
  set state = 'attached', attached_at = coalesce(attached_at, now())
  where run_id = p_run_id;
  return jsonb_build_object('state', run.state, 'run_revision', run.run_revision,
    'control_revision', run.control_revision, 'terminal', false,
    'workspace_id', run.workspace_id, 'owner_kind', run.owner_kind,
    'owner_id', run.owner_id, 'substream_id', run.substream_id,
    'admission_batch_id', run.admission_batch_id);
end
$$;

create or replace function avalon_private.workflow_begin_action(
  p_run_id uuid,
  p_expected_control_revision bigint,
  p_action_kind text,
  p_operation_id text
)
returns table (action_id uuid, action_no integer, control_revision bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  run avalon_private.agent_runs%rowtype;
  new_action_id uuid := avalon_private.uuid_v7();
begin
  select * into run from avalon_private.agent_runs where id = p_run_id for update;
  if not found or run.state not in ('running', 'interrupting', 'waiting_event', 'waiting_provider')
     or run.control_revision <> p_expected_control_revision
     or p_action_kind not in ('model', 'tool', 'terminal', 'wait', 'materialize', 'finalize')
     or length(p_operation_id) not between 1 and 256 then
    raise exception using errcode = '40001', message = 'run action fence mismatch';
  end if;
  insert into avalon_private.agent_actions (
    id, run_id, action_no, action_kind, state, control_revision,
    operation_id, started_at
  ) values (
    new_action_id, run.id, run.next_action_no, p_action_kind, 'started',
    run.control_revision, p_operation_id, now()
  ) on conflict (operation_id) do nothing;
  if not found then
    return query
      select action.id, action.action_no, action.control_revision
      from avalon_private.agent_actions action
      where action.operation_id = p_operation_id and action.run_id = p_run_id;
    return;
  end if;
  update avalon_private.agent_runs
  set next_action_no = next_action_no + 1, actions_used = actions_used + 1,
      run_revision = run_revision + 1, last_progress_at = now()
  where id = run.id;
  return query select new_action_id, run.next_action_no, run.control_revision;
end
$$;

create or replace function avalon_private.workflow_begin_output_attempt(
  p_run_id uuid,
  p_action_id uuid,
  p_expected_control_revision bigint,
  p_attempt_id uuid,
  p_part_id uuid,
  p_expires_at timestamptz
)
returns table (turn_id uuid, attempt_id uuid, part_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  run avalon_private.agent_runs%rowtype;
  action avalon_private.agent_actions%rowtype;
  workstream avalon_private.workstreams%rowtype;
  new_turn_id uuid := avalon_private.uuid_v7();
begin
  select * into run from avalon_private.agent_runs where id = p_run_id for update;
  select * into action from avalon_private.agent_actions
  where id = p_action_id and run_id = p_run_id for update;
  if not found or run.control_revision <> p_expected_control_revision
     or action.action_kind <> 'model' or action.state <> 'started'
     or p_expires_at <= now() then
    raise exception using errcode = '40001', message = 'output attempt fence mismatch';
  end if;
  select * into workstream from avalon_private.workstreams
  where id = run.owner_id and run.owner_kind = 'workstream' for update;
  if not found or workstream.active_run_id <> run.id then
    raise exception using errcode = '40001', message = 'workstream run ownership lost';
  end if;
  insert into avalon_private.turns (
    id, workspace_id, workstream_id, substream_id, kind, first_seq,
    last_seq, admission_ordinal, status, run_id, action_id
  ) values (
    new_turn_id, run.workspace_id, workstream.id, run.substream_id,
    'agent', workstream.next_seq, workstream.next_seq, workstream.next_seq,
    'open', run.id, action.id
  );
  insert into avalon_private.active_output_attempts (
    run_id, attempt_id, workspace_id, workstream_id, substream_id,
    turn_id, part_id, control_revision, reserved_seq, expires_at
  ) values (
    run.id, p_attempt_id, run.workspace_id, workstream.id,
    run.substream_id, new_turn_id, p_part_id, run.control_revision,
    workstream.next_seq, p_expires_at
  );
  update avalon_private.workstreams
  set next_seq = next_seq + 1, revision = revision + 1,
      updated_at = now()
  where id = workstream.id;
  perform avalon_private.safe_realtime_send(
    jsonb_build_object('version', 1, 'run_id', run.id,
      'attempt_id', p_attempt_id, 'part_id', p_part_id,
      'turn_id', new_turn_id, 'reserved_seq', workstream.next_seq,
      'control_revision', run.control_revision),
    'output_started',
    'substream:' || run.substream_id::text || ':r' ||
      (select access_revision from avalon_private.substreams where id = run.substream_id)::text
  );
  return query select new_turn_id, p_attempt_id, p_part_id;
end
$$;

create or replace function avalon_private.checkpoint_active_output(
  p_run_id uuid,
  p_attempt_id uuid,
  p_expected_revision bigint,
  p_expected_byte_offset bigint,
  p_first_frame_seq bigint,
  p_through_frame_seq bigint,
  p_delta text,
  p_token_estimate_through bigint,
  p_prefix_hash bytea,
  p_provider_cursor jsonb default null,
  p_previous_batches jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt avalon_private.active_output_attempts%rowtype;
  run avalon_private.agent_runs%rowtype;
  tail avalon_private.active_output_chunks%rowtype;
  current_text text;
  new_text text;
  current_offset bigint;
  computed_hash bytea;
  next_revision bigint := p_expected_revision + 1;
  next_chunk integer;
  overlap_item jsonb;
  overlap_text text;
  overlap_start bigint;
  overlap_end bigint;
  overlap_hash bytea;
  topic text;
begin
  if p_expected_revision < 0 or p_expected_byte_offset < 0
     or p_first_frame_seq < 0 or p_through_frame_seq < p_first_frame_seq
     or p_token_estimate_through < 0 or octet_length(p_delta) > 16384
     or octet_length(p_prefix_hash) <> 32
     or jsonb_typeof(p_previous_batches) <> 'array'
     or jsonb_array_length(p_previous_batches) > 2
     or pg_column_size(p_previous_batches) > 65536 then
    raise exception using errcode = '22023', message = 'invalid output checkpoint';
  end if;

  select * into tail
  from avalon_private.active_output_chunks
  where run_id = p_run_id and attempt_id = p_attempt_id and status = 'open'
  for update;
  select * into attempt
  from avalon_private.active_output_attempts
  where run_id = p_run_id and attempt_id = p_attempt_id
  for update;
  if not found or attempt.status <> 'streaming' then
    raise exception using errcode = '40001', message = 'output attempt is not streaming';
  end if;
  select * into run from avalon_private.agent_runs
  where id = p_run_id for update;
  if not found or run.control_revision <> attempt.control_revision
     or run.state not in ('running', 'waiting_provider') then
    update avalon_private.active_output_attempts
    set status = 'superseded', sealed_at = now()
    where run_id = p_run_id and attempt_id = p_attempt_id;
    update avalon_private.active_output_chunks
    set status = 'abandoned'
    where run_id = p_run_id and attempt_id = p_attempt_id and status <> 'abandoned';
    update avalon_private.turns
    set status = 'superseded', completed_at = now()
    where id = attempt.turn_id and status = 'open';
    update avalon_private.agent_actions
    set state = 'superseded', completed_at = now()
    where id = (select action_id from avalon_private.turns where id = attempt.turn_id)
      and state = 'started';
    return jsonb_build_object('superseded', true,
      'control_revision', run.control_revision,
      'attempt_control_revision', attempt.control_revision);
  end if;

  select coalesce(string_agg(text_buffer, '' order by chunk_index), ''),
    coalesce(max(byte_end), 0)
  into current_text, current_offset
  from avalon_private.active_output_chunks
  where run_id = p_run_id and attempt_id = p_attempt_id and status <> 'abandoned';
  if current_offset = p_expected_byte_offset + octet_length(p_delta)
     and coalesce(tail.checkpoint_revision, 0) = next_revision
     and extensions.digest(convert_to(current_text, 'utf8'), 'sha256') = p_prefix_hash
     and right(current_text, length(p_delta)) = p_delta then
    return jsonb_build_object('duplicate', true, 'checkpoint_revision', next_revision,
      'byte_offset', current_offset, 'prefix_hash', encode(p_prefix_hash, 'hex'));
  end if;
  new_text := current_text || p_delta;
  computed_hash := extensions.digest(convert_to(new_text, 'utf8'), 'sha256');
  if current_offset <> p_expected_byte_offset
     or coalesce(tail.checkpoint_revision, 0) <> p_expected_revision
     or computed_hash <> p_prefix_hash then
    raise exception using errcode = '40001', message = 'output checkpoint gap, overlap, or hash mismatch';
  end if;

  for overlap_item in select value from jsonb_array_elements(p_previous_batches)
  loop
    overlap_start := (overlap_item ->> 'byte_start')::bigint;
    overlap_end := (overlap_item ->> 'byte_end')::bigint;
    overlap_text := overlap_item ->> 'text';
    overlap_hash := decode(overlap_item ->> 'content_hash', 'hex');
    if overlap_start < 0 or overlap_end < overlap_start or overlap_end > current_offset
       or octet_length(overlap_text) <> overlap_end - overlap_start
       or extensions.digest(convert_to(overlap_text, 'utf8'), 'sha256') <> overlap_hash
       or convert_from(substring(convert_to(current_text, 'utf8')
            from (overlap_start + 1)::integer for (overlap_end - overlap_start)::integer), 'utf8') <> overlap_text then
      raise exception using errcode = '22023', message = 'invalid output overlap batch';
    end if;
  end loop;

  if tail.run_id is null then
    insert into avalon_private.active_output_chunks (
      run_id, attempt_id, chunk_index, byte_start, byte_end,
      checkpoint_revision, first_frame_seq, through_frame_seq,
      token_estimate_through, text_buffer, chunk_hash,
      attempt_hash_through, provider_cursor, status
    ) values (
      p_run_id, p_attempt_id, 0, 0, octet_length(p_delta),
      next_revision, p_first_frame_seq, p_through_frame_seq,
      p_token_estimate_through, p_delta,
      extensions.digest(convert_to(p_delta, 'utf8'), 'sha256'),
      computed_hash, p_provider_cursor, 'open'
    );
  elsif octet_length(tail.text_buffer) + octet_length(p_delta) <= 16384 then
    update avalon_private.active_output_chunks
    set byte_end = current_offset + octet_length(p_delta),
        checkpoint_revision = next_revision,
        through_frame_seq = p_through_frame_seq,
        token_estimate_through = p_token_estimate_through,
        text_buffer = text_buffer || p_delta,
        chunk_hash = extensions.digest(convert_to(text_buffer || p_delta, 'utf8'), 'sha256'),
        attempt_hash_through = computed_hash,
        provider_cursor = p_provider_cursor,
        checkpointed_at = now()
    where run_id = p_run_id and attempt_id = p_attempt_id and chunk_index = tail.chunk_index;
  else
    update avalon_private.active_output_chunks
    set status = 'sealed'
    where run_id = p_run_id and attempt_id = p_attempt_id and chunk_index = tail.chunk_index;
    next_chunk := tail.chunk_index + 1;
    insert into avalon_private.active_output_chunks (
      run_id, attempt_id, chunk_index, byte_start, byte_end,
      checkpoint_revision, first_frame_seq, through_frame_seq,
      token_estimate_through, text_buffer, chunk_hash,
      attempt_hash_through, provider_cursor, status
    ) values (
      p_run_id, p_attempt_id, next_chunk, current_offset,
      current_offset + octet_length(p_delta), next_revision,
      p_first_frame_seq, p_through_frame_seq, p_token_estimate_through,
      p_delta, extensions.digest(convert_to(p_delta, 'utf8'), 'sha256'),
      computed_hash, p_provider_cursor, 'open'
    );
  end if;

  select 'substream:' || substream.id::text || ':r' || substream.access_revision::text
  into topic
  from avalon_private.substreams substream where substream.id = attempt.substream_id;
  perform avalon_private.safe_realtime_send(
    jsonb_build_object('version', 1, 'run_id', p_run_id,
      'attempt_id', p_attempt_id, 'part_id', attempt.part_id,
      'checkpoint_revision', next_revision,
      'byte_start', current_offset,
      'byte_end', current_offset + octet_length(p_delta),
      'first_frame_seq', p_first_frame_seq,
      'through_frame_seq', p_through_frame_seq,
      'text', p_delta, 'prefix_hash', encode(computed_hash, 'hex'),
      'previous_batches', p_previous_batches),
    'output_checkpoint', topic
  );
  return jsonb_build_object('duplicate', false, 'checkpoint_revision', next_revision,
    'byte_offset', current_offset + octet_length(p_delta),
    'prefix_hash', encode(computed_hash, 'hex'));
end
$$;

create or replace function avalon_private.finalize_active_output(
  p_run_id uuid,
  p_attempt_id uuid,
  p_expected_revision bigint,
  p_expected_byte_offset bigint,
  p_final_content_hash bytea,
  p_terminal_content_ref_id uuid default null,
  p_terminal_run boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  tail avalon_private.active_output_chunks%rowtype;
  attempt avalon_private.active_output_attempts%rowtype;
  run avalon_private.agent_runs%rowtype;
  workstream avalon_private.workstreams%rowtype;
  full_text text;
  actual_hash bytea;
  assistant_seq bigint;
begin
  select * into tail from avalon_private.active_output_chunks
  where run_id = p_run_id and attempt_id = p_attempt_id and status = 'open'
  for update;
  select * into attempt from avalon_private.active_output_attempts
  where run_id = p_run_id and attempt_id = p_attempt_id for update;
  if not found or attempt.status <> 'streaming'
     or tail.checkpoint_revision <> p_expected_revision
     or tail.byte_end <> p_expected_byte_offset then
    raise exception using errcode = '40001', message = 'output finalization fence mismatch';
  end if;
  select string_agg(text_buffer, '' order by chunk_index) into full_text
  from avalon_private.active_output_chunks
  where run_id = p_run_id and attempt_id = p_attempt_id and status <> 'abandoned';
  actual_hash := extensions.digest(convert_to(coalesce(full_text, ''), 'utf8'), 'sha256');
  if actual_hash <> p_final_content_hash then
    raise exception using errcode = '22000', message = 'output final content hash mismatch';
  end if;
  if octet_length(full_text) > 262144 and not exists (
    select 1 from avalon_private.content_refs content
    where content.id = p_terminal_content_ref_id and content.state = 'ready'
      and content.content_hash = actual_hash and content.workspace_id = attempt.workspace_id
  ) then
    raise exception using errcode = '22023', message = 'large output requires verified content reference';
  end if;
  select * into run from avalon_private.agent_runs where id = p_run_id for update;
  select * into workstream from avalon_private.workstreams
  where id = attempt.workstream_id for update;
  if workstream.active_run_id <> run.id
     or run.control_revision <> attempt.control_revision
     or run.state not in ('running', 'waiting_provider') then
    raise exception using errcode = '40001', message = 'workstream run ownership lost';
  end if;
  assistant_seq := attempt.reserved_seq;
  insert into avalon_private.conversation_parts (
    id, workspace_id, workstream_id, substream_id, turn_id, seq,
    ordinal_in_turn, role, kind, author_kind, author_id,
    inline_text, content_ref_id, content_hash
  ) values (
    attempt.part_id, attempt.workspace_id, attempt.workstream_id,
    attempt.substream_id, attempt.turn_id, assistant_seq, 0,
    'assistant', 'text', 'agent', null,
    case when octet_length(full_text) <= 262144 then full_text else null end,
    case when octet_length(full_text) > 262144 then p_terminal_content_ref_id else null end,
    actual_hash
  );
  update avalon_private.turns
  set status = 'complete', completed_at = now()
  where id = attempt.turn_id;
  update avalon_private.active_output_chunks
  set status = 'sealed'
  where run_id = p_run_id and attempt_id = p_attempt_id and status = 'open';
  update avalon_private.active_output_attempts
  set status = 'sealed', sealed_at = now(),
      final_checkpoint_revision = p_expected_revision,
      final_byte_offset = p_expected_byte_offset,
      final_content_hash = actual_hash,
      terminal_content_ref_id = p_terminal_content_ref_id
  where run_id = p_run_id and attempt_id = p_attempt_id;
  update avalon_private.agent_actions
  set state = 'succeeded', output_ref = attempt.part_id, completed_at = now()
  where id = (select action_id from avalon_private.turns where id = attempt.turn_id);
  update avalon_private.workstreams
  set latest_seq = greatest(latest_seq, assistant_seq),
      revision = revision + 1, last_activity_at = now(), updated_at = now(),
      active_run_id = case when p_terminal_run then null else active_run_id end,
      state = case when state in ('waiting', 'needs_input', 'error') then 'active' else state end,
      state_reason = case when state in ('waiting', 'needs_input', 'error') then null else state_reason end,
      error_at = case when state = 'error' then null else error_at end
  where id = workstream.id;
  if p_terminal_run then
    update avalon_private.agent_runs
    set state = 'completed', run_revision = run_revision + 1,
        completed_at = now(), last_progress_at = now(),
        terminal_reason = 'completed'
    where id = run.id;
  end if;
  update avalon_private.workstream_cards
  set exact_state = case when exact_state in ('waiting', 'needs_input', 'error') then 'active' else exact_state end,
      lifecycle_family = 'in_progress', completed_at = null, error_at = null,
      latest_seq = greatest(latest_seq, assistant_seq), preview_text = left(full_text, 512),
      last_activity_at = now(), common_revision = common_revision + 1,
      active_run_summary = case when p_terminal_run then '{}'::jsonb else active_run_summary end
  where workstream_id = workstream.id;
  insert into avalon_private.workstream_events (
    workspace_id, workstream_id, workstream_seq, kind, run_id,
    attempt_id, part_id, byte_offset, common_revision, payload
  ) values (
    workstream.workspace_id, workstream.id, workstream.revision + 1,
    'output_finalized', run.id, attempt.attempt_id, attempt.part_id,
    p_expected_byte_offset, workstream.revision + 1,
    jsonb_build_object('version', 1, 'seq', assistant_seq,
      'terminal_run', p_terminal_run, 'content_hash', encode(actual_hash, 'hex'))
  );
  perform avalon_private.safe_realtime_send(
    jsonb_build_object('version', 1, 'run_id', run.id,
      'attempt_id', attempt.attempt_id, 'part_id', attempt.part_id,
      'seq', assistant_seq, 'byte_offset', p_expected_byte_offset,
      'text', case when octet_length(full_text) <= 131072 then full_text else null end,
      'content_ref_id', case when octet_length(full_text) > 131072 then p_terminal_content_ref_id else null end,
      'requires_fetch', octet_length(full_text) > 131072,
      'content_hash', encode(actual_hash, 'hex'), 'terminal_run', p_terminal_run),
    'output_finalized',
    'substream:' || attempt.substream_id::text || ':r' ||
      (select access_revision from avalon_private.substreams where id = attempt.substream_id)::text
  );
  return attempt.part_id;
end
$$;

create or replace function avalon_private.workflow_pending_signals(
  p_run_id uuid,
  p_after_created_at timestamptz default '-infinity'
)
returns setof avalon_private.run_signals
language sql
security definer
set search_path = ''
as $$
  select signal.*
  from avalon_private.run_signals signal
  where signal.run_id = p_run_id and signal.state = 'pending'
    and signal.created_at > p_after_created_at
  order by signal.created_at, signal.id
  limit 100
$$;

create or replace function avalon_private.workflow_observe_signal(
  p_run_id uuid,
  p_signal_id uuid,
  p_expected_control_revision bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from avalon_private.agent_runs run
    where run.id = p_run_id and run.control_revision >= p_expected_control_revision
  ) then
    raise exception using errcode = '40001', message = 'signal control revision mismatch';
  end if;
  update avalon_private.run_signals
  set state = 'observed', observed_at = now()
  where id = p_signal_id and run_id = p_run_id and state in ('pending', 'delivered');
  update avalon_private.agent_runs run
  set state = 'running', run_revision = run_revision + 1,
      last_progress_at = now()
  where run.id = p_run_id
    and run.control_revision = p_expected_control_revision
    and run.state = 'interrupting'
    and not exists (
      select 1 from avalon_private.run_signals signal
      where signal.run_id = run.id
        and signal.state in ('pending', 'delivered')
        and signal.expected_control_revision <= p_expected_control_revision
    );
end
$$;

create or replace function avalon_private.queue_read(
  p_queue_name text,
  p_visibility_seconds integer default 60,
  p_limit integer default 32
)
returns table (
  message_id bigint,
  read_count integer,
  enqueued_at timestamptz,
  visible_at timestamptz,
  message jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_queue_name not in ('workflow_starts', 'workflow_signals', 'connector_ingress', 'sidebar_attention', 'derived_content', 'maintenance')
     or p_visibility_seconds <> 60 or p_limit < 1 or p_limit > 32 then
    raise exception using errcode = '22023', message = 'queue read policy violation';
  end if;
  return query
  select item.msg_id, item.read_ct, item.enqueued_at, item.vt, item.message
  from pgmq.read(p_queue_name, p_visibility_seconds, p_limit) item;
end
$$;

create or replace function avalon_private.queue_set_visibility(
  p_queue_name text,
  p_message_id bigint,
  p_visibility_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_queue_name not in ('workflow_starts', 'workflow_signals', 'connector_ingress', 'sidebar_attention', 'derived_content', 'maintenance')
     or p_visibility_seconds <> 60 then
    raise exception using errcode = '22023', message = 'queue visibility policy violation';
  end if;
  perform pgmq.set_vt(p_queue_name, p_message_id, p_visibility_seconds);
  return found;
end
$$;

create or replace function avalon_private.queue_delete(
  p_queue_name text,
  p_message_id bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_queue_name not in ('workflow_starts', 'workflow_signals', 'connector_ingress', 'sidebar_attention', 'derived_content', 'maintenance') then
    raise exception using errcode = '22023', message = 'queue delete policy violation';
  end if;
  return pgmq.delete(p_queue_name, p_message_id);
end
$$;

create or replace function avalon_private.queue_archive(
  p_queue_name text,
  p_message_id bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_queue_name not in ('workflow_starts', 'workflow_signals', 'connector_ingress', 'sidebar_attention', 'derived_content', 'maintenance') then
    raise exception using errcode = '22023', message = 'queue archive policy violation';
  end if;
  return pgmq.archive(p_queue_name, p_message_id);
end
$$;

create or replace function avalon_private.queue_dead_letter(
  p_queue_name text,
  p_message_id bigint,
  p_semantic_key text,
  p_message jsonb,
  p_error_class text,
  p_attempts integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_queue_name not in ('workflow_starts', 'workflow_signals', 'connector_ingress', 'sidebar_attention', 'derived_content', 'maintenance')
     or length(p_semantic_key) not between 1 and 512
     or length(p_error_class) not between 1 and 128
     or p_attempts < 10 or pg_column_size(p_message) > 16384 then
    raise exception using errcode = '22023', message = 'queue dead-letter policy violation';
  end if;
  insert into avalon_private.dead_letters (
    source_queue, semantic_key, message_snapshot, error_class, attempts
  ) values (
    p_queue_name, p_semantic_key, p_message, p_error_class, p_attempts
  ) on conflict (source_queue, semantic_key) do update
    set error_class = excluded.error_class,
        attempts = greatest(dead_letters.attempts, excluded.attempts),
        message_snapshot = excluded.message_snapshot,
        quarantined_at = now();
  return pgmq.archive(p_queue_name, p_message_id);
end
$$;

create or replace function avalon_private.enqueue_due_jobs()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  queued integer := 0;
  target record;
begin
  for target in
    select schedule.id, schedule.workspace_id, schedule.revision
    from avalon_private.digest_schedules schedule
    where schedule.state = 'active' and schedule.next_due_at <= now()
    order by schedule.next_due_at, schedule.id
    limit 100
  loop
    perform pgmq.send('derived_content', jsonb_build_object(
      'version', 1, 'kind', 'digest_schedule', 'job_id', target.id,
      'workspace_id', target.workspace_id, 'expected_revision', target.revision
    ));
    queued := queued + 1;
  end loop;
  for target in
    select job.id, job.workspace_id, job.kind
    from avalon_private.storage_reconciliation_jobs job
    where job.state = 'queued' and job.next_attempt_at <= now()
    order by job.next_attempt_at, job.id
    limit greatest(0, 100 - queued)
  loop
    perform pgmq.send('maintenance', jsonb_build_object(
      'version', 1, 'kind', 'storage_reconciliation',
      'job_id', target.id, 'workspace_id', target.workspace_id
    ));
    queued := queued + 1;
  end loop;
  return queued;
end
$$;

select cron.schedule(
  'avalon-enqueue-due-regional-jobs',
  '* * * * *',
  'select avalon_private.enqueue_due_jobs()'
)
where not exists (
  select 1 from cron.job where jobname = 'avalon-enqueue-due-regional-jobs'
);

revoke all on function avalon_private.apply_global_workspace_command(uuid, uuid, bigint, text, text, text, bytea, text, bytea) from public;
revoke all on function avalon_private.link_platform_identity(uuid, text, text, uuid, bigint) from public;
revoke all on function avalon_private.workflow_claim_run(uuid, bigint, text) from public;
revoke all on function avalon_private.workflow_begin_action(uuid, bigint, text, text) from public;
revoke all on function avalon_private.workflow_begin_output_attempt(uuid, uuid, bigint, uuid, uuid, timestamptz) from public;
revoke all on function avalon_private.checkpoint_active_output(uuid, uuid, bigint, bigint, bigint, bigint, text, bigint, bytea, jsonb, jsonb) from public;
revoke all on function avalon_private.finalize_active_output(uuid, uuid, bigint, bigint, bytea, uuid, boolean) from public;
revoke all on function avalon_private.workflow_pending_signals(uuid, timestamptz) from public;
revoke all on function avalon_private.workflow_observe_signal(uuid, uuid, bigint) from public;
revoke all on function avalon_private.queue_read(text, integer, integer) from public;
revoke all on function avalon_private.queue_set_visibility(text, bigint, integer) from public;
revoke all on function avalon_private.queue_delete(text, bigint) from public;
revoke all on function avalon_private.queue_archive(text, bigint) from public;
revoke all on function avalon_private.queue_dead_letter(text, bigint, text, jsonb, text, integer) from public;
revoke all on function avalon_private.enqueue_due_jobs() from public;

grant execute on function avalon_private.apply_global_workspace_command(uuid, uuid, bigint, text, text, text, bytea, text, bytea) to avalon_regional_router;
grant execute on function avalon_private.link_platform_identity(uuid, text, text, uuid, bigint) to avalon_regional_router;
grant execute on function avalon_private.workflow_claim_run(uuid, bigint, text) to avalon_workflow_runner;
grant execute on function avalon_private.workflow_begin_action(uuid, bigint, text, text) to avalon_workflow_runner;
grant execute on function avalon_private.workflow_begin_output_attempt(uuid, uuid, bigint, uuid, uuid, timestamptz) to avalon_workflow_runner;
grant execute on function avalon_private.checkpoint_active_output(uuid, uuid, bigint, bigint, bigint, bigint, text, bigint, bytea, jsonb, jsonb) to avalon_workflow_runner;
grant execute on function avalon_private.finalize_active_output(uuid, uuid, bigint, bigint, bytea, uuid, boolean) to avalon_workflow_runner;
grant execute on function avalon_private.workflow_pending_signals(uuid, timestamptz) to avalon_workflow_runner;
grant execute on function avalon_private.workflow_observe_signal(uuid, uuid, bigint) to avalon_workflow_runner;
grant execute on function avalon_private.queue_read(text, integer, integer) to avalon_queue_runner;
grant execute on function avalon_private.queue_set_visibility(text, bigint, integer) to avalon_queue_runner;
grant execute on function avalon_private.queue_delete(text, bigint) to avalon_queue_runner;
grant execute on function avalon_private.queue_archive(text, bigint) to avalon_queue_runner;
grant execute on function avalon_private.queue_dead_letter(text, bigint, text, jsonb, text, integer) to avalon_queue_runner;

revoke all on all tables in schema avalon_private from anon, authenticated,
  avalon_workflow_runner, avalon_queue_runner, avalon_regional_router;

grant select on avalon_private.platform_identities,
  avalon_private.workspaces,
  avalon_private.workspace_route_gates,
  avalon_private.retention_policies,
  avalon_private.workspace_members,
  avalon_private.workstreams,
  avalon_private.workstream_access,
  avalon_private.workstream_cards,
  avalon_private.workstream_user_state,
  avalon_private.workstream_attention_events,
  avalon_private.part_mentions,
  avalon_private.workstream_participants,
  avalon_private.workstream_assignments,
  avalon_private.substreams,
  avalon_private.substream_access,
  avalon_private.turns,
  avalon_private.conversation_parts,
  avalon_private.input_admission_batches,
  avalon_private.active_output_attempts,
  avalon_private.active_output_chunks,
  avalon_private.compaction_jobs,
  avalon_private.workspace_events,
  avalon_private.workstream_events,
  avalon_private.agent_runs,
  avalon_private.agent_actions,
  avalon_private.content_refs,
  avalon_private.connector_installations,
  avalon_private.connector_resources,
  avalon_private.connector_resource_access,
  avalon_private.activity_events,
  avalon_private.activity_links,
  avalon_private.digest_schedules,
  avalon_private.digests,
  avalon_private.suggestions,
  avalon_private.suggestion_sources,
  avalon_private.content_search_documents,
  avalon_private.content_embeddings
to authenticated;

create policy avalon_realtime_receive_authorized
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and (
    exists (
      select 1 from avalon_private.platform_identities identity
      where identity.auth_user_id = (select auth.uid())
        and identity.state = 'active'
        and (select realtime.topic()) = 'user:' || identity.platform_user_id::text || ':r' || identity.account_epoch::text
    )
    or exists (
      select 1 from avalon_private.workspaces workspace
      where (select realtime.topic()) = 'workspace:' || workspace.id::text || ':r' || workspace.access_revision::text
        and avalon_private.can_access_workspace(workspace.id, 'guest')
    )
    or exists (
      select 1 from avalon_private.workstreams workstream
      where (select realtime.topic()) = 'workstream:' || workstream.id::text || ':r' || workstream.access_revision::text
        and avalon_private.can_access_workstream(workstream.id, 'view')
    )
    or exists (
      select 1 from avalon_private.substreams substream
      where (select realtime.topic()) = 'substream:' || substream.id::text || ':r' || substream.access_revision::text
        and avalon_private.can_access_substream(substream.id, 'view')
    )
  )
);

create policy avalon_storage_read_authorized
on storage.objects
for select
to authenticated
using (
  bucket_id in ('workspace-content', 'connector-ingress', 'exports')
  and exists (
    select 1 from avalon_private.content_refs content
    where content.bucket = storage.objects.bucket_id
      and content.object_path = storage.objects.name
      and content.state = 'ready'
      and avalon_private.can_access_container(
        content.access_container_kind, content.access_container_id, 'view'
      )
  )
);

create policy avalon_storage_upload_pending
on storage.objects
for insert
to authenticated
with check (
  bucket_id in ('workspace-content', 'connector-ingress')
  and exists (
    select 1 from avalon_private.content_refs content
    where content.bucket = storage.objects.bucket_id
      and content.object_path = storage.objects.name
      and content.state = 'pending'
      and content.uploaded_by_kind = 'user'
      and content.uploaded_by_id = avalon_private.current_platform_user_id()
      and avalon_private.can_access_container(
        content.access_container_kind, content.access_container_id, 'contribute'
      )
  )
);

alter default privileges in schema avalon_private revoke all on tables from public, anon, authenticated;
alter default privileges in schema avalon_private revoke execute on functions from public;
alter default privileges in schema api revoke all on tables from public, anon;
alter default privileges in schema api revoke execute on functions from public, anon;
