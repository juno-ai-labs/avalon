/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { applyDurableObjectSqliteMigrations } from '../src/durable-objects/sqlite-migrations';
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from '../src/durable-objects/workspace-do';
import { WORKSTREAM_DO_SCHEMA_MIGRATIONS } from '../src/durable-objects/workstream-do';
import { AUTOMATION_DO_SCHEMA_MIGRATIONS } from '../src/durable-objects/sidekick-do';
import { ARTIFACT_HOST_SCHEMA_MIGRATIONS } from '../src/durable-objects/artifact-host-do';
import { WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS } from '../src/durable-objects/workstream-object-schema';

const cases = [
  { component: 'workspace_do', migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS, table: 'workspace_identity', row: {
    id: 1, workspace_id: 'workspace', region: 'global', placement_affinity: 'wnam', created_at: 1, updated_at: 2,
  } },
  { component: 'workstream_do', migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS, table: 'workstream_metadata', row: {
    id: 1, workspace_id: 'workspace', workstream_id: 'workstream', region: 'global', authority_generation: 1,
    title: 'Preserved title', description: '', preview: '', scope: 'personal', exact_state: 'idle',
    last_activity_at: 1, created_at: 1, updated_at: 2,
  } },
  { component: 'automation_do', migrations: AUTOMATION_DO_SCHEMA_MIGRATIONS, table: 'automation', row: {
    id: 1, workspace_id: 'workspace', automation_id: 'automation', region: 'global', author_user_id: 'user',
    run_as_user_id: 'user', lifecycle: 'active', scope: 'workspace', title: 'Preserved Sidekick', description: '',
    current_definition_revision: 1, connector_bindings_json: '{}', default_plugin_ids_json: '[]',
    activity_source_plugin_ids_json: '[]', evaluator_projection_json: '{}', authority_generation: 1, created_at: 1, updated_at: 2,
  } },
  { component: 'artifact_host', migrations: ARTIFACT_HOST_SCHEMA_MIGRATIONS, table: 'artifact_state', row: {
    id: 1, artifact_id: 'artifact', workspace_id: 'workspace', workstream_id: 'workstream', resource_id: 'resource',
    region: 'global', current_version: 1, mode: 'static', stateful: 0, manifest_json: '{}', updated_at: 2,
  } },
  { component: 'workstream_object', migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS, table: 'workstream', row: {
    id: 1, workstream_key: 'workstream', parent_workspace_key: 'workspace', region: 'global', authority_mode: 'authoritative',
    scope: 'personal', exact_state: 'idle', state_reason_code: 'seeded', next_sequence_number: 1, next_attention_ordinal: 1,
    authority_epoch: 0, scope_epoch: 0, source_authorization_floor: 0, listing_epoch: 0, deletion_epoch: 0, run_revision: 0,
    created_at: 1, last_people_activity_at: 1, state_changed_at: 1, updated_at: 2,
  } },
];

it.each(cases)('$component preserves its committed identity and receipts while allowing another deployment', async ({ component, migrations, table, row }) => {
  const stub = env.MIGRATION_PROBE_DO!.getByName(`configurable-region-${component}`);
  await stub.ping();
  const columns = Object.keys(row);
  const insert = `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
  const before = await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: migrations.slice(0, -1), component, workerVersionId: 'before', now: 1 });
    state.storage.sql.exec(insert, ...Object.values(row));
    return state.storage.sql.exec(`SELECT * FROM ${table}`).toArray();
  });
  await runInDurableObject(stub, (_instance, state) => {
    // Receipt verification in the production runner also proves the applied
    // migration hashes remain compatible when this forward migration runs.
    applyDurableObjectSqliteMigrations({ storage: state.storage, migrations, component, workerVersionId: 'after', now: 2 });
    expect(state.storage.sql.exec(`SELECT * FROM ${table}`).toArray()).toEqual(before);
    expect(state.storage.sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([]);
    state.storage.sql.exec(`DELETE FROM ${table}`);
    state.storage.sql.exec(insert, ...columns.map((column) => column === 'region' ? 'enterprise' : row[column as keyof typeof row]!));
    expect(state.storage.sql.exec(`SELECT region FROM ${table}`).one()).toEqual({ region: 'enterprise' });
  });
});
