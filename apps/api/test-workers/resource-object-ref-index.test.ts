/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { applyDurableObjectSqliteMigrations } from '../src/durable-objects/sqlite-migrations';
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from '../src/durable-objects/workspace-do';
import { listWorkspaceReapableResourceObjects } from '../src/durable-objects/workspace-resources-storage';
import { SCHEDULE_TARGET_QUERIES } from '../src/services/workspace-schedule-execution';

// The maintenance schedule checks each object waiting for deletion against
// every resource and version that could still point at it, on every Channel
// directory effect with links. It must look those up, not read every row.
const workspaceId = '00000000-0000-7000-8000-00000000d101';

it('after the upgrade, checks a waiting object against the resources and versions that store one, not every row', async () => {
  const stub = env.MIGRATION_PROBE_DO!.getByName('resource-object-ref-index');
  await stub.ping();
  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 77),
      component: 'workspace_do', workerVersionId: 'v77', now: 1_000 });
    const sql = state.storage.sql;
    sql.exec("INSERT INTO workspace_identity VALUES (1, ?, 'global', 'wnam', 0, 0)", workspaceId);
    // Connector resources store no object; they are most of a large workspace. Each insert also records version 1.
    for (let index = 0; index < 300; index += 1) {
      const id = `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;
      sql.exec(`INSERT INTO resources (id, workspace_id, resource_type, provider, title, metadata_json, created_at, updated_at)
        VALUES (?, ?, 'link', 'google_drive', 'Doc', '{}', '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z')`, id, workspaceId);
    }
    sql.exec(`INSERT INTO resource_object_deletion_outbox
      (object_ref, workspace_id, resource_id, object_kind, cleanup_eligible, created_at, updated_at)
      VALUES ('global/objects/waiting', ?, 'gone', 'original', 0, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z')`, workspaceId);
    // A second waiting object is still pointed at, by a resource written before the upgrade.
    sql.exec(`INSERT INTO resources (id, workspace_id, resource_type, provider, title, metadata_json, content_ref, created_at, updated_at)
      VALUES ('kept', ?, 'file', 'avalon_upload', 'Kept', '{}', 'global/objects/kept', '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z')`, workspaceId);
    sql.exec(`INSERT INTO resource_object_deletion_outbox
      (object_ref, workspace_id, resource_id, object_kind, cleanup_eligible, created_at, updated_at)
      VALUES ('global/objects/kept', ?, 'kept', 'original', 0, '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z')`, workspaceId);
  });
  // Production builds the indexes over rows that already exist.
  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
      component: 'workspace_do', workerVersionId: 'ref-index', now: 2_000 });
    const sql = state.storage.sql;
    const due = sql.exec(SCHEDULE_TARGET_QUERIES.find((query) => query.sql.includes("'resource_objects'"))!.sql, workspaceId);
    // Only the pointed-at object is due, found through an index built over existing rows.
    expect(due.toArray()).toEqual([{ id: 'resource_objects', due_at: '2026-09-20T00:00:00Z' }]);
    expect(due.rowsRead).toBeLessThan(10);
    // The cleanup pass selects with the same predicate.
    expect(listWorkspaceReapableResourceObjects(state.storage, workspaceId).items).toEqual([
      expect.objectContaining({ object_ref: 'global/objects/kept' })]);
  });
});
