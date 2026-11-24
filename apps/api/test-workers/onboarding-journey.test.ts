/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { OnboardingJourneyStore } from '../src/durable-objects/onboarding-journey';
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from '../src/durable-objects/workspace-do';
import { applyDurableObjectSqliteMigrations } from '../src/durable-objects/sqlite-migrations';

const creator = '00000000-0000-7000-8000-000000000001';
const member = '00000000-0000-7000-8000-000000000002';

describe('durable onboarding journey', () => {
  it('completes setup without a first task and preserves completion across sessions', async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName('onboarding-journey');
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
        component: 'workspace_do', workerVersionId: 'onboarding-test', now: 1 });
      const store = new OnboardingJourneyStore(state.storage.sql);
      expect(store.get(creator, 'creator').stage).toBe('profile');
      expect(store.get(member, 'member').stage).toBe('profile');
      expect(store.update(creator, 'creator', { expectedRevision: 0, stage: 'complete' })).toBeNull();
      expect(store.update(member, 'member', { expectedRevision: 0, stage: 'people' })).toBeNull();
      // Personal setup leads to connecting Gmail and Google Drive, then to teammates.
      store.update(creator, 'creator', { expectedRevision: 0, stage: 'connectors' });
      expect(store.update(creator, 'creator', { expectedRevision: 1, stage: 'profile' })).toBeNull();
      expect(store.update(creator, 'creator', { expectedRevision: 1, stage: 'complete' })).toBeNull();
      store.update(creator, 'creator', { expectedRevision: 1, stage: 'people' });
      expect(store.update(creator, 'creator', { expectedRevision: 1, stage: 'complete' })).toBeNull();
      store.update(creator, 'creator', { expectedRevision: 2, stage: 'complete' });
      expect(store.get(creator, 'creator')).toMatchObject({ stage: 'complete' });
      // A member finishes after connecting.
      store.update(member, 'member', { expectedRevision: 0, stage: 'connectors' });
      expect(store.update(member, 'member', { expectedRevision: 1, stage: 'people' })).toBeNull();
      store.update(member, 'member', { expectedRevision: 1, stage: 'complete' });
    });
    await runInDurableObject(stub, (_instance, state) => {
      const resumed = new OnboardingJourneyStore(state.storage.sql);
      expect(resumed.get(creator, 'creator')).toMatchObject({ stage: 'complete', revision: 3 });
      expect(resumed.get(member, 'member')).toMatchObject({ stage: 'complete', revision: 2 });
    });
  });

  it('keeps a journey readable when a stored connector leaves the catalog', async () => {
    // A connector id that is retired or renamed is still sitting in rows written
    // before it went. The read path parses that array, and `update` reads before
    // it writes, so rejecting the row would lock the person out of seeing or
    // advancing their own onboarding — not merely out of saving a selection.
    const stub = env.MIGRATION_PROBE_DO!.getByName('onboarding-journey-retired-connector');
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
        component: 'workspace_do', workerVersionId: 'onboarding-retired-test', now: 1 });
      const store = new OnboardingJourneyStore(state.storage.sql);
      store.get(creator, 'creator');
      state.storage.sql.exec('UPDATE onboarding_journeys SET connector_ids = ? WHERE user_id = ?',
        JSON.stringify(['workspace:retired-provider', 'you:google-mail-calendar']), creator);
      expect(store.get(creator, 'creator').connectorIds).toEqual(['you:google-mail-calendar']);
      expect(store.update(creator, 'creator', { expectedRevision: 0, stage: 'people' }))
        .toMatchObject({ stage: 'people', connectorIds: ['you:google-mail-calendar'] });
    });
  });

  it('keeps a journey that skips the connectors step moving, as clients built before it do', async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName('onboarding-journey-skip-connectors');
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
        component: 'workspace_do', workerVersionId: 'onboarding-skip-test', now: 1 });
      const store = new OnboardingJourneyStore(state.storage.sql);
      store.get(creator, 'creator');
      store.get(member, 'member');
      expect(store.update(creator, 'creator', { expectedRevision: 0, stage: 'people' })).toMatchObject({ stage: 'people', revision: 1 });
      expect(store.update(member, 'member', { expectedRevision: 0, stage: 'complete' })).toMatchObject({ stage: 'complete', revision: 1 });
    });
  });

  it('moves a journey stored at the retired pre-profile connectors step on to personal setup', async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName('onboarding-journey-retired-stage');
    await stub.ping();
    // Seeding only: a row the retired step left behind, committed at the last
    // schema before the stage moved after personal setup.
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 154),
        component: 'workspace_do', workerVersionId: 'onboarding-retired-stage-v154', now: 1 });
      state.storage.sql.exec("INSERT INTO onboarding_journeys(user_id, path, stage) VALUES (?, 'creator', 'connectors')", creator);
    });
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
        component: 'workspace_do', workerVersionId: 'onboarding-retired-stage', now: 2 });
      const store = new OnboardingJourneyStore(state.storage.sql);
      expect(store.get(creator, 'creator')).toMatchObject({ stage: 'profile', revision: 1 });
      expect(store.update(creator, 'creator', { expectedRevision: 1, stage: 'connectors' })).toMatchObject({ stage: 'connectors', revision: 2 });
    });
  });
});
