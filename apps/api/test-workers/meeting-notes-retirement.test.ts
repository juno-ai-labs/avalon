/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deliverInferenceLakehousePointer, retiredMeetingInferenceKey } from '../src/queues/inference-lakehouse-consumer';
import { sha256 } from '../src/lib/crypto';
import type { InferenceLakehouseRecord } from '../src/services/inference-lakehouse';
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from '../src/durable-objects/workspace-do';
import { applyDurableObjectSqliteMigrations } from '../src/durable-objects/sqlite-migrations';
import { purgeRetiredMeetingObjects, withMeetingRetirementPrerequisites } from '../src/durable-objects/meeting-notes-retirement';

const workspaceId = '00000000-0000-7000-8000-000000000da0';
const resourceId = '00000000-0000-7000-8000-000000000cb1';
const noteId = '00000000-0000-7000-8000-000000000cb0';
const ownerId = '00000000-0000-7000-8000-000000000ca1';
const prefix = `global/${workspaceId}/resources/${resourceId}/`;
const current = `${prefix}versions/current/note.md`;
const historical = `${prefix}versions/old/note-model.md`;
const at = '2033-01-01T00:00:00.000Z';

describe('meeting notes retirement', () => {
  it('purges populated notes and every file version, preserves unrelated resources, and refuses recreation', async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName('meeting-notes-retirement');
    await stub.ping();
    await env.PAYLOADS.put(current, 'current meeting');
    await env.PAYLOADS.put(historical, 'historical meeting');
    await env.PAYLOADS.put('unrelated-dictation-fixture', 'keep');
    await runInDurableObject(stub, async (_instance, state) => {
      const migrate = (migrations: typeof WORKSPACE_DO_SCHEMA_MIGRATIONS) => applyDurableObjectSqliteMigrations({
        storage: state.storage, component: 'workspace_do', migrations,
        workerVersionId: 'test-meeting-retirement', now: 1_000,
      });
      migrate(WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version < 57));
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO workspace_identity(id, workspace_id, region, placement_affinity, created_at, updated_at)
        VALUES (1, ?, 'global', 'wnam', 1, 1)`, workspaceId);
      const insertResource = (id: string, provider: string) => sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, content_ref, metadata_json, attachment_status, created_at, updated_at)
        VALUES (?, ?, 'note', ?, 'Private content', ?, '{}', 'attached', ?, ?)`, id, workspaceId, provider, provider === 'avalon_note' ? current : 'unrelated-dictation-fixture', at, at);
      insertResource(resourceId, 'avalon_note');
      insertResource('00000000-0000-7000-8000-000000000cb2', 'granola');
      sql.exec(`INSERT INTO notes(id, workspace_id, owner_user_id, resource_id, scope, title, manual_notes_markdown,
        live_notes_markdown, last_activity_at, created_at, updated_at, archived_at)
        VALUES (?, ?, ?, ?, 'personal', 'Private meeting', 'manual content', 'summary content', ?, ?, ?, ?)`,
        noteId, workspaceId, ownerId, resourceId, at, at, at, at);
      sql.exec(`INSERT INTO note_transcript_segments(id, note_id, sequence_number, client_segment_id,
        start_offset_ms, end_offset_ms, captured_at, speaker_label, text_content, created_at)
        VALUES (?, ?, 1, 'segment', 0, 1000, ?, NULL, 'private transcript', ?)`,
        '00000000-0000-7000-8000-000000000cb3', noteId, at, at);
      migrate(WORKSPACE_DO_SCHEMA_MIGRATIONS.filter(m => m.version <= 57));
      const count = (table: string) => sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
      expect(count('notes')).toBe(0);
      expect(count('note_transcript_segments')).toBe(0);
      expect(sql.exec('SELECT provider FROM resources').toArray()).toEqual([{ provider: 'granola' }]);
      expect(sql.exec('SELECT note_id, objects_deleted FROM retired_meeting_resources').toArray())
        .toEqual([{ note_id: noteId, objects_deleted: 0 }]);
      expect(() => insertResource(resourceId, 'avalon_note')).toThrow('meeting_notes_retired');
      expect(() => migrate(WORKSPACE_DO_SCHEMA_MIGRATIONS)).toThrow('CHECK constraint failed');
      expect(count('notes')).toBe(0);
      // Inject the external transport failure; reads and the retry still use real R2.
      const interruptedBucket = new Proxy(env.PAYLOADS, {
        get(target, key) {
          if (key === 'delete') return async () => { throw new Error('interrupted_r2_delete'); };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await expect(purgeRetiredMeetingObjects(state.storage, interruptedBucket, 'global', workspaceId))
        .rejects.toThrow('interrupted_r2_delete');
      expect(sql.exec('SELECT objects_deleted FROM retired_meeting_resources').one()).toEqual({ objects_deleted: 0 });
      const result = await purgeRetiredMeetingObjects(state.storage, env.PAYLOADS, 'global', workspaceId);
      expect(result.remaining).toBe(0);
      expect((await env.PAYLOADS.list({ prefix })).objects).toEqual([]);
      expect(await env.PAYLOADS.get('unrelated-dictation-fixture')).not.toBeNull();
      expect(await purgeRetiredMeetingObjects(state.storage, env.PAYLOADS, 'global', workspaceId))
        .toEqual({ remaining: 0, deletedObjects: 0 });
      // A delayed old process may finish an R2 write after a completed pass.
      // Explicit resource verification must discover and remove it on rerun.
      await env.PAYLOADS.put(historical, 'delayed old writer');
      await purgeRetiredMeetingObjects(state.storage, env.PAYLOADS, 'global', workspaceId, resourceId);
      expect(await env.PAYLOADS.get(historical)).toBeNull();
      migrate(WORKSPACE_DO_SCHEMA_MIGRATIONS);
      expect(sql.exec("SELECT name FROM sqlite_schema WHERE name IN ('notes', 'note_transcript_segments')").toArray()).toEqual([]);
    });
  });
});


describe('retired meeting inference delivery', () => {
  it('erases archived meeting payloads and refuses queue replay while delivering unrelated inference', async () => {
    const delivered: unknown[] = [];
    const deliveryEnv = {
      AVALON_REGION: 'global' as const,
      PAYLOADS: env.PAYLOADS,
      INFERENCE_LAKEHOUSE: { send: async (rows: unknown[]) => { delivered.push(...rows); } },
    };
    const record: InferenceLakehouseRecord = {
      schema_version: 1,
      event_id: '00000000-0000-7000-8000-000000000101:request',
      event_type: 'request', captured_at: '2026-08-24T12:00:00.000Z',
      region: 'global', invocation_type: 'streaming', source: 'meeting_notes',
      environment: 'production', workspace_id: workspaceId,
      inference_request_id: '00000000-0000-7000-8000-000000000101',
      provider: 'openrouter', model: 'test', provider_model: 'test',
      request: { messages: [{ role: 'user', content: 'meeting transcript' }] },
      metadata: {},
    };
    const serialized = JSON.stringify(record);
    const pointer = {
      schemaVersion: 1, eventId: record.event_id, region: 'global', capturedAt: record.captured_at,
      objectKey: 'inference-lakehouse/records/retirement-test.json',
      payloadBytes: new TextEncoder().encode(serialized).byteLength,
      payloadSha256: await sha256(serialized),
    };
    await env.PAYLOADS.put(pointer.objectKey, serialized);
    await expect(deliverInferenceLakehousePointer(deliveryEnv, pointer)).rejects.toThrow('meeting_notes_retired');
    expect(await env.PAYLOADS.get(pointer.objectKey)).toBeNull();
    expect(await env.PAYLOADS.head(retiredMeetingInferenceKey(record.event_id))).not.toBeNull();
    // Reproduce interruption after the receipt was written but before bytes were erased.
    await env.PAYLOADS.put(pointer.objectKey, serialized);
    await expect(deliverInferenceLakehousePointer(deliveryEnv, pointer)).rejects.toThrow('meeting_notes_retired');
    expect(await env.PAYLOADS.get(pointer.objectKey)).toBeNull();
    expect(delivered).toEqual([]);
    const unrelated = JSON.stringify({ ...record, event_id: '00000000-0000-7000-8000-000000000102:request', source: 'workstream' });
    const unrelatedPointer = { ...pointer, eventId: '00000000-0000-7000-8000-000000000102:request',
      objectKey: 'inference-lakehouse/records/unrelated-test.json',
      payloadBytes: new TextEncoder().encode(unrelated).byteLength, payloadSha256: await sha256(unrelated) };
    await env.PAYLOADS.put(unrelatedPointer.objectKey, unrelated);
    await deliverInferenceLakehousePointer(deliveryEnv, unrelatedPointer);
    expect(delivered).toEqual([JSON.parse(unrelated)]);
    expect(await env.PAYLOADS.get(unrelatedPointer.objectKey)).not.toBeNull();
  });
});

it('upgrades conversation resource snapshots and fences old attachments without removing other providers', async () => {
  const { WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS } = await import('../src/durable-objects/workstream-object-schema');
  const stub = env.MIGRATION_PROBE_DO!.getByName('meeting-conversation-retirement');
  await stub.ping();
  await runInDurableObject(stub, async (_instance, state) => {
    const migrate = (before: boolean) => applyDurableObjectSqliteMigrations({
      storage: state.storage, component: 'substream_agent_do', workerVersionId: 'test',
      migrations: before ? WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter(m => m.version < 58) : WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
    });
    migrate(true);
    const insert = (id: string, provider: string) => state.storage.sql.exec(`INSERT INTO workstream_resource_links
      (resource_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
      VALUES (?, 0, 'attachment', ?, 1, 1)`, id, JSON.stringify({ id, provider, title: 'fixture' }));
    insert(resourceId, 'avalon_note');
    insert('granola-fixture', 'granola');
    insert('fireflies-fixture', 'fireflies');
    migrate(false);
    expect(state.storage.sql.exec('SELECT resource_id FROM workstream_resource_links ORDER BY resource_id').toArray())
      .toEqual([{ resource_id: 'fireflies-fixture' }, { resource_id: 'granola-fixture' }]);
    expect(state.storage.sql.exec('SELECT resource_id FROM retired_meeting_attachment_ids').toArray())
      .toEqual([{ resource_id: resourceId }]);
    expect(() => insert(resourceId, 'avalon_note')).toThrow('meeting_notes_retired');
    migrate(false);
  });
});


it('initializes a fresh workspace without retired feature tables', async () => {
  const stub = env.MIGRATION_PROBE_DO!.getByName('meeting-retirement-fresh');
  await stub.ping();
  await runInDurableObject(stub, async (_instance, state) => {
    applyDurableObjectSqliteMigrations({ storage: state.storage, component: 'workspace_do',
      workerVersionId: 'fresh', migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS });
    expect(state.storage.sql.exec('SELECT * FROM retired_meeting_resources').toArray()).toEqual([]);
    expect(state.storage.sql.exec("SELECT name FROM sqlite_schema WHERE name = 'notes'").toArray()).toEqual([]);
    expect(await purgeRetiredMeetingObjects(state.storage, env.PAYLOADS, 'global', workspaceId))
      .toEqual({ remaining: 0, deletedObjects: 0 });
  });
});


it('upgrades adopted workspaces that already retired the Sidekick resource join table', async () => {
  const stub = env.MIGRATION_PROBE_DO!.getByName('meeting-retirement-adopted');
  await stub.ping();
  await runInDurableObject(stub, async (_instance, state) => {
    const apply = (migrations: typeof WORKSPACE_DO_SCHEMA_MIGRATIONS) =>
      applyDurableObjectSqliteMigrations({ storage: state.storage, component: 'workspace_do', workerVersionId: 'adopted', migrations });
    apply(WORKSPACE_DO_SCHEMA_MIGRATIONS.filter(m => m.version < 57));
    state.storage.sql.exec('DROP TABLE automation_resources');
    withMeetingRetirementPrerequisites(state.storage, () => apply(WORKSPACE_DO_SCHEMA_MIGRATIONS));
    expect(state.storage.sql.exec('SELECT version FROM _sql_schema_migrations WHERE version = 57').toArray()).toEqual([{ version: 57 }]);
    expect(state.storage.sql.exec("SELECT name FROM sqlite_schema WHERE name = 'automation_resources'").toArray()).toEqual([]);
    withMeetingRetirementPrerequisites(state.storage, () => apply(WORKSPACE_DO_SCHEMA_MIGRATIONS));
  });
});

it('reports feature table and remaining-reference inventory through the real workspace RPC', async () => {
  const stub = env.WORKSPACE_DOS.getByName('meeting-retirement-inventory');
  await stub.retiredMeetingInventory();
  await runInDurableObject(stub, async (_instance, state) => { await state.storage.put('unrelated-fixture', 'keep'); });
  const inventory = await stub.retiredMeetingInventory();
  expect(inventory.schemaVersion).toBe(58);
  expect(inventory.references).toEqual([]);
  expect(inventory.resources).toEqual([]);
  expect(inventory.featureTables).toEqual([]);
});

it('purges attributable search decisions and fences stale registrations while preserving unrelated keys', async () => {
  const stub = env.WORKSPACE_DOS.getByName('meeting-search-retirement');
  await stub.initializeWorkspace(workspaceId, 'wnam');
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec('INSERT INTO retired_meeting_resources(resource_id, objects_deleted) VALUES (?, 1)', resourceId);
    state.storage.sql.exec(`INSERT INTO search_authorization_keys(cache_key, generation, resource_id) VALUES ('retired-test-key', 1, ?), ('unrelated-test-key', 1, NULL)`, resourceId);
    state.storage.sql.exec(`INSERT INTO authorization_snapshots VALUES ('retired-test-key', '{}', 0), ('unrelated-test-key', '{}', 0)`);
  });
  await env.AUTHORIZATION_CACHE!.put('retired-test-key', 'retired');
  await env.AUTHORIZATION_CACHE!.put('unrelated-test-key', 'keep');
  expect(await stub.purgeMeetingSearchAuthorization()).toEqual({ deletedKeys: 1 });
  expect(await env.AUTHORIZATION_CACHE!.get('retired-test-key')).toBeNull();
  expect(await env.AUTHORIZATION_CACHE!.get('unrelated-test-key')).toBe('keep');
  expect(await stub.purgeMeetingSearchAuthorization()).toEqual({ deletedKeys: 0 });
  await runInDurableObject(stub, async (instance) => {
    await expect(instance.registerSearchAuthorization({
      subject: { workspaceId, userId: ownerId, delegation: null },
      resources: [{ kind: 'resource', workspaceId, resourceId }],
    })).rejects.toThrow('meeting_notes_retired');
  });
  await runInDurableObject(stub, async (_instance, state) => {
    expect(state.storage.sql.exec('SELECT cache_key FROM authorization_snapshots').toArray()).toEqual([{ cache_key: 'unrelated-test-key' }]);
    expect(state.storage.sql.exec('SELECT cache_key FROM search_authorization_keys').toArray()).toEqual([{ cache_key: 'unrelated-test-key' }]);
  });
});
