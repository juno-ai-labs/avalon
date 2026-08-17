begin;
select plan(34);

insert into auth.users (id, aud, role, email, created_at, updated_at)
values ('018f1000-0000-7000-8000-000000000001', 'authenticated', 'authenticated',
  'controller@example.test', now(), now());
select avalon_private.link_platform_identity(
  '018f1000-0000-7000-8000-000000000001',
  'https://id.test', 'controller', '018f1000-0000-7000-8000-000000000101', 1
);
select * from avalon_private.apply_global_workspace_command(
  '018f1000-0000-7000-8000-000000000201',
  '018f1000-0000-7000-8000-000000000301',
  1, 'global-us-1', 'global', 'create_workspace',
  extensions.digest(convert_to('create-control-test', 'utf8'), 'sha256')
);
insert into avalon_private.workspace_members (
  workspace_id, platform_user_id, role, state, joined_at
) values (
  '018f1000-0000-7000-8000-000000000301',
  '018f1000-0000-7000-8000-000000000101', 'owner', 'active', now()
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '018f1000-0000-7000-8000-000000000001', true);
select * from api.create_workstream(
  '018f1000-0000-7000-8000-000000000301',
  'Run control', 'Exercise queue and steer', 'control-create'
);
select * from api.append_user_message(
  (select id from api.workstreams where title = 'Run control'),
  (select root_substream_id from api.workstreams where title = 'Run control'),
  'First input', 'control-message-1'
);

reset role;
select set_config('request.jwt.claim.sub', '', true);
select lives_ok(
  $$select * from avalon_private.workflow_claim_run(
    (select active_run_id from avalon_private.workstreams where title = 'Run control'),
    1,
    (select workflow_instance_id from avalon_private.agent_runs
      where id = (select active_run_id from avalon_private.workstreams where title = 'Run control'))
  )$$,
  'first full loop is claimed'
);
select is(
  jsonb_array_length(avalon_private.workflow_materialize_run(
    (select active_run_id from avalon_private.workstreams where title = 'Run control'), 1
  ) -> 'parts'),
  1,
  'materialization begins with exactly the admitted user part'
);
select * from avalon_private.workflow_begin_action(
  (select active_run_id from avalon_private.workstreams where title = 'Run control'),
  1, 'model', 'control/run-1/model-1'
);
select lives_ok(
  $$select * from avalon_private.workflow_begin_output_attempt(
    (select active_run_id from avalon_private.workstreams where title = 'Run control'),
    (select id from avalon_private.agent_actions where operation_id = 'control/run-1/model-1'),
    1,
    '018f1000-0000-7000-8000-000000000401',
    '018f1000-0000-7000-8000-000000000402',
    now() + interval '1 hour'
  )$$,
  'model output reserves its transcript position before streaming'
);
select is(
  (select reserved_seq from avalon_private.active_output_attempts
    where attempt_id = '018f1000-0000-7000-8000-000000000401'),
  2::bigint,
  'the provisional assistant output owns sequence two'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '018f1000-0000-7000-8000-000000000001', true);
select lives_ok(
  $$select * from api.append_user_message(
    (select id from api.workstreams where title = 'Run control'),
    (select root_substream_id from api.workstreams where title = 'Run control'),
    'Wait until the current answer is done', 'control-message-2', 'queue',
    (select revision from api.workstreams where title = 'Run control')
  )$$,
  'an explicit queue message commits without interrupting the active model'
);
reset role;
select set_config('request.jwt.claim.sub', '', true);
select is(
  (select control_revision from avalon_private.agent_runs
    where id = (select active_run_id from avalon_private.workstreams where title = 'Run control')),
  1::bigint,
  'queueing does not advance the run control fence'
);
select is(
  (select seq from avalon_private.conversation_parts where source_operation_key = 'control-message-2'),
  3::bigint,
  'the queued message sorts after the reserved assistant response'
);
select is(
  (select state from avalon_private.input_admission_batches
    where first_seq = 3 and workstream_id = (select id from avalon_private.workstreams where title = 'Run control')),
  'pending',
  'queued input remains durably pending while the first loop runs'
);
select lives_ok(
  $$select avalon_private.checkpoint_active_output(
    (select id from avalon_private.agent_runs where workflow_instance_id like 'workstream/%/run/%' order by created_at limit 1),
    '018f1000-0000-7000-8000-000000000401',
    0, 0, 1, 1, 'first answer', 2,
    extensions.digest(convert_to('first answer', 'utf8'), 'sha256'),
    null, '[]'::jsonb
  )$$,
  'the active model still checkpoints after a non-steering message'
);
select is(
  (select payload ->> 'text' from realtime.messages
    where event = 'output_checkpoint' order by inserted_at desc limit 1),
  'first answer',
  'stream Broadcast carries the actual committed text'
);
select is(
  (select jsonb_array_length(payload -> 'previous_batches') from realtime.messages
    where event = 'output_checkpoint' order by inserted_at desc limit 1),
  0,
  'stream Broadcast carries the verified overlap window'
);
select lives_ok(
  $$select avalon_private.finalize_active_output(
    (select id from avalon_private.agent_runs where workflow_instance_id like 'workstream/%/run/%' order by created_at limit 1),
    '018f1000-0000-7000-8000-000000000401',
    1, 12, extensions.digest(convert_to('first answer', 'utf8'), 'sha256'),
    null, true
  )$$,
  'the first response seals in its reserved sequence'
);
select is(
  (select inline_text from avalon_private.conversation_parts where seq = 2
    and workstream_id = (select id from avalon_private.workstreams where title = 'Run control')),
  'first answer',
  'reserved sequence is filled without reordering the queued input'
);
select is(
  (select state from avalon_private.workstreams where title = 'Run control'),
  'active',
  'a completed loop does not complete the work stream lifecycle'
);
select is(
  (select active_run_id from avalon_private.workstreams where title = 'Run control'),
  (select id from avalon_private.agent_runs order by created_at limit 1),
  'final output keeps the old run as owner until terminal settlement'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '018f1000-0000-7000-8000-000000000001', true);
select lives_ok(
  $$select * from api.append_user_message(
    (select id from api.workstreams where title = 'Run control'),
    (select root_substream_id from api.workstreams where title = 'Run control'),
    'Queue this behind the earlier follow-up', 'control-message-2b', 'queue',
    (select revision from api.workstreams where title = 'Run control')
  )$$,
  'input arriving after final output still joins the pending successor batch'
);
reset role;
select set_config('request.jwt.claim.sub', '', true);
select is(
  (select count(*)::bigint from avalon_private.agent_runs),
  1::bigint,
  'post-output input cannot overtake the pending batch by creating a new run'
);
select is(
  (select last_seq from avalon_private.input_admission_batches
    where first_seq = 3 and state = 'pending'),
  4::bigint,
  'the one pending batch extends through input received during settlement'
);
select lives_ok(
  $$select avalon_private.workflow_finish_run(
    (select id from avalon_private.agent_runs order by created_at limit 1),
    1, 'completed', 'answer_complete', null
  )$$,
  'terminal settlement admits the next queued batch'
);
select is(
  (select count(*)::bigint from avalon_private.agent_runs),
  2::bigint,
  'queued input creates exactly one successor full loop'
);
select is(
  (select state from avalon_private.input_admission_batches where first_seq = 3),
  'admitted',
  'the successor loop owns the queued batch'
);

select lives_ok(
  $$select * from avalon_private.workflow_claim_run(
    (select active_run_id from avalon_private.workstreams where title = 'Run control'),
    1,
    (select workflow_instance_id from avalon_private.agent_runs
      where id = (select active_run_id from avalon_private.workstreams where title = 'Run control'))
  )$$,
  'the successor full loop is claimable'
);
select * from avalon_private.workflow_begin_action(
  (select active_run_id from avalon_private.workstreams where title = 'Run control'),
  1, 'model', 'control/run-2/model-1'
);
select * from avalon_private.workflow_begin_output_attempt(
  (select active_run_id from avalon_private.workstreams where title = 'Run control'),
  (select id from avalon_private.agent_actions where operation_id = 'control/run-2/model-1'),
  1,
  '018f1000-0000-7000-8000-000000000411',
  '018f1000-0000-7000-8000-000000000412',
  now() + interval '1 hour'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '018f1000-0000-7000-8000-000000000001', true);
select lives_ok(
  $$select * from api.append_user_message(
    (select id from api.workstreams where title = 'Run control'),
    (select root_substream_id from api.workstreams where title = 'Run control'),
    'Stop and use this correction', 'control-message-3', 'steer',
    (select revision from api.workstreams where title = 'Run control')
  )$$,
  'a steering message commits and advances the control fence'
);
reset role;
select set_config('request.jwt.claim.sub', '', true);
select is(
  (select control_revision from avalon_private.agent_runs
    where id = (select active_run_id from avalon_private.workstreams where title = 'Run control')),
  2::bigint,
  'steering advances control revision exactly once'
);
select is(
  (avalon_private.checkpoint_active_output(
    (select active_run_id from avalon_private.workstreams where title = 'Run control'),
    '018f1000-0000-7000-8000-000000000411',
    0, 0, 1, 1, 'stale', 1,
    extensions.digest(convert_to('stale', 'utf8'), 'sha256'),
    null, '[]'::jsonb
  ) ->> 'superseded')::boolean,
  true,
  'the next checkpoint atomically supersedes stale output'
);
select is(
  (select status from avalon_private.active_output_attempts
    where attempt_id = '018f1000-0000-7000-8000-000000000411'),
  'superseded',
  'superseded output remains recoverable but cannot seal'
);
select is(
  jsonb_array_length(avalon_private.workflow_materialize_run(
    (select active_run_id from avalon_private.workstreams where title = 'Run control'), 2
  ) -> 'parts'),
  5,
  'rematerialization includes all committed inputs and excludes provisional output'
);
select avalon_private.workflow_observe_signal(
  (select active_run_id from avalon_private.workstreams where title = 'Run control'),
  (select id from avalon_private.run_signals where operation_key = 'control-message-3'),
  2
);
select is(
  (select state from avalon_private.agent_runs
    where id = (select active_run_id from avalon_private.workstreams where title = 'Run control')),
  'running',
  'observing the last steering signal resumes the loop at the new fence'
);

select * from avalon_private.workflow_begin_action(
  (select active_run_id from avalon_private.workstreams where title = 'Run control'),
  2, 'tool', 'control/run-2/tool-1'
);
select lives_ok(
  $$select avalon_private.workflow_begin_tool_effect(
    (select active_run_id from avalon_private.workstreams where title = 'Run control'),
    (select id from avalon_private.agent_actions where operation_id = 'control/run-2/tool-1'),
    2, 'read', 'fetch-1', 'control/run-2/tool-1/effect-1',
    extensions.digest(convert_to('{"path":"README.md"}', 'utf8'), 'sha256')
  )$$,
  'a tool effect begins only after the new control fence is observed'
);
select * from avalon_private.workflow_settle_tool_effect(
  (select id from avalon_private.tool_effects where operation_id = 'control/run-2/tool-1/effect-1'),
  'succeeded', 'provider-read-1',
  extensions.digest(convert_to('{"text":"ok"}', 'utf8'), 'sha256')
);
select lives_ok(
  $$select avalon_private.workflow_commit_tool_exchange(
    (select active_run_id from avalon_private.workstreams where title = 'Run control'),
    (select id from avalon_private.agent_actions where operation_id = 'control/run-2/tool-1'),
    2, 'provider-call-1', 'read_file', 'terminal',
    '{"path":"README.md"}'::jsonb, '{"text":"ok"}'::jsonb, true
  )$$,
  'tool call and result commit in one transaction'
);
select is(
  (select result.seq - call.seq
   from avalon_private.conversation_parts call
   join avalon_private.conversation_parts result
     on result.related_part_id = call.id
   where call.provider_call_id = 'provider-call-1' and call.kind = 'tool_call'),
  1::bigint,
  'no user message can be sequenced between a tool call and its result'
);
select is(
  (select count(*)::bigint from avalon_private.conversation_parts
    where provider_call_id = 'provider-call-1'),
  2::bigint,
  'the provider call has exactly one call/result pair'
);
select is(
  (select payload -> 'result' ->> 'text' from realtime.messages
    where event = 'tool_exchange' order by inserted_at desc limit 1),
  'ok',
  'tool Broadcast carries the actual bounded result content'
);
select is(
  (select payload -> 'previous_batches' -> 1 ->> 'text' from realtime.messages
    where event = 'tool_exchange' order by inserted_at desc limit 1),
  'Stop and use this correction',
  'tool Broadcast overlaps the preceding committed content batch'
);

select * from finish();
rollback;
