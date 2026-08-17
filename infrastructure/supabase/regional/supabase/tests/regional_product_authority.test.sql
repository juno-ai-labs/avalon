begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

select has_schema('avalon_private', 'private schema exists');
select has_schema('api', 'Data API schema exists');
select has_table('avalon_private', 'workstreams', 'work streams exist');
select has_table('avalon_private', 'workstream_user_state', 'sparse user overlays exist');
select has_table('avalon_private', 'substreams', 'substreams exist');
select has_table('avalon_private', 'conversation_parts', 'normalized parts exist');
select has_table('avalon_private', 'active_output_chunks', 'bounded output chunks exist');
select has_table('avalon_private', 'agent_runs', 'semantic run state exists');
select has_table('avalon_private', 'ingress_receipts', 'connector receipts exist');
select has_table('avalon_private', 'activity_events', 'workspace activity exists');
select has_table('avalon_private', 'suggestions', 'suggestions exist');
select has_table('avalon_private', 'content_embeddings', 'vector rows exist');
select has_function('api', 'create_workstream', 'create work-stream command exists');
select has_function('api', 'append_user_message', 'message admission command exists');
select has_function('avalon_private', 'checkpoint_active_output', 'output checkpoint RPC exists');
select has_function('avalon_private', 'queue_read', array['text', 'integer', 'integer'], 'least-privilege queue read exists');
select ok(
  avalon_private.uuid_v7()::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  'database IDs are UUIDv7'
);
select ok(
  not has_table_privilege('authenticated', 'avalon_private.command_receipts', 'SELECT'),
  'authenticated users cannot read command receipts'
);
select ok(
  not has_table_privilege('avalon_workflow_runner', 'avalon_private.agent_runs', 'UPDATE'),
  'Workflow role cannot update canonical tables directly'
);
select ok(
  has_function_privilege('avalon_workflow_runner',
    'avalon_private.checkpoint_active_output(uuid,uuid,bigint,bigint,bigint,bigint,text,bigint,bytea,jsonb,jsonb)', 'EXECUTE'),
  'Workflow role can execute only the checkpoint RPC'
);
select ok(
  not has_function_privilege('public',
    'avalon_private.checkpoint_active_output(uuid,uuid,bigint,bigint,bigint,bigint,text,bigint,bytea,jsonb,jsonb)', 'EXECUTE'),
  'public cannot checkpoint output'
);
select ok(
  has_table_privilege('authenticated', 'api.workstream_sidebar', 'SELECT'),
  'authenticated users can read the RLS invoker sidebar'
);
select is(
  (select count(*)::bigint from pgmq.list_queues()
    where queue_name in ('workflow_starts', 'connector_ingress', 'sidebar_attention', 'derived_content', 'maintenance')),
  5::bigint,
  'five shared durable queues exist'
);
select is(
  (select count(*)::bigint from storage.buckets
    where id in ('workspace-content', 'connector-ingress', 'exports') and not public),
  3::bigint,
  'all Avalon Storage buckets are private'
);

select * from finish();
rollback;
