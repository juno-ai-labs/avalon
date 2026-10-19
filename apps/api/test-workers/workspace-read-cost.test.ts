import { asWorkspaceId, asUserId, asWorkstreamId, conversationEffectHash } from "@rally/contracts";
import { resolveWorkspaceEventResources } from "../src/durable-objects/workspace-event-resources";
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from '../src/durable-objects/workspace-do';
import { applyDurableObjectSqliteMigrations } from '../src/durable-objects/sqlite-migrations';
import { nextResourceSearchDueAt, publishResourceSearch } from '../src/durable-objects/resource-search-projection';
import { workspaceDOName } from '../src/durable-objects/names';

const workspaceId = asWorkspaceId('00000000-0000-7000-8000-000000009d01');
function seed(sql: SqlStorage): void {
  sql.exec(`INSERT INTO workspace_identity VALUES (1, ?, 'global', 'wnam', 0, 0)`, workspaceId);
  sql.exec(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 2000)
    INSERT INTO resources(id, workspace_id, resource_type, provider, provider_resource_id, title,
      metadata_json, attachment_status, model_content_status, created_at, updated_at, slug)
    SELECT 'resource-' || n, ?, 'generated_file', 'avalon_generated', 'provider-' || n, 'Fixture',
      '{}', 'attached', 'pending', '2026-09-08T00:00:00Z', '2026-09-08T00:00:00Z', 'slug-' || n FROM numbers`, workspaceId);
  sql.exec('UPDATE resource_search_versions SET pending = 0');
}
beforeEach(async () => { await reset(); });

it('upgrades populated v37 without losing resources and seeks only pending search rows', async () => {
  const stub = env.MIGRATION_PROBE_DO!.getByName('workspace-read-cost-upgrade');
  await stub.ping();
  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({ storage: state.storage,
      migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 37),
      component: 'workspace_do', workerVersionId: 'old', now: 1 });
    seed(state.storage.sql);
  });
  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
      component: 'workspace_do', workerVersionId: 'new', now: 2 });
    const sql = state.storage.sql;
    expect(sql.exec('SELECT COUNT(*) AS n FROM resources').one().n).toBe(2000);
    expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([]);
    // Migration 47 requeues every resource for its display rewrite, due immediately.
    expect(nextResourceSearchDueAt(sql)).toBe(0);
    sql.exec('UPDATE resource_search_versions SET pending = 0');
    const spy = vi.spyOn(sql, 'exec');
    try {
      expect(nextResourceSearchDueAt(sql)).toBeNull();
      const cursor = spy.mock.results[0]!.value as ReturnType<SqlStorage["exec"]>;
      expect(cursor.rowsRead).toBeLessThan(10);
      sql.exec("UPDATE resource_search_versions SET pending = 1, not_before = 123 WHERE resource_id = 'resource-1'");
      expect(nextResourceSearchDueAt(sql)).toBe(123);
    } finally { spy.mockRestore(); }
  });
});

it('derives draft and slug deadlines without scanning completed resources', async () => {
  const stub = env.WORKSPACE_DOS.getByName(workspaceDOName('global', workspaceId));
  await runInDurableObject(stub, async (instance, state) => {
    const sql = state.storage.sql;
    seed(sql);
    const spy = vi.spyOn(sql, 'exec');
    try {
      await instance.refreshSchedule(workspaceId);
      const scans = spy.mock.calls.flatMap(([query], index) =>
        query.includes("'expired_drafts' AS id") || query.includes("'resource_slugs' AS id")
          ? [spy.mock.results[index]!.value as ReturnType<SqlStorage["exec"]>] : []);
      expect(scans).toHaveLength(2);
      expect(scans.map((cursor) => cursor.rowsRead)).toEqual([0, 0]);
      sql.exec("UPDATE resources SET slug = NULL WHERE id = 'resource-1'");
      sql.exec("UPDATE resources SET provider = 'avalon_upload', attachment_status = 'draft' WHERE id = 'resource-2'");
      await instance.refreshSchedule(workspaceId);
      const deadlines = sql.exec("SELECT alarm_key FROM _internal_durable_alarms WHERE kind = 'maintenance' ORDER BY alarm_key")
        .toArray().map((row) => row.alarm_key);
      expect(deadlines).toContain('expired_drafts');
      expect(deadlines).toContain('resource_slugs');
    } finally { spy.mockRestore(); }
  });
});

it('resolves the entire event key set with exact scoped seeks and no duplicate resources', async () => {
  const stub = env.WORKSPACE_DOS.getByName(workspaceDOName('global', workspaceId));
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    seed(sql);
    // The identity index is partial on connection_id; use a real owning connection.
    sql.exec(`INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, display_name, status,
       config_json, created_at, updated_at, model_plugin_id)
      VALUES ('connection', ?, 'github', 'workspace', NULL, 'Fixture', 'healthy', '{}', 'now', 'now', 'plugin_github')`, workspaceId);
    sql.exec("UPDATE resources SET connection_id = 'connection'");
    const input = { workspaceId, connectionId: 'connection', provider: 'avalon_generated',
      providerResourceId: 'provider-1', entityKeys: ['provider-1', 'provider-2', ...Array.from({ length: 126 }, (_, i) => `missing-${i}`)] };
    const spy = vi.spyOn(sql, 'exec');
    try {
      expect(resolveWorkspaceEventResources(sql, input)).toEqual(['resource-1', 'resource-2']);
      const cursor = spy.mock.results[0]!.value as ReturnType<SqlStorage["exec"]>;
      // Workerd counts the JSON keys too. Cost follows this event's keys, not all 2,000 resources.
      expect(cursor.rowsRead).toBeLessThan(300);
      expect(resolveWorkspaceEventResources(sql, { ...input, connectionId: 'other' })).toEqual([]);
      expect(resolveWorkspaceEventResources(sql, { ...input, provider: 'github' })).toEqual([]);
      expect(resolveWorkspaceEventResources(sql, { ...input, workspaceId: 'other' })).toEqual([]);
      expect(resolveWorkspaceEventResources(sql, { ...input, providerResourceId: null, entityKeys: [] })).toEqual([]);
      expect(resolveWorkspaceEventResources(sql, { ...input, providerResourceId: null, entityKeys: ['provider-2'] }))
        .toEqual(['resource-2']);
    } finally { spy.mockRestore(); }
  });
});

it('refreshes only a runtime write source kind and preserves unrelated alarms and retry gates', async () => {
  const stub = env.WORKSPACE_DOS.getByName(workspaceDOName('global', workspaceId));
  await runInDurableObject(stub, async (instance, state) => {
    const sql = state.storage.sql;
    seed(sql);
    sql.exec(`INSERT INTO _internal_durable_alarms
      (kind, alarm_key, due_at, repeat_every_ms, retry_at, attempt, payload_json, created_at, updated_at)
      VALUES ('maintenance', 'resource_slugs', 4000000000000, NULL, 4000000001000, 2, NULL, 0, 0)`);
    const spy = vi.spyOn(sql, 'exec');
    const directory = vi.spyOn(instance, 'workstreamScheduleTargets');
    const notifications = vi.spyOn(instance, 'notificationIntentMaintenanceTarget');
    try {
      await instance.executeRuntimeSql({ workspaceId, requestId: '00000000-0000-7000-8000-000000009d02',
        statements: [{ sql: 'UPDATE schedules SET enabled = 0 WHERE workspace_id = ?', params: [workspaceId] }] });
      // A replay still repairs its own kind, even when the write changes no rows.
      await vi.waitFor(() => expect(spy.mock.calls.some(([query]) => query.includes('DELETE FROM _internal_durable_alarms'))).toBe(true), { timeout: 10_000 });
      expect(spy.mock.calls.some(([query]) => query.includes("'expired_drafts' AS id"))).toBe(false);
      expect(spy.mock.calls.some(([query]) => query.includes('FROM resource_watches'))).toBe(false);
      expect(directory).not.toHaveBeenCalled();
      expect(notifications).not.toHaveBeenCalled();
      expect(sql.exec("SELECT attempt, retry_at FROM _internal_durable_alarms WHERE kind = 'maintenance' AND alarm_key = 'resource_slugs'").one())
        .toEqual({ attempt: 2, retry_at: 4000000001000 });
    } finally { spy.mockRestore(); directory.mockRestore(); notifications.mockRestore(); }
  });
});

it('publishes only due pending revisions through the real Queue', async () => {
  const stub = env.WORKSPACE_DOS.getByName(workspaceDOName('global', workspaceId));
  await runInDurableObject(stub, async (_instance, state) => {
    const sql = state.storage.sql;
    seed(sql);
    const dueId = '00000000-0000-7000-8000-000000009d03';
    const futureId = '00000000-0000-7000-8000-000000009d04';
    sql.exec('INSERT INTO resource_search_versions VALUES (?, 7, 1, 0), (?, 8, 1, 4000000000000)', dueId, futureId);
    const spy = vi.spyOn(sql, 'exec');
    try {
      await publishResourceSearch(sql, { ...env, TURBO_PUFFER_DEV_API_KEY: 'test-only', OPENROUTER_API_KEY: 'test-only' }, workspaceId);
      const reads = spy.mock.calls.flatMap(([query], index) => query.startsWith('SELECT resource_id, revision')
        ? [(spy.mock.results[index]!.value as ReturnType<SqlStorage["exec"]>).rowsRead] : []);
      expect(reads).toHaveLength(1);
      expect(reads[0]).toBeLessThan(10);
      expect(sql.exec('SELECT revision, pending FROM resource_search_versions WHERE resource_id = ?', dueId).one())
        .toEqual({ revision: 7, pending: 0 });
      expect(sql.exec('SELECT revision, pending FROM resource_search_versions WHERE resource_id = ?', futureId).one())
        .toEqual({ revision: 8, pending: 1 });
      expect(nextResourceSearchDueAt(sql)).toBe(4000000000000);
    } finally { spy.mockRestore(); }
  });
});

it('removes a watch alarm when a resource write cascades to its source row', async () => {
  const stub = env.WORKSPACE_DOS.getByName(workspaceDOName('global', workspaceId));
  await runInDurableObject(stub, async (instance, state) => {
    const sql = state.storage.sql;
    seed(sql);
    sql.exec(`INSERT INTO resource_watches
      (id, workspace_id, workstream_id, resource_id, connection_id, watch_type, next_poll_at, created_at, updated_at)
      VALUES ('watch', ?, 'stream', 'resource-1', 'connection', 'poll', '2096-09-08T00:00:00Z', 'now', 'now')`, workspaceId);
    sql.exec("UPDATE resources SET slug = NULL, created_at = '2096-09-08T00:00:00Z' WHERE id = 'resource-1'");
    await instance.refreshSchedule(workspaceId);
    expect(sql.exec("SELECT alarm_key FROM _internal_durable_alarms WHERE alarm_key = 'resource_slugs'").toArray()).toHaveLength(1);
    const alarms = () => sql.exec("SELECT alarm_key FROM _internal_durable_alarms WHERE kind = 'watch'").toArray();
    expect(alarms()).toEqual([{ alarm_key: 'watch' }]);
    await instance.executeRuntimeSql({ workspaceId, requestId: '00000000-0000-7000-8000-000000009d05',
      statements: [{ sql: 'DELETE FROM resources WHERE id = ?', params: ['resource-1'] }] });
    await vi.waitFor(() => expect(alarms()).toEqual([]), { timeout: 10_000 });
    expect(sql.exec('SELECT id FROM resource_watches').toArray()).toEqual([]);
    expect(sql.exec("SELECT alarm_key FROM _internal_durable_alarms WHERE alarm_key = 'resource_slugs'").toArray()).toEqual([]);
  });
});


it('reconciles the union of source kinds in one runtime SQL batch', async () => {
  const stub = env.WORKSPACE_DOS.getByName(workspaceDOName('global', workspaceId));
  await runInDurableObject(stub, async (instance, state) => {
    const sql = state.storage.sql;
    seed(sql);
    sql.exec(`INSERT INTO schedules(id, workspace_id, connector_connection_id, schedule_type,
      interval_seconds, timezone, next_run_at, created_at, updated_at)
      VALUES ('schedule', ?, 'connection', 'interval', 60, 'UTC', '2096-09-08T00:00:00Z', 'now', 'now')`, workspaceId);
    await instance.refreshSchedule(workspaceId);
    expect(sql.exec("SELECT alarm_key FROM _internal_durable_alarms WHERE kind = 'schedule'").toArray()).toHaveLength(1);
    await instance.executeRuntimeSql({ workspaceId, requestId: '00000000-0000-7000-8000-000000009d06', statements: [
      { sql: 'UPDATE schedules SET enabled = 0 WHERE id = ?', params: ['schedule'] },
      { sql: "UPDATE resources SET slug = NULL, created_at = '2096-09-08T00:00:00Z' WHERE id = ?", params: ['resource-1'] },
    ] });
    // Allow the post-commit continuation to settle, below the suite's 30s budget.
    await vi.waitFor(() => {
      expect(sql.exec("SELECT alarm_key FROM _internal_durable_alarms WHERE kind = 'schedule'").toArray()).toEqual([]);
      expect(sql.exec("SELECT alarm_key FROM _internal_durable_alarms WHERE kind = 'maintenance'").toArray())
        .toEqual([{ alarm_key: 'resource_slugs' }]);
    }, { timeout: 10_000 });
  });
});

it('repairs a terminal deadline from its recorded follow-up when the post-commit run fails', async () => {
  const stub = env.WORKSPACE_DOS.getByName(workspaceDOName('global', workspaceId));
  const workstreamId = asWorkstreamId('00000000-0000-7000-8000-000000009d08');
  const dueAt = '2096-09-08T00:00:00.000Z';
  const before = Date.now();
  await runInDurableObject(stub, async (instance, state) => {
    const sql = state.storage.sql;
    seed(sql);
    const resourceId = '00000000-0000-7000-8000-000000009d07';
    sql.exec(`INSERT INTO resources(id, workspace_id, resource_type, provider, title, slug,
      attachment_status, created_at, updated_at)
      VALUES (?, ?, 'document', 'avalon_upload', 'Replay fixture', 'replay-fixture', 'attached', ?, ?)`,
      resourceId, workspaceId, dueAt, dueAt);
    const effect = {
      kind: 'directory_common' as const, title: 'Replay fixture', description: '', preview: '',
      scope: 'personal' as const, state: 'running', systemKind: null,
      lastActivityAt: dueAt, completedAt: null, archivedAt: null,
      createdByUserId: asUserId('00000000-0000-7000-8000-000000009d09'),
      latestAttentionOrdinal: 1, unreadTrackingStartOrdinal: 0, createdAt: dueAt, updatedAt: dueAt,
      nextTerminalActionAt: dueAt,
      resourceLinks: [{ resourceId, watchEnabled: false, relationshipType: 'message_attachment' as const }],
    };
    const request = { workspaceId, envelopes: [{
      kind: 'parent_effect' as const, contractVersion: 1 as const, region: 'global' as const,
      workspaceId, parentKind: 'workstream' as const, parentId: workstreamId, generation: 1,
      messageId: '00000000-0000-7000-8000-000000009d10', partitionKey: 'common', sourceVersion: 1,
      requiredProjectionVersion: null, payloadHash: conversationEffectHash(effect), effect,
    }] };
    // Fault injection at the post-commit boundary: the directory row commits,
    // the reconciliation after it throws.
    const exec = sql.exec.bind(sql);
    const failure = vi.spyOn(sql, 'exec').mockImplementation(
      <T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]) => {
        if (query.startsWith('SELECT link.resource_id, link.watch_enabled')) {
          throw new Error('injected_post_commit_failure');
        }
        return exec<T>(query, ...bindings);
      },
    );
    let result: unknown;
    try {
      result = await instance.applyWorkstreamDirectoryEffects(request);
    } finally { failure.mockRestore(); }
    // The caller is not failed for work its commit no longer depends on.
    expect(result).toMatchObject({ accepted: [{ messageId: request.envelopes[0]!.messageId }] });
    expect(sql.exec('SELECT next_terminal_action_at FROM channels WHERE workstream_id = ?', workstreamId).one())
      .toEqual({ next_terminal_action_at: Date.parse(dueAt) });
    expect(sql.exec("SELECT alarm_key FROM _internal_durable_alarms WHERE kind = 'terminal'").toArray()).toEqual([]);
    // What it still owes is kept, put off on the retry schedule, and armed.
    const kept = sql.exec<{ followup_json: string; attempts: number; not_before: number }>(
      'SELECT followup_json, attempts, not_before FROM workspace_directory_followups',
    ).toArray();
    expect(kept).toHaveLength(1);
    expect(kept[0]!.attempts).toBe(1);
    expect(kept[0]!.not_before).toBeGreaterThan(before);
    expect(JSON.parse(kept[0]!.followup_json)).toMatchObject({ refreshTerminal: true, refreshWatchKinds: true });
    const alarm = await state.storage.getAlarm();
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThanOrEqual(kept[0]!.not_before);
    // Make it due now rather than wait out the retry delay.
    sql.exec('UPDATE workspace_directory_followups SET not_before = 0');
    await state.storage.setAlarm(Date.now());
  });
  // The alarm's own phase runs it, with nothing replayed. The real alarm
  // fires on its own, so this waits for its result rather than racing it.
  await vi.waitFor(() => runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    expect(sql.exec('SELECT id FROM workspace_directory_followups').toArray()).toEqual([]);
    expect(sql.exec("SELECT alarm_key, due_at FROM _internal_durable_alarms WHERE kind = 'terminal'").toArray())
      .toEqual([{ alarm_key: workstreamId, due_at: Date.parse(dueAt) }]);
  }), { timeout: 10_000, interval: 50 });
  // Mutation publication can wake the shared alarm before the repaired deadline.
  await vi.waitFor(() => runInDurableObject(stub, async (_instance, state) => {
    const alarm = await state.storage.getAlarm();
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThanOrEqual(Date.parse(dueAt));
  }), { timeout: 10_000, interval: 50 });
});
