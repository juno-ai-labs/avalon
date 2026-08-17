-- Avalon regional product authority: tenancy, work streams, and sidebar state.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;
create extension if not exists pgmq;

create schema if not exists avalon_private;
create schema if not exists api;

revoke all on schema avalon_private from public, anon, authenticated;
revoke all on schema api from public, anon;
grant usage on schema api to authenticated;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'avalon_workflow_runner') then
    create role avalon_workflow_runner login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'avalon_queue_runner') then
    create role avalon_queue_runner login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'avalon_regional_router') then
    create role avalon_regional_router login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end
$$;

revoke all on schema avalon_private from avalon_workflow_runner, avalon_queue_runner, avalon_regional_router;
grant usage on schema avalon_private to avalon_workflow_runner, avalon_queue_runner, avalon_regional_router;

create or replace function avalon_private.uuid_v7()
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  value bytea := extensions.gen_random_bytes(16);
  unix_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000);
  hex text;
begin
  value := set_byte(value, 0, ((unix_ms >> 40) & 255)::integer);
  value := set_byte(value, 1, ((unix_ms >> 32) & 255)::integer);
  value := set_byte(value, 2, ((unix_ms >> 24) & 255)::integer);
  value := set_byte(value, 3, ((unix_ms >> 16) & 255)::integer);
  value := set_byte(value, 4, ((unix_ms >> 8) & 255)::integer);
  value := set_byte(value, 5, (unix_ms & 255)::integer);
  value := set_byte(value, 6, ((get_byte(value, 6) & 15) | 112)::integer);
  value := set_byte(value, 8, ((get_byte(value, 8) & 63) | 128)::integer);
  hex := encode(value, 'hex');
  return (
    substr(hex, 1, 8) || '-' || substr(hex, 9, 4) || '-' ||
    substr(hex, 13, 4) || '-' || substr(hex, 17, 4) || '-' ||
    substr(hex, 21, 12)
  )::uuid;
end
$$;

revoke all on function avalon_private.uuid_v7() from public;

create sequence avalon_private.workspace_event_sequence as bigint;
create sequence avalon_private.activity_event_sequence as bigint;

create table avalon_private.platform_identities (
  auth_user_id uuid primary key references auth.users(id) on delete restrict,
  issuer text not null check (length(issuer) between 1 and 2048),
  subject text not null check (length(subject) between 1 and 512),
  platform_user_id uuid not null unique,
  account_epoch bigint not null default 1 check (account_epoch > 0),
  state text not null default 'active' check (state in ('active', 'suspended', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (issuer, subject)
);

create index platform_identities_active
  on avalon_private.platform_identities (platform_user_id, state);

create table avalon_private.workspaces (
  id uuid primary key,
  region_key text not null check (length(region_key) between 1 and 32),
  shard_id text not null check (length(shard_id) between 1 and 64),
  route_epoch bigint not null check (route_epoch > 0),
  name text not null check (length(name) between 1 and 160),
  state text not null default 'active' check (state in ('active', 'suspended', 'deleting', 'deleted')),
  timezone text not null default 'UTC' check (length(timezone) between 1 and 128),
  access_revision bigint not null default 1 check (access_revision > 0),
  retention_policy_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleting_at timestamptz,
  unique (id, route_epoch)
);

create index workspaces_operational
  on avalon_private.workspaces (state, updated_at, id);

create table avalon_private.workspace_route_gates (
  workspace_id uuid primary key references avalon_private.workspaces(id) on delete cascade,
  local_shard_id text not null,
  region_key text not null,
  route_epoch bigint not null check (route_epoch > 0),
  authority_state text not null check (authority_state in ('pending', 'writable', 'read_only', 'closed')),
  source_closure_cursor text,
  source_closure_hash bytea check (source_closure_hash is null or octet_length(source_closure_hash) = 32),
  updated_at timestamptz not null default now(),
  unique (workspace_id, route_epoch),
  check ((source_closure_cursor is null) = (source_closure_hash is null))
);

create table avalon_private.global_command_receipts (
  command_id uuid primary key,
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  route_epoch bigint not null check (route_epoch > 0),
  operation_kind text not null check (operation_kind in ('create_workspace', 'suspend_workspace', 'delete_workspace', 'prepare_move', 'activate_move', 'apply_invitation', 'apply_entitlement')),
  payload_hash bytea not null check (octet_length(payload_hash) = 32),
  result_state text not null check (length(result_state) between 1 and 64),
  result_hash bytea not null check (octet_length(result_hash) = 32),
  applied_at timestamptz not null default now(),
  unique (workspace_id, operation_kind, command_id)
);

create table avalon_private.retention_policies (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  version bigint not null check (version > 0),
  state text not null check (state in ('active', 'superseded')),
  conversation_days integer not null check (conversation_days >= 0),
  activity_days integer not null check (activity_days >= 0),
  raw_ingress_days integer not null check (raw_ingress_days >= 0),
  audit_days integer not null check (audit_days >= 0),
  export_days integer not null default 7 check (export_days = 7),
  terminal_artifact_days integer not null check (terminal_artifact_days between 0 and 30),
  legal_hold_mode text not null default 'none' check (legal_hold_mode in ('none', 'scoped')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  superseded_at timestamptz,
  unique (workspace_id, version)
);

alter table avalon_private.workspaces
  add constraint workspaces_retention_policy_fk
  foreign key (retention_policy_id) references avalon_private.retention_policies(id);

create table avalon_private.workspace_members (
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  platform_user_id uuid not null,
  role text not null check (role in ('owner', 'admin', 'member', 'guest')),
  state text not null default 'active' check (state in ('active', 'invited', 'suspended', 'removed')),
  joined_at timestamptz,
  removed_at timestamptz,
  updated_at timestamptz not null default now(),
  invited_by uuid,
  primary key (workspace_id, platform_user_id)
);

create index workspace_members_by_user
  on avalon_private.workspace_members (platform_user_id, state, workspace_id);
create index workspace_members_by_role
  on avalon_private.workspace_members (workspace_id, state, role, platform_user_id);

create table avalon_private.workstreams (
  id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  title text not null check (length(title) between 1 and 256),
  description text not null default '' check (length(description) <= 4096),
  origin_kind text not null check (origin_kind in ('human', 'suggestion', 'automation', 'import', 'connector', 'system')),
  origin_id uuid,
  access_mode text not null default 'workspace' check (access_mode in ('workspace', 'restricted')),
  state text not null default 'active' check (state in ('planned', 'active', 'waiting', 'needs_input', 'error', 'completed', 'cancelled', 'deleting', 'deleted')),
  state_reason text check (state_reason is null or length(state_reason) <= 512),
  next_seq bigint not null default 1 check (next_seq > 0),
  latest_seq bigint not null default 0 check (latest_seq >= 0),
  attention_ordinal bigint not null default 0 check (attention_ordinal >= 0),
  revision bigint not null default 1 check (revision > 0),
  context_scope_revision bigint not null default 1 check (context_scope_revision > 0),
  access_revision bigint not null default 1 check (access_revision > 0),
  active_run_id uuid,
  root_substream_id uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  completed_at timestamptz,
  error_at timestamptz,
  deleting_at timestamptz,
  unique (workspace_id, id),
  unique (active_run_id),
  unique (root_substream_id),
  check (latest_seq < next_seq),
  check ((state = 'completed') = (completed_at is not null)),
  check ((state = 'error') = (error_at is not null))
);

create index workstreams_by_collection
  on avalon_private.workstreams (workspace_id, state, last_activity_at desc, id);
create index workstreams_completed
  on avalon_private.workstreams (workspace_id, completed_at desc, id)
  where state = 'completed';
create index workstreams_active_run
  on avalon_private.workstreams (workspace_id, active_run_id)
  where active_run_id is not null;

create table avalon_private.workstream_access (
  workstream_id uuid not null references avalon_private.workstreams(id) on delete cascade,
  platform_user_id uuid not null,
  capability text not null check (capability in ('view', 'contribute', 'administer')),
  state text not null default 'active' check (state in ('active', 'revoked')),
  granted_by uuid not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (workstream_id, platform_user_id)
);

create index workstream_access_by_user
  on avalon_private.workstream_access (platform_user_id, state, workstream_id);

create table avalon_private.workstream_cards (
  workstream_id uuid primary key references avalon_private.workstreams(id) on delete cascade,
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  title text not null check (length(title) between 1 and 256),
  short_description text not null default '' check (length(short_description) <= 512),
  origin_kind text not null,
  exact_state text not null,
  state_reason text check (state_reason is null or length(state_reason) <= 512),
  lifecycle_family text not null check (lifecycle_family in ('planned', 'in_progress', 'completed')),
  last_activity_at timestamptz not null,
  completed_at timestamptz,
  error_at timestamptz,
  latest_seq bigint not null check (latest_seq >= 0),
  attention_ordinal bigint not null check (attention_ordinal >= 0),
  preview_text text check (preview_text is null or length(preview_text) <= 512),
  preview_content_ref_id uuid,
  active_run_summary jsonb not null default '{}'::jsonb check (pg_column_size(active_run_summary) <= 4096),
  needs_input boolean not null default false,
  participant_count integer not null default 0 check (participant_count >= 0),
  activity_count integer not null default 0 check (activity_count >= 0),
  common_revision bigint not null check (common_revision > 0),
  access_revision bigint not null check (access_revision > 0),
  unique (workspace_id, workstream_id)
);

create index workstream_cards_by_collection
  on avalon_private.workstream_cards (workspace_id, lifecycle_family, last_activity_at desc, workstream_id);
create index workstream_cards_completed
  on avalon_private.workstream_cards (workspace_id, completed_at desc, workstream_id)
  where lifecycle_family = 'completed';

create table avalon_private.workstream_user_state (
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  workstream_id uuid not null references avalon_private.workstreams(id) on delete cascade,
  platform_user_id uuid not null,
  seen_attention_ordinal bigint not null default 0 check (seen_attention_ordinal >= 0),
  latest_unread_ordinal bigint not null default 0 check (latest_unread_ordinal >= 0),
  unread_count integer check (unread_count is null or unread_count >= 0),
  latest_mention_ordinal bigint not null default 0 check (latest_mention_ordinal >= 0),
  mentioned_at timestamptz,
  needs_your_input boolean not null default false,
  assignment_state text check (assignment_state is null or assignment_state in ('assigned', 'in_progress', 'done', 'declined')),
  pinned boolean not null default false,
  muted boolean not null default false,
  dismissed boolean not null default false,
  interest_reason_bits integer not null default 0 check (interest_reason_bits >= 0),
  last_opened_at timestamptz,
  last_interest_at timestamptz,
  user_revision bigint not null default 1 check (user_revision > 0),
  access_revision bigint not null check (access_revision > 0),
  primary key (workspace_id, workstream_id, platform_user_id),
  foreign key (workspace_id, workstream_id)
    references avalon_private.workstreams(workspace_id, id) on delete cascade
);

create index workstream_user_state_interest
  on avalon_private.workstream_user_state (
    workspace_id, platform_user_id, last_interest_at desc, workstream_id
  ) where interest_reason_bits <> 0 or pinned or needs_your_input;
create index workstream_user_state_mentions
  on avalon_private.workstream_user_state (
    workspace_id, platform_user_id, mentioned_at desc, workstream_id
  ) where latest_mention_ordinal > seen_attention_ordinal;

create table avalon_private.workstream_attention_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  workstream_id uuid not null references avalon_private.workstreams(id) on delete cascade,
  attention_ordinal bigint not null check (attention_ordinal > 0),
  part_id uuid,
  kind text not null check (kind in ('message', 'mention', 'assignment', 'state', 'needs_input', 'activity')),
  access_container_kind text not null check (access_container_kind in ('workspace', 'workstream', 'substream')),
  access_container_id uuid not null,
  access_revision bigint not null check (access_revision > 0),
  created_at timestamptz not null default now(),
  unique (workstream_id, attention_ordinal)
);

create index workstream_attention_range
  on avalon_private.workstream_attention_events (workstream_id, attention_ordinal, access_container_kind, access_container_id);

create table avalon_private.attention_materialization_jobs (
  attention_event_id bigint primary key references avalon_private.workstream_attention_events(id) on delete cascade,
  next_mentioned_user_id uuid,
  processed_count integer not null default 0 check (processed_count >= 0),
  expected_count integer not null check (expected_count between 1 and 250),
  state text not null default 'queued' check (state in ('queued', 'running', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table avalon_private.part_mentions (
  part_id uuid not null,
  mentioned_user_id uuid not null,
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  workstream_id uuid not null references avalon_private.workstreams(id) on delete cascade,
  mention_ordinal bigint not null check (mention_ordinal > 0),
  source_token text not null check (length(source_token) between 1 and 256),
  created_at timestamptz not null default now(),
  primary key (part_id, mentioned_user_id)
);

create index part_mentions_by_user
  on avalon_private.part_mentions (workspace_id, mentioned_user_id, mention_ordinal desc);

create table avalon_private.workstream_participants (
  workspace_id uuid not null references avalon_private.workspaces(id) on delete cascade,
  workstream_id uuid not null references avalon_private.workstreams(id) on delete cascade,
  platform_user_id uuid not null,
  participant_kind text not null check (participant_kind in ('creator', 'contributor', 'explicit', 'assignee')),
  first_contributed_seq bigint,
  last_contributed_seq bigint,
  state text not null default 'active' check (state in ('active', 'left')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (workstream_id, platform_user_id)
);

create table avalon_private.workstream_assignments (
  workstream_id uuid not null references avalon_private.workstreams(id) on delete cascade,
  platform_user_id uuid not null,
  assignment_kind text not null check (length(assignment_kind) between 1 and 64),
  state text not null check (state in ('assigned', 'in_progress', 'done', 'declined', 'cancelled')),
  assignment_revision bigint not null default 1 check (assignment_revision > 0),
  assigned_by uuid not null,
  assigned_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (workstream_id, platform_user_id, assignment_kind)
);

create or replace function avalon_private.current_platform_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select identity.platform_user_id
  from avalon_private.platform_identities identity
  where identity.auth_user_id = (select auth.uid())
    and identity.state = 'active'
$$;

create or replace function avalon_private.can_access_workspace(
  p_workspace_id uuid,
  p_minimum_role text default 'guest'
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from avalon_private.workspace_members membership
    join avalon_private.workspaces workspace on workspace.id = membership.workspace_id
    join avalon_private.workspace_route_gates gate on gate.workspace_id = workspace.id
    where membership.workspace_id = p_workspace_id
      and membership.platform_user_id = avalon_private.current_platform_user_id()
      and membership.state = 'active'
      and workspace.state = 'active'
      and gate.authority_state in ('writable', 'read_only')
      and case p_minimum_role
        when 'owner' then membership.role = 'owner'
        when 'admin' then membership.role in ('owner', 'admin')
        when 'member' then membership.role in ('owner', 'admin', 'member')
        else true
      end
  )
$$;

create or replace function avalon_private.can_access_workstream(
  p_workstream_id uuid,
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
    from avalon_private.workstreams workstream
    where workstream.id = p_workstream_id
      and workstream.state <> 'deleted'
      and avalon_private.can_access_workspace(workstream.workspace_id, 'guest')
      and (
        workstream.access_mode = 'workspace'
        or exists (
          select 1
          from avalon_private.workstream_access access
          where access.workstream_id = workstream.id
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

revoke all on function avalon_private.current_platform_user_id() from public;
revoke all on function avalon_private.can_access_workspace(uuid, text) from public;
revoke all on function avalon_private.can_access_workstream(uuid, text) from public;
grant execute on function avalon_private.current_platform_user_id() to authenticated;
grant execute on function avalon_private.can_access_workspace(uuid, text) to authenticated;
grant execute on function avalon_private.can_access_workstream(uuid, text) to authenticated;

alter default privileges in schema avalon_private revoke all on tables from public, anon, authenticated;
alter default privileges in schema avalon_private revoke execute on functions from public;
alter default privileges in schema api revoke all on tables from public, anon;
alter default privileges in schema api revoke execute on functions from public, anon;
