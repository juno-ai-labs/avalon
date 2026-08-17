begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

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

select * from finish();
rollback;
