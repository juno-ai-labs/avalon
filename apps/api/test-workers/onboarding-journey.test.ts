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
      const initial = store.get(creator, 'creator');
      expect(initial.stage).toBe('connectors');
      expect(store.get(creator, 'creator').starterMessageId).toBe(initial.starterMessageId);
      expect(store.get(member, 'member').stage).toBe('profile');
      expect(store.update(creator, 'creator', { expectedRevision: 0, stage: 'example' })).toBeNull();
      store.update(creator, 'creator', { expectedRevision: 0, stage: 'profile', connectorIds: ['google-mail-calendar'] });
      expect(store.get(creator, 'creator').stage).toBe('profile');
      expect(store.update(creator, 'creator', { expectedRevision: 0, stage: 'people' })).toBeNull();
      store.update(creator, 'creator', { expectedRevision: 1, stage: 'people' });
      store.update(creator, 'creator', { expectedRevision: 2, stage: 'complete' });
      expect(store.get(creator, 'creator')).toMatchObject({ stage: 'complete', starterWorkstreamId: null });
      store.update(member, 'member', { expectedRevision: 0, stage: 'complete' });
    });
    await runInDurableObject(stub, (_instance, state) => {
      const resumed = new OnboardingJourneyStore(state.storage.sql);
      expect(resumed.get(creator, 'creator')).toMatchObject({ stage: 'complete', starterWorkstreamId: null, revision: 3, connectorIds: ['google-mail-calendar'] });
      expect(resumed.get(member, 'member')).toMatchObject({ stage: 'complete', starterWorkstreamId: null, revision: 1 });
    });
  });
});
