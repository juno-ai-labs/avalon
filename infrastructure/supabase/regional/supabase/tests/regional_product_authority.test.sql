begin;
create extension if not exists pgtap with schema extensions;
select plan(37);

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
select has_function('avalon_private', 'queue_health', 'queue health RPC exists');
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
  'database and TypeScript UUIDv7 builders share the same byte contract'
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
    where queue_name in ('workflow_starts', 'workflow_signals', 'connector_ingress',
      'sidebar_attention', 'derived_content', 'maintenance')),
  6::bigint,
  'six shared durable queues exist'
);
select is(
  (avalon_private.queue_health() ->> 'ready')::boolean,
  true,
  'queue health proves all queues and regional Cron are active'
);
select is(
  (select count(*)::bigint from storage.buckets
    where id in ('workspace-content', 'connector-ingress', 'exports')),
  0::bigint,
  'SQL migrations leave managed bucket provisioning to the Storage API'
);

create temporary table queue_lease_message as
select pgmq.send('maintenance', '{"version":1,"job":"lease-test"}'::jsonb) as message_id;
create temporary table queue_lease_delivery as
select * from avalon_private.queue_read('maintenance', 60, 1);
create temporary table queue_lease_claim as
select avalon_private.queue_claim_inbox(
  'maintenance', 'lease-test', message_id,
  extensions.digest(convert_to('{"job": "lease-test", "version": 1}', 'utf8'), 'sha256')
) as value
from queue_lease_delivery;
select is(
  (select value ->> 'state' from queue_lease_claim),
  'acquired',
  'the first inbox delivery receives an opaque lease claim'
);
select is(
  (avalon_private.queue_claim_inbox(
    'maintenance', 'lease-test', (select message_id from queue_lease_delivery),
    extensions.digest(convert_to('{"job": "lease-test", "version": 1}', 'utf8'), 'sha256')
  ) ->> 'state'),
  'busy',
  'a second delivery cannot concurrently acquire a live semantic lease'
);
select is(
  avalon_private.queue_set_visibility(
    'maintenance', 'lease-test', (select message_id from queue_lease_delivery),
    extensions.digest(convert_to('{"job": "lease-test", "version": 1}', 'utf8'), 'sha256'),
    '018f2000-0000-7000-8000-000000000999', 60
  ),
  false,
  'a stale lease token cannot renew queue visibility'
);
select is(
  avalon_private.queue_set_visibility(
    'maintenance', 'lease-test', (select message_id from queue_lease_delivery),
    extensions.digest(convert_to('{"job": "lease-test", "version": 1}', 'utf8'), 'sha256'),
    (select (value ->> 'claim_token')::uuid from queue_lease_claim), 60
  ),
  true,
  'the current lease owner can renew queue visibility'
);
select is(
  avalon_private.queue_complete_inbox(
    'maintenance', 'lease-test', (select message_id from queue_lease_delivery),
    extensions.digest(convert_to('{"job": "lease-test", "version": 1}', 'utf8'), 'sha256'),
    '018f2000-0000-7000-8000-000000000999', null
  ),
  false,
  'a stale lease token cannot complete an inbox receipt'
);
select is(
  avalon_private.queue_complete_inbox(
    'maintenance', 'lease-test', (select message_id from queue_lease_delivery),
    extensions.digest(convert_to('{"job": "lease-test", "version": 1}', 'utf8'), 'sha256'),
    (select (value ->> 'claim_token')::uuid from queue_lease_claim), null
  ),
  true,
  'the current lease owner alone can complete the inbox receipt'
);

create temporary table queue_dead_letter_message as
select pgmq.send('maintenance', '{"version":1,"job":"dead-letter-test"}'::jsonb) as message_id;
create temporary table queue_dead_letter_first_claim as
select avalon_private.queue_claim_inbox(
  'maintenance', 'dead-letter-test', message_id,
  extensions.digest(convert_to('{"job": "dead-letter-test", "version": 1}', 'utf8'), 'sha256')
) as value
from queue_dead_letter_message;
update avalon_private.queue_inbox_receipts
set lease_expires_at = now() - interval '1 second'
where queue_name = 'maintenance' and semantic_key = 'dead-letter-test';
create temporary table queue_dead_letter_second_claim as
select avalon_private.queue_claim_inbox(
  'maintenance', 'dead-letter-test', message_id,
  extensions.digest(convert_to('{"job": "dead-letter-test", "version": 1}', 'utf8'), 'sha256')
) as value
from queue_dead_letter_message;
select isnt(
  (select value ->> 'claim_token' from queue_dead_letter_first_claim),
  (select value ->> 'claim_token' from queue_dead_letter_second_claim),
  'an expired receipt is reacquired with a different opaque claim token'
);
select is(
  avalon_private.queue_dead_letter(
    'maintenance', (select message_id from queue_dead_letter_message), 'dead-letter-test',
    extensions.digest(convert_to('{"job": "dead-letter-test", "version": 1}', 'utf8'), 'sha256'),
    (select (value ->> 'claim_token')::uuid from queue_dead_letter_first_claim),
    '{"version":1,"job":"dead-letter-test"}'::jsonb, 'test_failure', 10
  ),
  false,
  'an expired owner cannot dead-letter a successor claim'
);
select is(
  avalon_private.queue_dead_letter(
    'maintenance', (select message_id from queue_dead_letter_message), 'dead-letter-test',
    extensions.digest(convert_to('{"job": "dead-letter-test", "version": 1}', 'utf8'), 'sha256'),
    (select (value ->> 'claim_token')::uuid from queue_dead_letter_second_claim),
    '{"version":1,"job":"dead-letter-test"}'::jsonb, 'test_failure', 10
  ),
  true,
  'the live owner can atomically quarantine and archive its delivery'
);
select is(
  (select state from avalon_private.queue_inbox_receipts
    where queue_name = 'maintenance' and semantic_key = 'dead-letter-test'),
  'quarantined',
  'dead-lettering terminally quarantines the inbox receipt'
);

select * from finish();
rollback;
