begin;
select plan(20);

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('018f0000-0000-7000-8000-000000000001', 'authenticated', 'authenticated', 'member@example.test', now(), now()),
  ('018f0000-0000-7000-8000-000000000002', 'authenticated', 'authenticated', 'outsider@example.test', now(), now());

select avalon_private.link_platform_identity(
  '018f0000-0000-7000-8000-000000000001',
  'https://id.test', 'member', '018f0000-0000-7000-8000-000000000101', 1
);
select avalon_private.link_platform_identity(
  '018f0000-0000-7000-8000-000000000002',
  'https://id.test', 'outsider', '018f0000-0000-7000-8000-000000000102', 1
);

select * from avalon_private.apply_global_workspace_command(
  '018f0000-0000-7000-8000-000000000201',
  '018f0000-0000-7000-8000-000000000301',
  1, 'global-us-1', 'global', 'create_workspace',
  extensions.digest(convert_to('create', 'utf8'), 'sha256')
);
insert into avalon_private.workspace_members (
  workspace_id, platform_user_id, role, state, joined_at
) values (
  '018f0000-0000-7000-8000-000000000301',
  '018f0000-0000-7000-8000-000000000101',
  'owner', 'active', now()
);

select is(
  (select authority_state from avalon_private.workspace_route_gates
    where workspace_id = '018f0000-0000-7000-8000-000000000301'),
  'writable',
  'regional route gate is writable only after command receipt'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '018f0000-0000-7000-8000-000000000001', true);

select lives_ok(
  $$select * from api.create_workstream(
    '018f0000-0000-7000-8000-000000000301',
    'Investigate latency', 'Trace the regression', 'create-1'
  )$$,
  'authorized member creates one work stream atomically'
);
select is(
  (select count(*)::bigint from api.workstream_sidebar),
  1::bigint,
  'new work stream is immediately visible in the sidebar'
);
select is(
  (select lifecycle_family from api.workstream_sidebar limit 1),
  'in_progress',
  'new work stream appears in the in-progress collection'
);

select lives_ok(
  $$select * from api.append_user_message(
    (select id from api.workstreams where title = 'Investigate latency'),
    (select root_substream_id from api.workstreams where title = 'Investigate latency'),
    'Please inspect the slow request', 'message-1'
  )$$,
  'first message is admitted and starts one durable loop'
);
select is(
  (select count(*)::bigint from api.conversation_parts),
  1::bigint,
  'message is one immutable normalized part'
);

reset role;
select set_config('request.jwt.claim.sub', '', true);
select is(
  (select mode from avalon_private.input_admission_batches limit 1),
  'queue',
  'message without an active loop is queued for a new run'
);
select is(
  (select count(*)::bigint from avalon_private.agent_runs),
  1::bigint,
  'message admission creates one semantic full-loop run'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '018f0000-0000-7000-8000-000000000001', true);

select lives_ok(
  $$select * from api.append_user_message(
    (select id from api.workstreams where title = 'Investigate latency'),
    (select root_substream_id from api.workstreams where title = 'Investigate latency'),
    'Please inspect the slow request', 'message-1'
  )$$,
  'exact message retry returns its durable receipt'
);
select is(
  (select count(*)::bigint from api.conversation_parts),
  1::bigint,
  'message retry does not duplicate canonical content'
);

reset role;
select set_config('request.jwt.claim.sub', '', true);

select lives_ok(
  $$select * from avalon_private.workflow_claim_run(
    (select id from avalon_private.agent_runs), 1,
    (select workflow_instance_id from avalon_private.agent_runs)
  )$$,
  'Workflow claims the admitted loop through its fenced RPC'
);
select lives_ok(
  $$select * from avalon_private.workflow_begin_action(
    (select id from avalon_private.agent_runs), 1, 'model', 'run-1/action-1'
  )$$,
  'Workflow begins one semantic model action'
);
select lives_ok(
  $$select * from avalon_private.workflow_begin_output_attempt(
    (select id from avalon_private.agent_runs),
    (select id from avalon_private.agent_actions where operation_id = 'run-1/action-1'),
    1,
    '018f0000-0000-7000-8000-000000000401',
    '018f0000-0000-7000-8000-000000000402',
    now() + interval '1 hour'
  )$$,
  'Workflow opens a recoverable output attempt'
);
select lives_ok(
  $$select avalon_private.checkpoint_active_output(
    (select id from avalon_private.agent_runs),
    '018f0000-0000-7000-8000-000000000401',
    0, 0, 1, 1, 'hello', 1,
    extensions.digest(convert_to('hello', 'utf8'), 'sha256'),
    null, '[]'::jsonb
  )$$,
  'first output checkpoint persists one bounded delta'
);
select lives_ok(
  $$select avalon_private.checkpoint_active_output(
    (select id from avalon_private.agent_runs),
    '018f0000-0000-7000-8000-000000000401',
    0, 0, 1, 1, 'hello', 1,
    extensions.digest(convert_to('hello', 'utf8'), 'sha256'),
    null, '[]'::jsonb
  )$$,
  'timed-out checkpoint retry is idempotent'
);
select is(
  (select count(*)::bigint from avalon_private.active_output_chunks),
  1::bigint,
  'checkpoint retry does not duplicate a chunk'
);
select lives_ok(
  $$select avalon_private.finalize_active_output(
    (select id from avalon_private.agent_runs),
    '018f0000-0000-7000-8000-000000000401',
    1, 5, extensions.digest(convert_to('hello', 'utf8'), 'sha256'),
    null, true
  )$$,
  'finalization seals one assistant part and the terminal run atomically'
);
select is(
  (select count(*)::bigint from avalon_private.conversation_parts),
  2::bigint,
  'finalization adds exactly one assistant part'
);
select is(
  (select state from avalon_private.agent_runs),
  'completed',
  'full loop reaches a terminal semantic state'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '018f0000-0000-7000-8000-000000000002', true);
select is(
  (select count(*)::bigint from api.workstream_sidebar),
  0::bigint,
  'an authenticated outsider sees no workspace sidebar rows'
);

select * from finish();
rollback;
