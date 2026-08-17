begin;
select plan(16);

insert into auth.users (id, aud, role, email, created_at, updated_at)
values ('018f2000-0000-7000-8000-000000000001', 'authenticated', 'authenticated',
  'activity@example.test', now(), now());
select avalon_private.link_platform_identity(
  '018f2000-0000-7000-8000-000000000001',
  'https://id.test', 'activity-user', '018f2000-0000-7000-8000-000000000101', 1
);
select * from avalon_private.apply_global_workspace_command(
  '018f2000-0000-7000-8000-000000000201',
  '018f2000-0000-7000-8000-000000000301',
  1, 'global-us-1', 'global', 'create_workspace',
  extensions.digest(convert_to('create-activity-test', 'utf8'), 'sha256')
);
insert into avalon_private.workspace_members (
  workspace_id, platform_user_id, role, state, joined_at
) values (
  '018f2000-0000-7000-8000-000000000301',
  '018f2000-0000-7000-8000-000000000101', 'owner', 'active', now()
);
insert into avalon_private.connector_installations (
  id, workspace_id, provider, external_installation_id, credential_ref
) values (
  '018f2000-0000-7000-8000-000000000401',
  '018f2000-0000-7000-8000-000000000301',
  'slack', 'team-1', 'vault://connector/team-1'
);

select lives_ok(
  $$select avalon_private.accept_connector_ingress(
    '018f2000-0000-7000-8000-000000000301',
    '018f2000-0000-7000-8000-000000000401',
    'provider-event-1',
    extensions.digest(convert_to('{"event":"message"}', 'utf8'), 'sha256'),
    19, convert_to('{"event":"message"}', 'utf8'), null,
    'slack-events-v1', 'slack-signature-v1'
  )$$,
  'a verified connector webhook is durably accepted'
);
select is(
  (select state from avalon_private.ingress_receipts where provider_event_id = 'provider-event-1'),
  'queued',
  'ingress is queued in the same transaction as its receipt'
);
select is(
  (select count(*)::bigint from pgmq.q_connector_ingress),
  1::bigint,
  'the logged connector queue contains one identifier-only wake'
);
select is(
  (avalon_private.accept_connector_ingress(
    '018f2000-0000-7000-8000-000000000301',
    '018f2000-0000-7000-8000-000000000401',
    'provider-event-1',
    extensions.digest(convert_to('{"event":"message"}', 'utf8'), 'sha256'),
    19, convert_to('{"event":"message"}', 'utf8'), null,
    'slack-events-v1', 'slack-signature-v1'
  ) ->> 'duplicate')::boolean,
  true,
  'an exact provider retry resolves to the original receipt'
);
select is(
  (select count(*)::bigint from avalon_private.ingress_receipts),
  1::bigint,
  'an exact provider retry creates no duplicate receipt'
);

select lives_ok(
  $$select avalon_private.commit_connector_activity(
    (select id from avalon_private.ingress_receipts where provider_event_id = 'provider-event-1'),
    'normalizer-v1',
    jsonb_build_array(jsonb_build_object(
      'id', '018f2000-0000-7000-8000-000000000501',
      'event_kind', 'message_created',
      'actor_kind', 'slack_user',
      'actor_ref', 'U123',
      'object_kind', 'slack_message',
      'object_ref', 'C123:1700000000.000100',
      'provider_occurred_at', '2026-08-17T08:00:00Z',
      'source_version', '1700000000.000100',
      'payload', jsonb_build_object('text', 'Please investigate latency'),
      'access_container_kind', 'workspace',
      'access_container_id', '018f2000-0000-7000-8000-000000000301'
    ))
  )$$,
  'the normalizer commits a bounded activity batch atomically'
);
select is(
  (select state from avalon_private.ingress_receipts where provider_event_id = 'provider-event-1'),
  'normalized',
  'the receipt records successful normalization'
);
select is(
  (select count(*)::bigint from api.activity_events),
  1::bigint,
  'one workspace-owned activity event is canonical'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '018f2000-0000-7000-8000-000000000001', true);
select is(
  (select count(*)::bigint from api.activity_events),
  1::bigint,
  'the existing identity system mapping drives activity RLS'
);
reset role;
select set_config('request.jwt.claim.sub', '', true);

select is(
  (avalon_private.accept_connector_ingress(
    '018f2000-0000-7000-8000-000000000301',
    '018f2000-0000-7000-8000-000000000401',
    'provider-event-1',
    extensions.digest(convert_to('{"event":"different"}', 'utf8'), 'sha256'),
    21, convert_to('{"event":"different"}', 'utf8'), null,
    'slack-events-v1', 'slack-signature-v1'
  ) ->> 'conflict')::boolean,
  true,
  'reusing a provider event ID with different bytes is quarantined'
);
select is(
  (select count(*)::bigint from avalon_private.ingress_receipt_conflicts),
  1::bigint,
  'conflicting evidence is retained separately from canonical activity'
);

insert into avalon_private.suggestions (
  id, workspace_id, kind, target_user_id,
  access_container_kind, access_container_id,
  title, summary, detector_version, model_version, prompt_version,
  semantic_key, score, source_watermark, access_revision, scope_revision,
  expires_at
) values (
  '018f2000-0000-7000-8000-000000000601',
  '018f2000-0000-7000-8000-000000000301',
  'workstream', '018f2000-0000-7000-8000-000000000101',
  'workspace', '018f2000-0000-7000-8000-000000000301',
  'Investigate latency', 'A connector message asks for a latency investigation.',
  'detector-v1', 'model-v1', 'prompt-v1', 'latency-investigation',
  0.9, 1, 1, 1, now() + interval '1 day'
);
insert into avalon_private.suggestion_sources (
  suggestion_id, activity_event_id, source_revision, content_hash
) values (
  '018f2000-0000-7000-8000-000000000601',
  '018f2000-0000-7000-8000-000000000501', 1,
  (select content_hash from avalon_private.activity_events
    where id = '018f2000-0000-7000-8000-000000000501')
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '018f2000-0000-7000-8000-000000000001', true);
select is(
  (select count(*)::bigint from api.suggestions),
  1::bigint,
  'the authorized user sees the activity-derived suggestion'
);
select lives_ok(
  $$select api.decide_suggestion(
    '018f2000-0000-7000-8000-000000000601', 'shown', 'suggestion-shown-1'
  )$$,
  'showing a suggestion is a durable idempotent decision'
);
select lives_ok(
  $$select api.decide_suggestion(
    '018f2000-0000-7000-8000-000000000601', 'accepted', 'suggestion-accepted-1'
  )$$,
  'accepting a workstream suggestion creates the workstream atomically'
);
select is(
  (select count(*)::bigint from api.workstreams where title = 'Investigate latency'),
  1::bigint,
  'accepted suggested work appears as an ordinary workstream'
);
select is(
  (api.decide_suggestion(
    '018f2000-0000-7000-8000-000000000601', 'accepted', 'suggestion-accepted-1'
  ) ->> 'decision'),
  'accepted',
  'an acceptance retry returns the original decision receipt'
);

select * from finish();
rollback;
