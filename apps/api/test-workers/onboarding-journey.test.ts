/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { asUserId, asWorkspaceId } from '@rally/contracts';
import { OnboardingJourneyService } from '../src/services/onboarding-journey-service';
import { workspaceDOName } from '../src/durable-objects/names';
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
      expect(store.update(creator, 'creator', { expectedRevision: 0, stage: 'complete' })).toBe('stage_not_allowed');
      expect(store.update(member, 'member', { expectedRevision: 0, stage: 'people' })).toBe('stage_not_allowed');
      // Personal setup leads to connecting Gmail and Google Drive, then to teammates.
      store.update(creator, 'creator', { expectedRevision: 0, stage: 'connectors' });
      expect(store.update(creator, 'creator', { expectedRevision: 1, stage: 'profile' })).toBe('stage_not_allowed');
      expect(store.update(creator, 'creator', { expectedRevision: 1, stage: 'complete' })).toBe('stage_not_allowed');
      // Resending the stage a journey is already at returns it unchanged.
      expect(store.update(creator, 'creator', { expectedRevision: 0, stage: 'connectors' })).toMatchObject({ stage: 'connectors', revision: 1 });
      store.update(creator, 'creator', { expectedRevision: 1, stage: 'people' });
      expect(store.update(creator, 'creator', { expectedRevision: 2, stage: 'connectors' })).toBe('stage_not_allowed');
      expect(store.update(creator, 'creator', { expectedRevision: 1, stage: 'complete' })).toBe('revision_conflict');
      store.update(creator, 'creator', { expectedRevision: 2, stage: 'complete' });
      expect(store.get(creator, 'creator')).toMatchObject({ stage: 'complete' });
      // A member finishes after connecting.
      store.update(member, 'member', { expectedRevision: 0, stage: 'connectors' });
      expect(store.update(member, 'member', { expectedRevision: 1, stage: 'people' })).toBe('stage_not_allowed');
      store.update(member, 'member', { expectedRevision: 1, stage: 'complete' });
      expect(store.update(member, 'member', { expectedRevision: 2, stage: 'connectors' })).toBe('stage_not_allowed');
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

  it('refuses the Google step until personal setup is saved, and names a disallowed move apart from a stale revision', async () => {
    const workspaceId = asWorkspaceId('00000000-0000-7000-8000-000000000a01');
    const userId = asUserId('00000000-0000-7000-8000-000000000a02');
    // This D1 starts empty; these are the rows the service's authority read joins.
    await env.DB.batch([
      env.DB.prepare('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, onboarding_eligible INTEGER, presentation_json TEXT)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, region TEXT, placement_affinity TEXT, created_by_user_id TEXT, abandoned_at TEXT)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS workspace_members (workspace_id TEXT, user_id TEXT, status TEXT)'),
      env.DB.prepare('INSERT INTO users VALUES (?, 1, NULL)').bind(userId),
      env.DB.prepare("INSERT INTO workspaces VALUES (?, 'global', 'wnam', ?, NULL)").bind(workspaceId, userId),
      env.DB.prepare("INSERT INTO workspace_members VALUES (?, ?, 'active')").bind(workspaceId, userId),
    ]);
    await env.WORKSPACE_DOS.getByName(workspaceDOName('global', workspaceId)).initializeWorkspace(workspaceId, 'wnam');
    const service = new OnboardingJourneyService(env, { sessionId: 'session', userId, workspaceId, region: 'global', role: 'owner' });
    const refusal = (update: { expectedRevision: number; stage: 'connectors' | 'complete' }) =>
      service.get(update).then(() => null, (error: { status: number; code: string }) => ({ status: error.status, code: error.code }));
    expect(await service.get()).toMatchObject({ path: 'creator', stage: 'profile', revision: 0 });
    expect(await refusal({ expectedRevision: 0, stage: 'connectors' })).toEqual({ status: 409, code: 'profile_required' });
    await env.DB.prepare('UPDATE users SET presentation_json = ? WHERE id = ?').bind('{"color":"blue","avatar":"circle"}', userId).run();
    expect(await service.get({ expectedRevision: 0, stage: 'connectors' })).toMatchObject({ stage: 'connectors', revision: 1 });
    expect(await refusal({ expectedRevision: 1, stage: 'complete' })).toEqual({ status: 409, code: 'onboarding_stage_not_allowed' });
    expect(await refusal({ expectedRevision: 0, stage: 'complete' })).toEqual({ status: 409, code: 'onboarding_revision_conflict' });
  });
});
