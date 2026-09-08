import { asWorkspaceId } from '@rally/contracts';
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from '../src/durable-objects/workspace-do';
import { applyDurableObjectSqliteMigrations } from '../src/durable-objects/sqlite-migrations';
import { workspaceDOName } from '../src/durable-objects/names';

const workspaceId = asWorkspaceId('00000000-0000-7000-8000-00000000a7101');
const resourceId = '00000000-0000-7000-8000-00000000a7102';
const connectionId = '00000000-0000-7000-8000-00000000a7103';
const at = '2026-09-08T00:00:00Z';
function seed(sql: SqlStorage) {
  sql.exec("INSERT INTO workspace_identity VALUES (1, ?, 'global', 'wnam', 0, 0)", workspaceId);
  sql.exec(`INSERT INTO resources (id, workspace_id, resource_type, provider, title, metadata_json, created_at, updated_at)
    VALUES (?, ?, 'generated_file', 'avalon_generated', 'Plan', '{}', ?, ?)`, resourceId, workspaceId, at, at);
}
function watermark(sql: SqlStorage) {
  return sql.exec('SELECT revision, pending, not_before FROM resource_search_versions WHERE resource_id = ?', resourceId).one();
}
beforeEach(async () => { await reset(); });

it('upgrades committed v42 watermarks without clearing pending work and ignores bookkeeping edits', async () => {
  const stub = env.MIGRATION_PROBE_DO!.getByName('resource-update-cost-upgrade');
  await stub.ping();
  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({ storage: state.storage,
      migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 42),
      component: 'workspace_do', workerVersionId: 'old', now: 1 });
    seed(state.storage.sql);
    state.storage.sql.exec('UPDATE resource_search_versions SET revision = 12, pending = 1, not_before = 123');
  });
  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
      component: 'workspace_do', workerVersionId: 'new', now: 2 });
    const sql = state.storage.sql;
    expect(watermark(sql)).toEqual({ revision: 12, pending: 1, not_before: 123 });
    sql.exec(`UPDATE resources SET updated_at = 'later', slug = 'plan', last_hydrated_at = 'later',
      model_content_status = 'processing', metadata_json = '{"status":"running","description":42}' WHERE id = ?`, resourceId);
    expect(watermark(sql)).toEqual({ revision: 12, pending: 1, not_before: 123 });
    sql.exec('UPDATE resource_search_versions SET pending = 0');
    sql.exec("UPDATE resources SET metadata_json = '{\"status\":\"done\",\"description\":null}' WHERE id = ?", resourceId);
    expect(watermark(sql)).toEqual({ revision: 12, pending: 0, not_before: 123 });
    sql.exec("UPDATE resources SET title = 'Changed' WHERE id = ?", resourceId);
    expect(watermark(sql)).toEqual({ revision: 13, pending: 1, not_before: 0 });
    expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([]);
  });
});

it('invalidates all search inputs, ignores identical assignments, and retains deletion watermarks', async () => {
  const stub = env.WORKSPACE_DOS.getByName(workspaceDOName('global', workspaceId));
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    seed(sql);
    let revision = 1;
    expect(watermark(sql)).toEqual({ revision, pending: 1, not_before: 0 });
    // Inputs to the canonical category/text loader, plus body hashes for replacements.
    const edits = ["title = 'Revised'", "provider = 'avalon_upload'", "canonical_url = 'https://example.com'",
      "mime_type = 'text/plain'", "content_ref = 'original'", "content_sha256 = 'hash'",
      "model_mime_type = 'text/markdown'", "model_content_ref = 'derivative'", "model_content_sha256 = 'model-hash'",
      `metadata_json = '{"description":"Searchable"}'`, `metadata_json = '{"description":false}'`,
      'content_ref = NULL', 'model_content_ref = NULL', 'canonical_url = NULL'];
    for (const edit of edits) {
      sql.exec('UPDATE resource_search_versions SET pending = 0');
      sql.exec(`UPDATE resources SET ${edit} WHERE id = ?`, resourceId);
      expect(watermark(sql), edit).toEqual({ revision: ++revision, pending: 1, not_before: 0 });
      sql.exec('UPDATE resource_search_versions SET pending = 0');
      sql.exec(`UPDATE resources SET ${edit} WHERE id = ?`, resourceId);
      expect(watermark(sql), `repeated ${edit}`).toEqual({ revision, pending: 0, not_before: 0 });
    }
    sql.exec('DELETE FROM resources WHERE id = ?', resourceId);
    expect(watermark(sql)).toEqual({ revision: ++revision, pending: 1, not_before: 0 });
    sql.exec(`INSERT INTO resources (id, workspace_id, resource_type, provider, title, created_at, updated_at)
      VALUES (?, ?, 'generated_file', 'avalon_generated', 'Restored', ?, ?)`, resourceId, workspaceId, at, at);
    expect(watermark(sql)).toEqual({ revision: revision + 1, pending: 1, not_before: 0 });
  });
});

it('skips unchanged discovery writes while preserving metadata merge, URL fallback, and content updates', async () => {
  const stub = env.WORKSPACE_DOS.getByName(workspaceDOName('global', workspaceId));
  await runInDurableObject(stub, async (instance, state) => {
    const sql = state.storage.sql;
    sql.exec("INSERT INTO workspace_identity VALUES (1, ?, 'global', 'wnam', 0, 0)", workspaceId);
    sql.exec(`INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, display_name, status, config_json, created_at, updated_at, model_plugin_id)
      VALUES (?, ?, 'github', 'workspace', 'Fixture', 'healthy', '{}', ?, ?, 'plugin_github')`, connectionId, workspaceId, at, at);
    const resource = { id: resourceId, resourceType: 'repository', providerResourceId: 'repo', title: 'Repository',
      canonicalUrl: 'https://example.com/repo', metadataJson: JSON.stringify({ description: 'Description',
        retained: true, nested: { keep: 1, remove: 2 }, discoveredDeliveryId: 'first', discoveredEventType: 'push' }) };
    const request = { workspaceId, connectionId, provider: 'github', at, resources: [resource] };
    await instance.upsertDiscoveredResources(request);
    sql.exec('UPDATE resource_search_versions SET pending = 0');
    const original = sql.exec('SELECT * FROM resources WHERE id = ?', resourceId).one();
    const spy = vi.spyOn(sql, 'exec');
    try {
      await instance.upsertDiscoveredResources({ ...request, at: '2026-09-08T01:00:00Z', resources: [{ ...resource,
        id: '00000000-0000-7000-8000-00000000a7104', canonicalUrl: null,
        metadataJson: '{"discoveredDeliveryId":"second","discoveredEventType":"check_run","nested":{"keep":1}}' }] });
      const writes = spy.mock.calls.flatMap(([query], index) => query.startsWith('INSERT INTO resources')
        ? [(spy.mock.results[index]!.value as ReturnType<SqlStorage['exec']>).rowsWritten] : []);
      expect(writes).toEqual([0]);
    } finally { spy.mockRestore(); }
    expect(sql.exec('SELECT * FROM resources WHERE id = ?', resourceId).one()).toEqual(original);
    expect(watermark(sql)).toEqual({ revision: 1, pending: 0, not_before: 0 });
    await instance.upsertDiscoveredResources({ ...request, at: '2026-09-08T02:00:00Z', resources: [{ ...resource,
      canonicalUrl: null, metadataJson: '{"nested":{"remove":null,"added":3},"discoveredDeliveryId":"third"}' }] });
    const changed = sql.exec('SELECT metadata_json, updated_at, canonical_url FROM resources WHERE id = ?', resourceId).one();
    expect(JSON.parse(String(changed.metadata_json))).toEqual({ description: 'Description', retained: true,
      nested: { keep: 1, added: 3 }, discoveredDeliveryId: 'third', discoveredEventType: 'push' });
    expect(changed.updated_at).toBe('2026-09-08T02:00:00Z');
    expect(changed.canonical_url).toBe(resource.canonicalUrl);
    expect(watermark(sql)).toEqual({ revision: 1, pending: 0, not_before: 0 });
    await instance.upsertDiscoveredResources({ ...request, resources: [{ ...resource, title: 'Renamed',
      canonicalUrl: 'https://example.com/new', metadataJson: '{"description":null}' }] });
    expect(sql.exec('SELECT title, canonical_url FROM resources WHERE id = ?', resourceId).one())
      .toEqual({ title: 'Renamed', canonical_url: 'https://example.com/new' });
    expect(watermark(sql)).toEqual({ revision: 2, pending: 1, not_before: 0 });
  });
});
