import { asUserId, asWorkspaceId } from "@rally/contracts";
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../src/env';
import { ResourceService } from '../src/services/resource-service';
import { reapDeletedResourceObjects } from '../src/services/resource-object-cleanup';
import { ATTACHMENT_TEXT_EXTRACTOR_VERSION } from '../src/services/attachment-derivative-service';
import { sha256Hex } from '../src/lib/crypto';
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";
import { applyWorkspaceResourceVersioning } from "./helpers/workspace-object-tables";

const workspaceId = asWorkspaceId('00000000-0000-7000-8000-000000000001');
const userId = asUserId('00000000-0000-7000-8000-000000000002');
const draftId = '019fcc00-0000-7000-8000-000000000003';

const auth: AuthContext = {
  sessionId: 'session-1',
  userId,
  workspaceId,
  region: 'global',
  role: 'owner',
};

describe('uploaded attachment drafts', () => {
  it('uses the client draft ID, hides drafts from resource lists, and deletes storage on removal', async () => {
    const database = attachmentDatabase();
    const stored = new Set<string>();
    const environment = createTestEnv({
      AVALON_REGION: 'global',
      MAX_ATTACHMENT_BYTES: '25000000',
      DB: sqliteD1(database),
      PAYLOADS: {
        async put(key: string) { stored.add(key); },
        async delete(key: string) { stored.delete(key); },
      },
    });
    const service = new ResourceService(environment, auth);

    const uploaded = await service.upload(
      new File(['hello'], 'notes.txt', { type: 'text/plain' }),
      undefined,
      draftId,
    );

    expect(uploaded).toMatchObject({
      id: draftId,
      title: 'notes.txt',
      mimeType: 'text/plain',
      contentAvailable: true,
      sizeBytes: 5,
    });
    expect([...stored]).toHaveLength(1);
    expect([...stored][0]).toMatch(new RegExp(`^global/${workspaceId}/resources/${draftId}/[a-f0-9]{64}/[0-9a-f-]+$`, 'u'));
    expect(database.prepare(
      "SELECT content_sha256, model_content_status FROM resources WHERE id = ?",
    ).get(draftId)).toEqual({
      content_sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      model_content_status: "pending",
    });
    await expect(service.list({ limit: 10 })).resolves.toMatchObject({ items: [] });

    await service.deleteDraft(draftId);
    expect(stored).toHaveLength(1);
    await reapDeletedResourceObjects(environment);
    expect(stored).toHaveLength(0);
    await expect(service.get(draftId)).rejects.toMatchObject({ status: 404, code: 'resource_not_found' });
    database.close();
  });

  it("does not allow another member to delete a user's draft", async () => {
    const database = attachmentDatabase();
    const stored = new Set<string>();
    const environment = createTestEnv({
      AVALON_REGION: 'global',
      MAX_ATTACHMENT_BYTES: '25000000',
      DB: sqliteD1(database),
      PAYLOADS: {
        async put(key: string) { stored.add(key); },
        async delete(key: string) { stored.delete(key); },
      },
    });
    await new ResourceService(environment, auth).upload(new File(['private'], 'private.txt'), undefined, draftId);

    const other = new ResourceService(environment, { ...auth, userId: asUserId('00000000-0000-7000-8000-000000000004') });
    await expect(other.deleteDraft(draftId)).rejects.toMatchObject({ status: 404, code: 'attachment_draft_not_found' });
    expect(stored).toHaveLength(1);
    database.close();
  });

  it('refreshes connector content with a fenced generation and invalidates every old derivative', async () => {
    const database = attachmentDatabase();
    insertHydratedResource(database, 'old-original', 'old-hash');
    const stored = new Map<string, string>([['old-original', 'old']]);
    const environment = createTestEnv({
      AVALON_REGION: 'global',
      DB: sqliteD1(database),
      PAYLOADS: {
        async put(key: string, value: string) { stored.set(key, value); },
        async delete(key: string) { stored.delete(key); },
      },
    });
    const service = new ResourceService(environment, auth, fakeHydrationRegistry({ revision: 2 }));

    await service.hydrate('connector-resource');

    const current = database.prepare(
      `SELECT content_ref, content_sha256, model_content_ref, model_content_status
         FROM resources WHERE id = 'connector-resource'`,
    ).get() as Record<string, unknown>;
    expect(current.content_ref).toMatch(/\/hydrated\/[a-f0-9]{64}\/[0-9a-f-]+\.json$/u);
    expect(current.content_sha256).toBe(await sha256Hex(JSON.stringify({ revision: 2 })));
    expect(current).toMatchObject({ model_content_ref: null, model_content_status: 'pending' });
    expect(database.prepare(
      `SELECT object_ref, object_kind FROM resource_object_deletion_outbox
       WHERE object_ref IN ('old-original', 'old-model') ORDER BY object_ref`,
    ).all()).toEqual([
      { object_ref: 'old-model', object_kind: 'derivative' },
      { object_ref: 'old-original', object_kind: 'original' },
    ]);
    expect(stored.has('old-original')).toBe(true);
    expect(stored.has(String(current.content_ref))).toBe(true);
    database.close();
  });

  it('serves source Markdown and a ready Office derivative through the preview boundary', async () => {
    const database = attachmentDatabase();
    database.exec(`
      INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, mime_type, content_ref,
         content_sha256, model_content_ref, model_mime_type, model_content_sha256,
         model_content_status, model_content_extractor_version, model_content_character_count,
         metadata_json, attachment_status, created_at, updated_at)
      VALUES
        ('markdown-resource', '${workspaceId}', 'uploaded_file', 'avalon_upload', 'brief.md',
         'text/markdown', 'source-markdown', '${'a'.repeat(64)}', NULL, NULL, NULL,
         'pending', NULL, NULL, '{}', 'attached', '2026-08-12', '2026-08-12'),
        ('csv-resource', '${workspaceId}', 'uploaded_file', 'avalon_upload', '数据.csv',
         'text/csv', 'source-csv', '${'d'.repeat(64)}', NULL, NULL, NULL,
         'pending', NULL, NULL, '{}', 'attached', '2026-08-12', '2026-08-12'),
        ('document-resource', '${workspaceId}', 'uploaded_file', 'avalon_upload', 'proposal.docx',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'source-document', '${'b'.repeat(64)}', 'model-document', 'text/markdown',
         '${'c'.repeat(64)}', 'ready', '${ATTACHMENT_TEXT_EXTRACTOR_VERSION}', 20,
         '{}', 'attached', '2026-08-12', '2026-08-12');
    `);
    const contents = new Map([
      ['source-markdown', '# Source brief'],
      ['source-csv', 'month,total\nJuly,42'],
      ['model-document', '# Converted proposal'],
    ]);
    const reads: string[] = [];
    const environment = createTestEnv({
      DB: sqliteD1(database),
      PAYLOADS: {
        async get(key: string) {
          reads.push(key);
          const content = contents.get(key);
          if (content === undefined) return null;
          return {
            body: new Blob([content], { type: 'text/markdown' }).stream(),
            httpEtag: '"preview-etag"',
            writeHttpMetadata(headers: Headers) { headers.set('content-type', 'text/markdown; charset=utf-8'); },
          };
        },
      },
    });
    const service = new ResourceService(environment, auth);

    const markdown = await service.preview('markdown-resource', new AbortController().signal);
    expect(await markdown.text()).toBe('# Source brief');
    expect(markdown.headers.get('content-disposition')).toBe("inline; filename=\"brief.md\"; filename*=UTF-8''brief.md");

    const csv = await service.preview('csv-resource', new AbortController().signal);
    expect(await csv.text()).toBe('month,total\nJuly,42');
    expect(csv.headers.get('content-disposition'))
      .toBe("inline; filename=\"__.csv\"; filename*=UTF-8''%E6%95%B0%E6%8D%AE.csv");

    const document = await service.preview('document-resource', new AbortController().signal);
    expect(await document.text()).toBe('# Converted proposal');
    expect(reads).toEqual(['source-markdown', 'source-csv', 'model-document']);
    database.close();
  });

  it('updates only hydration timestamps when connector content is unchanged', async () => {
    const database = attachmentDatabase();
    const payload = { revision: 1 };
    insertHydratedResource(database, 'same-original', await sha256Hex(JSON.stringify(payload)));
    const put = vi.fn(async () => undefined);
    const environment = createTestEnv({
      AVALON_REGION: 'global',
      DB: sqliteD1(database),
      PAYLOADS: { put, async delete() { return undefined; } },
    });

    await new ResourceService(environment, auth, fakeHydrationRegistry(payload)).hydrate('connector-resource');

    expect(put).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT content_ref, model_content_ref FROM resources WHERE id = 'connector-resource'",
    ).get()).toEqual({ content_ref: 'same-original', model_content_ref: 'old-model' });
    expect(database.prepare("SELECT COUNT(*) AS count FROM resource_object_deletion_outbox").get())
      .toEqual({ count: 0 });
    database.close();
  });

  it('deletes a failed connector generation while preserving the previous current state', async () => {
    const database = attachmentDatabase();
    insertHydratedResource(database, 'old-original', 'old-hash');
    const deleted: string[] = [];
    const stored = new Set<string>(['old-original']);
    const environment = createTestEnv({
      AVALON_REGION: 'global',
      DB: sqliteD1(database, (sql) => sql.includes('SET content_ref = ?')),
      PAYLOADS: {
        async put(key: string) { stored.add(key); },
        async delete(key: string) { deleted.push(key); stored.delete(key); },
      },
    });

    await expect(new ResourceService(environment, auth, fakeHydrationRegistry({ revision: 3 }))
      .hydrate('connector-resource')).rejects.toThrow('forced_d1_failure');

    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(/\/hydrated\//u);
    expect(stored).toEqual(new Set(['old-original']));
    expect(database.prepare(
      `SELECT content_ref, content_sha256, model_content_ref
         FROM resources WHERE id = 'connector-resource'`,
    ).get()).toEqual({
      content_ref: 'old-original',
      content_sha256: 'old-hash',
      model_content_ref: 'old-model',
    });
    database.close();
  });
});

function attachmentDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(`
    CREATE TABLE connector_connections (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, connector_type TEXT NOT NULL,
      scope TEXT NOT NULL, owner_user_id TEXT, status TEXT NOT NULL,
      granted_scopes_json TEXT NOT NULL DEFAULT '[]', cursor_json TEXT NOT NULL DEFAULT '{}',
      config_json TEXT NOT NULL DEFAULT '{}', encrypted_credentials TEXT, credential_iv TEXT,
      credential_key_version INTEGER, updated_at TEXT, error_json TEXT
    );
    CREATE TABLE resources (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, connection_id TEXT,
      resource_type TEXT NOT NULL, provider TEXT NOT NULL, provider_resource_id TEXT,
      title TEXT NOT NULL, mime_type TEXT, canonical_url TEXT, content_ref TEXT,
      model_content_ref TEXT, model_mime_type TEXT, model_content_sha256 TEXT, model_metadata_json TEXT,
      content_sha256 TEXT, model_content_status TEXT, model_content_extractor_version TEXT,
      model_content_character_count INTEGER, model_content_extracted_at TEXT,
      model_content_error_code TEXT,
      model_content_claimed_at TEXT, model_content_claim_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}', last_hydrated_at TEXT,
      uploaded_by_user_id TEXT, attachment_status TEXT NOT NULL DEFAULT 'attached',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE automation_subscriptions (id TEXT PRIMARY KEY, scope TEXT NOT NULL, owner_user_id TEXT);
    CREATE TABLE workstreams (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, automation_subscription_id TEXT);
    CREATE TABLE workstream_participants (workstream_id TEXT NOT NULL, user_id TEXT NOT NULL, removed_at TEXT);
    CREATE TABLE workstream_resources (workstream_id TEXT NOT NULL, resource_id TEXT NOT NULL, relationship_type TEXT NOT NULL);
    -- The workspace object's link table. The draft-hiding statement reads it
    -- now that the closed-authority arm reading message_attachments is gone.
    CREATE TABLE workspace_workstream_resource_links (workstream_id TEXT NOT NULL, resource_id TEXT NOT NULL);
    CREATE TABLE message_attachments (message_id TEXT NOT NULL, resource_id TEXT NOT NULL);
    CREATE TABLE resource_watches (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workstream_id TEXT NOT NULL,
      resource_id TEXT NOT NULL, enabled INTEGER NOT NULL
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, resource_id TEXT NOT NULL,
      scope TEXT NOT NULL, owner_user_id TEXT NOT NULL, archived_at TEXT
    );
    CREATE TABLE resource_object_deletion_outbox (
      object_ref TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, resource_id TEXT NOT NULL,
      object_kind TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TRIGGER resources_enqueue_objects_before_delete
    BEFORE DELETE ON resources
    BEGIN
      INSERT OR IGNORE INTO resource_object_deletion_outbox
        (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
        SELECT OLD.content_ref, OLD.workspace_id, OLD.id, 'original', datetime('now'), datetime('now')
        WHERE OLD.content_ref IS NOT NULL;
    END;
    CREATE TRIGGER resources_track_original_after_update
    AFTER UPDATE OF content_ref ON resources
    WHEN OLD.content_ref IS NOT NEW.content_ref AND OLD.content_ref IS NOT NULL
    BEGIN
      DELETE FROM resource_object_deletion_outbox
       WHERE workspace_id = NEW.workspace_id AND object_ref = NEW.content_ref;
      INSERT OR IGNORE INTO resource_object_deletion_outbox
        (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
      VALUES (OLD.content_ref, OLD.workspace_id, OLD.id, 'original', datetime('now'), datetime('now'));
    END;
    CREATE TRIGGER resources_track_models_after_update
    AFTER UPDATE OF model_content_ref ON resources
    BEGIN
      DELETE FROM resource_object_deletion_outbox
       WHERE workspace_id = NEW.workspace_id AND object_ref = NEW.model_content_ref;
      INSERT OR IGNORE INTO resource_object_deletion_outbox
        (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
      SELECT OLD.model_content_ref, OLD.workspace_id, OLD.id, 'derivative', datetime('now'), datetime('now')
      WHERE OLD.model_content_ref IS NOT NULL AND OLD.model_content_ref IS NOT NEW.model_content_ref;
    END;
  `);
  // Version capture is WorkspaceDO's, and a hydrate or upload here is a write
  // that capture observes — so the history side comes from the object's own
  // ledger rather than from a stub that could not record anything.
  applyWorkspaceResourceVersioning(database, workspaceId);
  return database;
}

function sqliteD1(database: DatabaseSync, failOnce?: (sql: string) => boolean): D1Database {
  let failed = false;
  const prepare = (sql: string): D1PreparedStatement => {
    let values: unknown[] = [];
    const statement = {
      bind(...next: unknown[]) { values = next; return statement; },
      async first<T>() { return (database.prepare(sql).get(...values as never[]) ?? null) as T | null; },
      async all<T>() {
        return createTestD1Result<T>({ results: database.prepare(sql).all(...values as never[]) as T[], success: true, meta: {} });
      },
      async run<T>() {
        if (!failed && failOnce?.(sql)) { failed = true; throw new Error('forced_d1_failure'); }
        const result = database.prepare(sql).run(...values as never[]);
        return createTestD1Result<T>({ results: [], success: true, meta: { changes: Number(result.changes) } });
      },
    };
    return createTestD1PreparedStatement(statement);
  };
  return createTestD1Database({ prepare });
}

function insertHydratedResource(database: DatabaseSync, contentRef: string, contentSha256: string): void {
  database.exec(`
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, status, updated_at)
    VALUES ('connector-one', '${workspaceId}', 'granola', 'workspace', 'healthy', '2026-08-12');
    INSERT INTO resources
      (id, workspace_id, connection_id, resource_type, provider, provider_resource_id, title,
       content_ref, content_sha256, model_content_ref, model_mime_type, model_content_sha256,
       model_content_status, metadata_json, attachment_status, created_at, updated_at)
    VALUES ('connector-resource', '${workspaceId}', 'connector-one', 'meeting', 'granola',
      'not_12345678901234', 'Meeting', '${contentRef}', '${contentSha256}', 'old-model',
      'text/markdown', '${'a'.repeat(64)}', 'ready', '{}', 'attached', '2026-08-12', '2026-08-12');
  `);
}

function fakeHydrationRegistry(value: unknown): NonNullable<ConstructorParameters<typeof ResourceService>[2]> {
  return {
    get() {
      return { hydrateResource: async () => value };
    },
  } as never;
}
