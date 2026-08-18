begin;
select plan(32);

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
  '{"version":1,"name":"Command workspace"}'::jsonb,
  extensions.digest(convert_to('{"name": "Command workspace", "version": 1}', 'utf8'), 'sha256')
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
    'Please inspect the slow request', 'message-1', 'queue', 1
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
    'Please inspect the slow request', 'message-1', 'queue', 1
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
  'finalization seals one assistant part without releasing run ownership'
);
select is(
  (select count(*)::bigint from avalon_private.conversation_parts),
  2::bigint,
  'finalization adds exactly one assistant part'
);
select is(
  (select state from avalon_private.agent_runs),
  'running',
  'output sealing cannot bypass the terminal settlement command'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '018f0000-0000-7000-8000-000000000002', true);
select is(
  (select count(*)::bigint from api.workstream_sidebar),
  0::bigint,
  'an authenticated outsider sees no workspace sidebar rows'
);

reset role;
select set_config('request.jwt.claim.sub', '', true);
insert into avalon_private.workspace_members (
  workspace_id, platform_user_id, role, state, joined_at
) values (
  '018f0000-0000-7000-8000-000000000301',
  '018f0000-0000-7000-8000-000000000102', 'guest', 'active', now()
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '018f0000-0000-7000-8000-000000000002', true);
select is(
  (select count(*)::bigint from api.workstream_sidebar),
  1::bigint,
  'a workspace guest can view a workspace-mode work stream'
);
select throws_ok(
  $$select * from api.append_user_message(
    (select id from api.workstreams where title = 'Investigate latency'),
    (select root_substream_id from api.workstreams where title = 'Investigate latency'),
    'A guest must not contribute', 'guest-message-denied', 'queue',
    (select revision from api.workstreams where title = 'Investigate latency')
  )$$,
  '42501', 'substream contribution denied',
  'workspace membership capability is enforced before workstream access mode'
);

reset role;
select set_config('request.jwt.claim.sub', '018f0000-0000-7000-8000-000000000002', true);
select is(
  avalon_private.can_access_container(
    'workspace', '018f0000-0000-7000-8000-000000000301', 'administer'
  ),
  false,
  'a workspace guest cannot satisfy an administer container capability'
);
select set_config('request.jwt.claim.sub', '018f0000-0000-7000-8000-000000000001', true);
select is(
  avalon_private.can_access_container(
    'workspace', '018f0000-0000-7000-8000-000000000301', 'administer'
  ),
  true,
  'a workspace owner satisfies the administer container capability'
);
set local role authenticated;
select is(
  (api.set_workstream_access_mode(
    (select id from api.workstreams where title = 'Investigate latency'),
    'restricted', 1, 'restrict-stream-1'
  ) ->> 'access_revision')::bigint,
  2::bigint,
  'changing access mode rotates the workstream authorization fence'
);

reset role;
select set_config('request.jwt.claim.sub', '', true);
select is(
  (select state from avalon_private.agent_runs),
  'interrupting',
  'an access change durably interrupts an active loop'
);
select is(
  (select signal_kind from avalon_private.run_signals
    where operation_key = 'access-change:restrict-stream-1'),
  'cancel',
  'the interrupted loop receives a durable cancellation signal'
);
select matches(
  avalon_private.content_topic_for_substream(
    (select root_substream_id from avalon_private.workstreams where title = 'Investigate latency')
  ),
  ':1:2$',
  'the content topic includes current workspace and workstream access revisions'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '018f0000-0000-7000-8000-000000000002', true);
select is(
  (select count(*)::bigint from api.workstream_sidebar),
  0::bigint,
  'restriction immediately removes a workspace guest without a grant'
);

reset role;
select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '018f0000-0000-7000-8000-000000000001', true);
select is(
  (api.set_workstream_access(
    (select id from api.workstreams where title = 'Investigate latency'),
    '018f0000-0000-7000-8000-000000000102', 'view', 'active', 2,
    'grant-stream-view-1'
  ) ->> 'access_revision')::bigint,
  3::bigint,
  'an explicit grant rotates the fence again'
);
select is(
  (api.set_workstream_access(
    (select id from api.workstreams where title = 'Investigate latency'),
    '018f0000-0000-7000-8000-000000000102', 'view', 'active', 2,
    'grant-stream-view-1'
  ) ->> 'access_revision')::bigint,
  3::bigint,
  'an exact access-command retry resolves before the stale revision check'
);

reset role;
select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '018f0000-0000-7000-8000-000000000002', true);
select is(
  (select count(*)::bigint from api.conversation_parts),
  2::bigint,
  'a newly authorized viewer can read canonical history under live access'
);

select * from finish();
rollback;
