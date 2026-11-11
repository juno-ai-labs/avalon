/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { canvasRunningActivity } from '../src/durable-objects/canvas-agent-activity';
import { applyDurableObjectSqliteMigrations } from '../src/durable-objects/sqlite-migrations';
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from '../src/durable-objects/workspace-do';

it('upgrades populated projection history to bounded live reads and shares counts within a publish', async () => {
  const stub = env.MIGRATION_PROBE_DO!.getByName(crypto.randomUUID());
  await stub.ping();
  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({ storage: state.storage,
      migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version < 145),
      component: 'workspace_do', workerVersionId: 'before-live-index', now: 1 });
    const sql = state.storage.sql;
    const effect = { state: 'completed', archivedAt: null, backgroundAgent: true, backgroundAgentRootSubstreamId: '0', preview: 'x'.repeat(32000) };
    for (let i = 0; i < 500; i++) sql.exec('INSERT INTO sidekick_child_projections VALUES (?, ?, 1, ?, ?, 0)',
      'canvas', `finished-${i}`, 'hash', JSON.stringify(effect));
    sql.exec('INSERT INTO sidekick_child_projections VALUES (?, ?, 1, ?, ?, 0)',
      'canvas', 'live', 'hash', JSON.stringify({ ...effect, state: 'running' }));
    applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
      component: 'workspace_do', workerVersionId: 'with-live-index', now: 2 });
    const spy = vi.spyOn(sql, 'exec');
    try {
      const shared = canvasRunningActivity(sql, ['canvas']);
      expect(shared.get('canvas')).toEqual({ backgroundAgents: 1, sidekicks: 0 });
      expect((spy.mock.results[0]!.value as ReturnType<SqlStorage['exec']>).rowsRead).toBeLessThan(50);
      expect(canvasRunningActivity(sql, ['canvas'], shared).get('canvas')).toEqual({ backgroundAgents: 1, sidekicks: 0 });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
    sql.exec("UPDATE sidekick_child_projections SET effect_json = json_set(effect_json, '$.state', 'running') WHERE substream_id = 'finished-1'");
    expect(canvasRunningActivity(sql, ['canvas']).get('canvas')).toEqual({ backgroundAgents: 2, sidekicks: 0 });
    sql.exec("UPDATE sidekick_child_projections SET effect_json = json_set(effect_json, '$.archivedAt', '2026-11-10T00:00:00Z') WHERE substream_id = 'live'");
    expect(canvasRunningActivity(sql, ['canvas']).get('canvas')).toEqual({ backgroundAgents: 1, sidekicks: 0 });
    expect(sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM sidekick_child_projections').one().count).toBe(501);
  });
});
