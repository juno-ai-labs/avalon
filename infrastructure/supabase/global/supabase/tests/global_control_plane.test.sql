begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

select has_schema('avalon_private', 'private schema exists');
select has_schema('api', 'Data API schema exists');
select has_table('avalon_private', 'global_accounts', 'global accounts exist');
select has_table('avalon_private', 'regional_shards', 'shard directory exists');
select has_table('avalon_private', 'workspace_routes', 'workspace routes exist');
select has_table('avalon_private', 'routing_commands', 'routing outbox exists');
select has_function('avalon_private', 'claim_routing_commands', array['text', 'integer'], 'claim RPC exists');
select has_function('avalon_private', 'acknowledge_routing_command', 'ack RPC exists');
select ok(
  avalon_private.uuid_v7()::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  'database IDs are UUIDv7'
);
select is(
  avalon_private.uuid_v7_from(
    1108152157446,
    decode('ffeeddccbbaaab88ff66554433221100', 'hex')
  )::text,
  '01020304-0506-7b88-bf66-554433221100',
  'global and TypeScript UUIDv7 builders share the same byte contract'
);
select ok(
  not has_table_privilege('authenticated', 'avalon_private.routing_commands', 'SELECT'),
  'authenticated users cannot read routing commands'
);
select ok(
  has_table_privilege('authenticated', 'api.workspace_routes', 'SELECT'),
  'authenticated users can read the invoker route view'
);
select ok(
  not has_function_privilege('public', 'avalon_private.claim_routing_commands(text,integer)', 'EXECUTE'),
  'public cannot claim routing commands'
);

select has_table('avalon_private', 'workspace_invitations', 'workspace invitation authority exists');
select has_function(
  'avalon_private', 'create_workspace_route_command',
  array['uuid', 'uuid', 'text', 'text', 'text', 'jsonb'],
  'workspace route mutation and outbox append share one command'
);

insert into auth.users (id, aud, role, email, created_at, updated_at)
values ('018f3000-0000-7000-8000-000000000001', 'authenticated', 'authenticated',
  'router@example.test', now(), now());
insert into avalon_private.global_accounts (
  platform_user_id, auth_user_id, issuer, subject
) values (
  '018f3000-0000-7000-8000-000000000101',
  '018f3000-0000-7000-8000-000000000001', 'https://id.test', 'router'
);
insert into avalon_private.organizations (id, name, created_by)
values ('018f3000-0000-7000-8000-000000000201', 'Routing tests',
  '018f3000-0000-7000-8000-000000000101');
insert into avalon_private.regional_shards (
  shard_id, region_key, lifecycle, capacity_class, api_origin_id,
  realtime_origin_id, min_schema_version, max_schema_version, route_public_key_id
) values (
  'global-us-1', 'global', 'active', 'standard', 'api-global',
  'realtime-global', 1, 1, 'route-key-1'
);

select lives_ok(
  $$select avalon_private.create_workspace_route_command(
    '018f3000-0000-7000-8000-000000000301',
    '018f3000-0000-7000-8000-000000000201',
    'global', 'global-us-1', 'route-create-1',
    '{"version":1,"name":"Test workspace"}'::jsonb
  )$$,
  'workspace route and routing command commit atomically'
);
select is(
  (select payload_hash from avalon_private.routing_commands
    where workspace_id = '018f3000-0000-7000-8000-000000000301'),
  extensions.digest(convert_to('{"name": "Test workspace", "version": 1}', 'utf8'), 'sha256'),
  'routing command records the canonical original payload hash'
);
select lives_ok(
  $$select * from avalon_private.claim_routing_commands('dispatcher-test-1', 1)$$,
  'dispatcher creates a current delivery attempt'
);
select throws_ok(
  $$select avalon_private.acknowledge_routing_command(
    (select command_id from avalon_private.routing_commands), 1,
    '018f3000-0000-7000-8000-000000000301', 1, 'global-us-1',
    extensions.digest(convert_to('wrong payload', 'utf8'), 'sha256'),
    '018f3000-0000-7000-8000-000000000401', 'writable',
    extensions.digest(convert_to('response', 'utf8'), 'sha256')
  )$$,
  'P0001', 'routing receipt fence mismatch',
  'an acknowledgement cannot substitute a different original payload'
);
select lives_ok(
  $$select avalon_private.acknowledge_routing_command(
    (select command_id from avalon_private.routing_commands), 1,
    '018f3000-0000-7000-8000-000000000301', 1, 'global-us-1',
    (select payload_hash from avalon_private.routing_commands),
    '018f3000-0000-7000-8000-000000000401', 'writable',
    extensions.digest(convert_to('response', 'utf8'), 'sha256')
  )$$,
  'the current attempt can acknowledge the matching regional receipt'
);
select is(
  (select state from avalon_private.routing_commands),
  'acknowledged',
  'acknowledgement closes the routing command'
);
select throws_ok(
  $$select avalon_private.acknowledge_routing_command(
    (select command_id from avalon_private.routing_commands), 1,
    '018f3000-0000-7000-8000-000000000301', 1, 'global-us-1',
    (select payload_hash from avalon_private.routing_commands),
    '018f3000-0000-7000-8000-000000000401', 'writable',
    extensions.digest(convert_to('response', 'utf8'), 'sha256')
  )$$,
  '40001', 'routing attempt is not current',
  'a finished delivery attempt cannot be acknowledged twice'
);

select * from finish();
rollback;
