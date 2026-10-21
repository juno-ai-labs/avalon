/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from '../src/durable-objects/workspace-do';
import { applyDurableObjectSqliteMigrations } from '../src/durable-objects/sqlite-migrations';
import { rankPeople } from '../src/durable-objects/workspace-people-ranking';

beforeEach(async () => { await reset(); });

it('upgrades retained activity from v125 and seeks authored messages without reading other authors', async () => {
  const stub = env.MIGRATION_PROBE_DO!.getByName('people-ranking-index-upgrade');
  await stub.ping();
  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 125),
      component: 'workspace_do', workerVersionId: 'before-people-index', now: 1,
    });
    state.storage.sql.exec(`WITH RECURSIVE numbers(n) AS
      (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 1001)
      INSERT INTO workspace_activity_events (
        event_id, event_type, subject_type, subject_id, actor_type, actor_user_id, actor_label, title, body,
        audience_kind, audience_workstream_id, digestible, occurred_at, created_at, source_kind, dedupe_key, metadata_json
      ) SELECT 'retained:' || n, 'workstream_message_created', 'workstream', 'thread', 'user',
        CASE WHEN n = 1001 THEN 'reader' ELSE 'other' END, 'Person', 'Message', 'Retained body',
        'workstream', 'thread', 0, 1, 1, 'workstream_message', 'retained:' || n, '{"substreamId":"0"}' FROM numbers`);
    state.storage.sql.exec(`INSERT INTO workspace_activity_event_targets VALUES ('retained:1001', 'peer', 'mentioned', 1)`);
  });
  // Old data commits in a separate object event, as in a deployed upgrade.
  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
      component: 'workspace_do', workerVersionId: 'with-people-index', now: 2,
    });
    expect(state.storage.sql.exec('SELECT COUNT(*) AS count FROM workspace_activity_events').one().count).toBe(1001);
    expect(state.storage.sql.exec(`SELECT actor_user_id, body FROM workspace_activity_events WHERE event_id = 'retained:1001'`).one())
      .toEqual({ actor_user_id: 'reader', body: 'Retained body' });
    expect(state.storage.sql.exec('SELECT user_id, relation FROM workspace_activity_event_targets').toArray())
      .toEqual([{ user_id: 'peer', relation: 'mentioned' }]);
    expect(state.storage.sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([]);
    const spy = vi.spyOn(state.storage.sql, 'exec');
    try {
      // No directory row grants access to this retained conversation. Even an
      // empty result must seek the reader rather than scan all old activity.
      expect(rankPeople(state.storage, { userId: 'reader', accessClass: 'member' }, null))
        .toEqual({ channel: [], organization: [] });
      expect((spy.mock.results[0]!.value as ReturnType<SqlStorage['exec']>).rowsRead).toBeLessThan(20);
    } finally { spy.mockRestore(); }
  });
});
