-- Avalon global identity and routing control plane.
-- This project intentionally contains no regional product metadata or content.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists avalon_private;
create schema if not exists api;

revoke all on schema avalon_private from public, anon, authenticated;
revoke all on schema api from public, anon;
grant usage on schema api to authenticated;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'avalon_global_router') then
    create role avalon_global_router login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end
$$;

revoke all on schema avalon_private from avalon_global_router;
grant usage on schema avalon_private to avalon_global_router;

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

create table avalon_private.global_accounts (
  platform_user_id uuid primary key default avalon_private.uuid_v7(),
  auth_user_id uuid not null unique references auth.users(id) on delete restrict,
  issuer text not null check (length(issuer) between 1 and 2048),
  subject text not null check (length(subject) between 1 and 512),
  state text not null default 'active' check (state in ('active', 'suspended', 'deleted')),
  account_epoch bigint not null default 1 check (account_epoch > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (issuer, subject)
);

create table avalon_private.organizations (
  id uuid primary key default avalon_private.uuid_v7(),
  name text not null check (length(name) between 1 and 160),
  state text not null default 'active' check (state in ('active', 'suspended', 'deleting', 'deleted')),
  created_by uuid not null references avalon_private.global_accounts(platform_user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table avalon_private.organization_members (
  organization_id uuid not null references avalon_private.organizations(id) on delete cascade,
  platform_user_id uuid not null references avalon_private.global_accounts(platform_user_id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'billing')),
  state text not null default 'active' check (state in ('active', 'suspended', 'removed')),
  joined_at timestamptz not null default now(),
  removed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (organization_id, platform_user_id)
);

create index organization_members_by_user
  on avalon_private.organization_members (platform_user_id, state, organization_id);

create table avalon_private.organization_invitations (
  id uuid primary key default avalon_private.uuid_v7(),
  organization_id uuid not null references avalon_private.organizations(id) on delete cascade,
  email_hash bytea not null check (octet_length(email_hash) = 32),
  role text not null check (role in ('admin', 'member', 'billing')),
  state text not null default 'pending' check (state in ('pending', 'accepted', 'revoked', 'expired')),
  invited_by uuid not null references avalon_private.global_accounts(platform_user_id),
  accepted_by uuid references avalon_private.global_accounts(platform_user_id),
  operation_key text not null check (length(operation_key) between 1 and 256),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (organization_id, operation_key)
);

create index organization_invitations_pending
  on avalon_private.organization_invitations (email_hash, expires_at)
  where state = 'pending';

create table avalon_private.billing_customers (
  organization_id uuid primary key references avalon_private.organizations(id) on delete cascade,
  provider text not null check (length(provider) between 1 and 64),
  provider_customer_ref text not null unique check (length(provider_customer_ref) between 1 and 256),
  state text not null check (state in ('active', 'delinquent', 'closed')),
  updated_at timestamptz not null default now()
);

create table avalon_private.organization_entitlements (
  organization_id uuid not null references avalon_private.organizations(id) on delete cascade,
  entitlement_key text not null check (length(entitlement_key) between 1 and 128),
  version bigint not null check (version > 0),
  state text not null check (state in ('active', 'suspended', 'expired')),
  value jsonb not null default '{}'::jsonb check (pg_column_size(value) <= 8192),
  effective_at timestamptz not null default now(),
  expires_at timestamptz,
  primary key (organization_id, entitlement_key, version)
);

create table avalon_private.regional_shards (
  shard_id text primary key check (length(shard_id) between 1 and 64),
  region_key text not null check (length(region_key) between 1 and 32),
  lifecycle text not null check (lifecycle in ('provisioning', 'active', 'draining', 'read_only', 'unavailable', 'retired')),
  capacity_class text not null check (length(capacity_class) between 1 and 64),
  api_origin_id text not null check (length(api_origin_id) between 1 and 128),
  realtime_origin_id text not null check (length(realtime_origin_id) between 1 and 128),
  min_schema_version bigint not null check (min_schema_version > 0),
  max_schema_version bigint not null check (max_schema_version >= min_schema_version),
  route_public_key_id text not null check (length(route_public_key_id) between 1 and 128),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  draining_at timestamptz
);

create index regional_shards_for_admission
  on avalon_private.regional_shards (region_key, lifecycle, capacity_class, shard_id);

create table avalon_private.workspace_routes (
  workspace_id uuid primary key,
  organization_id uuid not null references avalon_private.organizations(id) on delete restrict,
  region_key text not null check (length(region_key) between 1 and 32),
  shard_id text not null references avalon_private.regional_shards(shard_id),
  route_epoch bigint not null default 1 check (route_epoch > 0),
  authority_state text not null check (authority_state in ('creating', 'active', 'suspending', 'moving', 'deleting', 'closed')),
  source_shard_id text references avalon_private.regional_shards(shard_id),
  destination_shard_id text references avalon_private.regional_shards(shard_id),
  source_closure_receipt_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (workspace_id, route_epoch),
  check ((authority_state = 'moving') = (destination_shard_id is not null)),
  check (source_shard_id is null or source_shard_id <> destination_shard_id)
);

create index workspace_routes_by_org
  on avalon_private.workspace_routes (organization_id, authority_state, workspace_id);
create index workspace_routes_by_shard
  on avalon_private.workspace_routes (shard_id, authority_state, workspace_id);

create table avalon_private.routing_commands (
  command_id uuid primary key default avalon_private.uuid_v7(),
  workspace_id uuid not null references avalon_private.workspace_routes(workspace_id) on delete cascade,
  route_epoch bigint not null check (route_epoch > 0),
  target_shard_id text not null references avalon_private.regional_shards(shard_id),
  operation_kind text not null check (operation_kind in ('create_workspace', 'suspend_workspace', 'delete_workspace', 'prepare_move', 'activate_move', 'apply_invitation', 'apply_entitlement')),
  operation_key text not null check (length(operation_key) between 1 and 256),
  payload_version integer not null check (payload_version > 0),
  payload jsonb not null check (pg_column_size(payload) <= 16384),
  payload_hash bytea not null check (octet_length(payload_hash) = 32),
  state text not null default 'pending' check (state in ('pending', 'dispatching', 'acknowledged', 'quarantined', 'failed')),
  not_before timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  unique (workspace_id, operation_key)
);

create index routing_commands_dispatch
  on avalon_private.routing_commands (state, not_before, command_id)
  where state in ('pending', 'dispatching');

create table avalon_private.routing_command_attempts (
  command_id uuid not null references avalon_private.routing_commands(command_id) on delete cascade,
  attempt_no integer not null check (attempt_no > 0),
  dispatcher_workflow_id text not null check (length(dispatcher_workflow_id) between 1 and 256),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text check (outcome in ('delivered', 'retryable_error', 'permanent_error', 'conflict')),
  error_class text check (error_class is null or length(error_class) <= 128),
  next_attempt_at timestamptz,
  primary key (command_id, attempt_no)
);

create table avalon_private.routing_command_receipts (
  command_id uuid primary key references avalon_private.routing_commands(command_id) on delete cascade,
  workspace_id uuid not null references avalon_private.workspace_routes(workspace_id) on delete cascade,
  route_epoch bigint not null,
  target_shard_id text not null references avalon_private.regional_shards(shard_id),
  regional_receipt_id uuid not null,
  regional_state text not null check (length(regional_state) between 1 and 64),
  response_hash bytea not null check (octet_length(response_hash) = 32),
  observed_at timestamptz not null default now()
);

create table avalon_private.global_audit_events (
  id bigint generated always as identity primary key,
  actor_kind text not null check (actor_kind in ('user', 'system', 'operator')),
  actor_id uuid,
  action text not null check (length(action) between 1 and 128),
  target_kind text not null check (length(target_kind) between 1 and 64),
  target_id uuid,
  request_id text check (request_id is null or length(request_id) <= 256),
  detail jsonb not null default '{}'::jsonb check (pg_column_size(detail) <= 8192),
  created_at timestamptz not null default now()
);

create index global_audit_events_target
  on avalon_private.global_audit_events (target_kind, target_id, created_at desc);

create or replace function avalon_private.current_platform_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select account.platform_user_id
  from avalon_private.global_accounts account
  where account.auth_user_id = (select auth.uid())
    and account.state = 'active'
$$;

create or replace function avalon_private.can_read_organization(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from avalon_private.organization_members membership
    where membership.organization_id = p_organization_id
      and membership.platform_user_id = avalon_private.current_platform_user_id()
      and membership.state = 'active'
  )
$$;

revoke all on function avalon_private.current_platform_user_id() from public;
revoke all on function avalon_private.can_read_organization(uuid) from public;
grant execute on function avalon_private.current_platform_user_id() to authenticated;
grant execute on function avalon_private.can_read_organization(uuid) to authenticated;

alter table avalon_private.global_accounts enable row level security;
alter table avalon_private.organizations enable row level security;
alter table avalon_private.organization_members enable row level security;
alter table avalon_private.organization_invitations enable row level security;
alter table avalon_private.billing_customers enable row level security;
alter table avalon_private.organization_entitlements enable row level security;
alter table avalon_private.workspace_routes enable row level security;
alter table avalon_private.regional_shards enable row level security;
alter table avalon_private.routing_commands enable row level security;
alter table avalon_private.routing_command_attempts enable row level security;
alter table avalon_private.routing_command_receipts enable row level security;
alter table avalon_private.global_audit_events enable row level security;

create policy global_accounts_read_self
  on avalon_private.global_accounts for select to authenticated
  using (auth_user_id = (select auth.uid()) and state <> 'deleted');
create policy organizations_read_member
  on avalon_private.organizations for select to authenticated
  using (avalon_private.can_read_organization(id));
create policy organization_members_read_member
  on avalon_private.organization_members for select to authenticated
  using (avalon_private.can_read_organization(organization_id));
create policy organization_invitations_read_member
  on avalon_private.organization_invitations for select to authenticated
  using (avalon_private.can_read_organization(organization_id));
create policy billing_customers_read_member
  on avalon_private.billing_customers for select to authenticated
  using (avalon_private.can_read_organization(organization_id));
create policy organization_entitlements_read_member
  on avalon_private.organization_entitlements for select to authenticated
  using (avalon_private.can_read_organization(organization_id));
create policy workspace_routes_read_member
  on avalon_private.workspace_routes for select to authenticated
  using (authority_state <> 'closed' and avalon_private.can_read_organization(organization_id));
create policy regional_shards_read_routed
  on avalon_private.regional_shards for select to authenticated
  using (exists (
    select 1
    from avalon_private.workspace_routes route
    where route.shard_id = regional_shards.shard_id
      and route.authority_state <> 'closed'
      and avalon_private.can_read_organization(route.organization_id)
  ));

grant select on avalon_private.global_accounts,
  avalon_private.organizations,
  avalon_private.organization_members,
  avalon_private.organization_invitations,
  avalon_private.billing_customers,
  avalon_private.organization_entitlements,
  avalon_private.workspace_routes,
  avalon_private.regional_shards
to authenticated;

create view api.account
with (security_invoker = true)
as
select platform_user_id, state, account_epoch, created_at, updated_at
from avalon_private.global_accounts;

create view api.organizations
with (security_invoker = true)
as
select organization.id, organization.name, organization.state,
  membership.role, organization.created_at, organization.updated_at
from avalon_private.organizations organization
join avalon_private.organization_members membership
  on membership.organization_id = organization.id
 and membership.platform_user_id = avalon_private.current_platform_user_id()
 and membership.state = 'active';

create view api.workspace_routes
with (security_invoker = true)
as
select route.workspace_id, route.organization_id, route.region_key, route.shard_id,
  route.route_epoch, route.authority_state, shard.api_origin_id,
  shard.realtime_origin_id, shard.min_schema_version, shard.max_schema_version
from avalon_private.workspace_routes route
join avalon_private.regional_shards shard on shard.shard_id = route.shard_id
where route.authority_state <> 'closed';

revoke all on api.account, api.organizations, api.workspace_routes from public, anon;
grant select on api.account, api.organizations, api.workspace_routes to authenticated;

create or replace function avalon_private.claim_routing_commands(
  p_dispatcher_workflow_id text,
  p_limit integer default 32
)
returns table (
  command_id uuid,
  workspace_id uuid,
  route_epoch bigint,
  target_shard_id text,
  operation_kind text,
  payload_version integer,
  payload jsonb,
  payload_hash bytea,
  attempt_no integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit < 1 or p_limit > 32 or length(p_dispatcher_workflow_id) not between 1 and 256 then
    raise exception using errcode = '22023', message = 'invalid routing claim';
  end if;

  return query
  with claimed as (
    select command.command_id
    from avalon_private.routing_commands command
    where command.state in ('pending', 'dispatching')
      and command.not_before <= now()
    order by command.not_before, command.command_id
    for update skip locked
    limit p_limit
  ), updated as (
    update avalon_private.routing_commands command
    set state = 'dispatching', attempt_count = command.attempt_count + 1
    from claimed
    where command.command_id = claimed.command_id
    returning command.*
  ), attempts as (
    insert into avalon_private.routing_command_attempts (
      command_id, attempt_no, dispatcher_workflow_id
    )
    select updated.command_id, updated.attempt_count, p_dispatcher_workflow_id
    from updated
    returning routing_command_attempts.command_id, routing_command_attempts.attempt_no
  )
  select updated.command_id, updated.workspace_id, updated.route_epoch,
    updated.target_shard_id, updated.operation_kind, updated.payload_version,
    updated.payload, updated.payload_hash, attempts.attempt_no
  from updated
  join attempts using (command_id);
end
$$;

create or replace function avalon_private.acknowledge_routing_command(
  p_command_id uuid,
  p_attempt_no integer,
  p_workspace_id uuid,
  p_route_epoch bigint,
  p_target_shard_id text,
  p_regional_receipt_id uuid,
  p_regional_state text,
  p_response_hash bytea
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  command avalon_private.routing_commands%rowtype;
begin
  select * into command
  from avalon_private.routing_commands
  where routing_commands.command_id = p_command_id
  for update;

  if not found or command.workspace_id <> p_workspace_id
     or command.route_epoch <> p_route_epoch
     or command.target_shard_id <> p_target_shard_id
     or octet_length(p_response_hash) <> 32 then
    raise exception using errcode = 'P0001', message = 'routing receipt fence mismatch';
  end if;

  insert into avalon_private.routing_command_receipts (
    command_id, workspace_id, route_epoch, target_shard_id,
    regional_receipt_id, regional_state, response_hash
  ) values (
    p_command_id, p_workspace_id, p_route_epoch, p_target_shard_id,
    p_regional_receipt_id, p_regional_state, p_response_hash
  )
  on conflict (command_id) do update
    set regional_receipt_id = excluded.regional_receipt_id,
        regional_state = excluded.regional_state,
        response_hash = excluded.response_hash,
        observed_at = now()
  where routing_command_receipts.workspace_id = excluded.workspace_id
    and routing_command_receipts.route_epoch = excluded.route_epoch
    and routing_command_receipts.target_shard_id = excluded.target_shard_id
    and routing_command_receipts.response_hash = excluded.response_hash;

  if not found then
    raise exception using errcode = '23505', message = 'conflicting routing receipt';
  end if;

  update avalon_private.routing_command_attempts
  set finished_at = now(), outcome = 'delivered'
  where routing_command_attempts.command_id = p_command_id
    and routing_command_attempts.attempt_no = p_attempt_no;

  update avalon_private.routing_commands
  set state = 'acknowledged', acknowledged_at = coalesce(acknowledged_at, now())
  where routing_commands.command_id = p_command_id;
end
$$;

revoke all on function avalon_private.claim_routing_commands(text, integer) from public;
revoke all on function avalon_private.acknowledge_routing_command(uuid, integer, uuid, bigint, text, uuid, text, bytea) from public;
grant execute on function avalon_private.claim_routing_commands(text, integer) to avalon_global_router;
grant execute on function avalon_private.acknowledge_routing_command(uuid, integer, uuid, bigint, text, uuid, text, bytea) to avalon_global_router;

revoke all on all tables in schema avalon_private from anon, authenticated, avalon_global_router;
grant select on avalon_private.global_accounts,
  avalon_private.organizations,
  avalon_private.organization_members,
  avalon_private.organization_invitations,
  avalon_private.billing_customers,
  avalon_private.organization_entitlements,
  avalon_private.workspace_routes,
  avalon_private.regional_shards
to authenticated;

alter default privileges in schema avalon_private revoke all on tables from public, anon, authenticated;
alter default privileges in schema avalon_private revoke execute on functions from public;
alter default privileges in schema api revoke all on tables from public, anon;
alter default privileges in schema api revoke execute on functions from public, anon;
