begin;
select plan(12);

insert into avalon_private.migration_campaigns (
  id, kind, target_version, region_key, state, code_version,
  schema_min_version, schema_target_version, concurrency_limit,
  batch_size, created_by, started_at
) values (
  '018f5000-0000-7000-8000-000000000001', 'schema_backfill',
  'v2', 'global', 'running', 'test', 1, 2, 1, 100,
  '018f5000-0000-7000-8000-000000000002', now()
);
insert into avalon_private.migration_jobs (
  id, campaign_id, target_kind, target_start, target_end,
  campaign_pause_epoch
) values
  ('018f5000-0000-7000-8000-000000000101',
    '018f5000-0000-7000-8000-000000000001', 'conversation_parts',
    '0000', '0999', 1),
  ('018f5000-0000-7000-8000-000000000102',
    '018f5000-0000-7000-8000-000000000001', 'conversation_parts',
    '1000', '1999', 1);

create temporary table claimed_job on commit drop as
select * from avalon_private.claim_migration_jobs(
  '018f5000-0000-7000-8000-000000000001', 'worker-a', 16
);
select is((select count(*)::bigint from claimed_job), 1::bigint,
  'campaign concurrency bounds new claims');
select is((select claimed_count from avalon_private.migration_campaigns
  where id = '018f5000-0000-7000-8000-000000000001'), 1::bigint,
  'claim progress advances atomically');
select ok((select avalon_private.renew_migration_job(
  job_id, 'worker-a', lease_token, campaign_pause_epoch) from claimed_job),
  'the current lease can renew while the campaign runs');
select is((select count(*)::bigint from avalon_private.claim_migration_jobs(
  '018f5000-0000-7000-8000-000000000001', 'worker-b', 16)), 0::bigint,
  'a second worker cannot exceed campaign concurrency');

update avalon_private.migration_campaigns
set state = 'paused', pause_epoch = pause_epoch + 1
where id = '018f5000-0000-7000-8000-000000000001';
select ok(not (select avalon_private.renew_migration_job(
  job_id, 'worker-a', lease_token, campaign_pause_epoch) from claimed_job),
  'pause epoch prevents lease renewal');
select throws_ok(
  $$select avalon_private.finish_migration_job(
    job_id, 'worker-a', lease_token, campaign_pause_epoch,
    'completed', 'conversation_parts/0000-0999', 1, 1,
    extensions.digest(convert_to('in', 'utf8'), 'sha256'),
    extensions.digest(convert_to('out', 'utf8'), 'sha256'), null
  ) from claimed_job$$,
  '40001', 'migration campaign is paused or superseded',
  'a paused campaign cannot accept an in-flight result'
);

update avalon_private.migration_campaigns
set state = 'running'
where id = '018f5000-0000-7000-8000-000000000001';
update avalon_private.migration_jobs
set state = 'queued', lease_owner = null, lease_token = null,
    lease_expires_at = null, campaign_pause_epoch = 2
where id = '018f5000-0000-7000-8000-000000000101';
truncate claimed_job;
insert into claimed_job
select * from avalon_private.claim_migration_jobs(
  '018f5000-0000-7000-8000-000000000001', 'worker-c', 1
);
select is((select campaign_pause_epoch from claimed_job), 2::bigint,
  'a fresh claim uses the new pause epoch');
select lives_ok(
  $$select avalon_private.finish_migration_job(
    job_id, 'worker-c', lease_token, campaign_pause_epoch,
    'completed', 'conversation_parts/0000-0999', 1, 1,
    extensions.digest(convert_to('in', 'utf8'), 'sha256'),
    extensions.digest(convert_to('out', 'utf8'), 'sha256'), null
  ) from claimed_job$$,
  'the current lease commits a deterministic result'
);
select is((select state from avalon_private.migration_jobs
  where id = (select job_id from claimed_job)), 'completed',
  'successful settlement completes the job');
select is((select count(*)::bigint from avalon_private.migration_receipts
  where campaign_id = '018f5000-0000-7000-8000-000000000001'), 1::bigint,
  'successful settlement creates one semantic receipt');
select is((select success_count from avalon_private.migration_campaigns
  where id = '018f5000-0000-7000-8000-000000000001'), 1::bigint,
  'campaign success progress advances with settlement');
select ok(not has_function_privilege(
  'public',
  'avalon_private.claim_migration_jobs(uuid,text,integer)',
  'EXECUTE'), 'public cannot claim migration jobs');

select * from finish();
rollback;
