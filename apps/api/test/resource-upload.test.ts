import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AuthContext, Env } from '../src/env';
import { ResourceService } from '../src/services/resource-service';

const workspaceId = '00000000-0000-7000-8000-000000000001';
const userId = '00000000-0000-7000-8000-000000000002';
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
    const environment = {
      AVALON_REGION: 'global',
      MAX_ATTACHMENT_BYTES: '25000000',
      DB: sqliteD1(database),
      PAYLOADS: {
        async put(key: string) { stored.add(key); },
        async delete(key: string) { stored.delete(key); },
      },
    } as unknown as Env;
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
    expect(stored).toEqual(new Set([`global/${workspaceId}/resources/${draftId}`]));
    await expect(service.list({ limit: 10 })).resolves.toMatchObject({ items: [] });

    await service.deleteDraft(draftId);
    expect(stored).toHaveLength(0);
    await expect(service.get(draftId)).rejects.toMatchObject({ status: 404, code: 'resource_not_found' });
    database.close();
  });

  it("does not allow another member to delete a user's draft", async () => {
    const database = attachmentDatabase();
    const stored = new Set<string>();
    const environment = {
      AVALON_REGION: 'global',
      MAX_ATTACHMENT_BYTES: '25000000',
      DB: sqliteD1(database),
      PAYLOADS: {
        async put(key: string) { stored.add(key); },
        async delete(key: string) { stored.delete(key); },
      },
    } as unknown as Env;
    await new ResourceService(environment, auth).upload(new File(['private'], 'private.txt'), undefined, draftId);

    const other = new ResourceService(environment, { ...auth, userId: '00000000-0000-7000-8000-000000000004' });
    await expect(other.deleteDraft(draftId)).rejects.toMatchObject({ status: 404, code: 'attachment_draft_not_found' });
    expect(stored).toHaveLength(1);
    database.close();
  });
});

function attachmentDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE connector_connections (id TEXT PRIMARY KEY, scope TEXT NOT NULL, owner_user_id TEXT);
    CREATE TABLE resources (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, connection_id TEXT,
      resource_type TEXT NOT NULL, provider TEXT NOT NULL, provider_resource_id TEXT,
      title TEXT NOT NULL, mime_type TEXT, canonical_url TEXT, content_ref TEXT,
      model_content_ref TEXT, model_mime_type TEXT, model_content_sha256 TEXT, model_metadata_json TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}', last_hydrated_at TEXT,
      uploaded_by_user_id TEXT, attachment_status TEXT NOT NULL DEFAULT 'attached',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE automation_subscriptions (id TEXT PRIMARY KEY, scope TEXT NOT NULL, owner_user_id TEXT);
    CREATE TABLE workstreams (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, automation_subscription_id TEXT);
    CREATE TABLE workstream_participants (workstream_id TEXT NOT NULL, user_id TEXT NOT NULL, removed_at TEXT);
    CREATE TABLE workstream_resources (workstream_id TEXT NOT NULL, resource_id TEXT NOT NULL, relationship_type TEXT NOT NULL);
    CREATE TABLE message_attachments (message_id TEXT NOT NULL, resource_id TEXT NOT NULL);
    CREATE TABLE resource_watches (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workstream_id TEXT NOT NULL,
      resource_id TEXT NOT NULL, enabled INTEGER NOT NULL
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, resource_id TEXT NOT NULL,
      scope TEXT NOT NULL, owner_user_id TEXT NOT NULL, archived_at TEXT
    );
  `);
  return database;
}

function sqliteD1(database: DatabaseSync): D1Database {
  const prepare = (sql: string): D1PreparedStatement => {
    let values: unknown[] = [];
    const statement = {
      bind(...next: unknown[]) { values = next; return statement; },
      async first<T>() { return (database.prepare(sql).get(...values as never[]) ?? null) as T | null; },
      async all<T>() {
        return { results: database.prepare(sql).all(...values as never[]) as T[], success: true, meta: {} } as unknown as D1Result<T>;
      },
      async run<T>() {
        const result = database.prepare(sql).run(...values as never[]);
        return { results: [], success: true, meta: { changes: Number(result.changes) } } as unknown as D1Result<T>;
      },
    };
    return statement as unknown as D1PreparedStatement;
  };
  return { prepare } as unknown as D1Database;
}
