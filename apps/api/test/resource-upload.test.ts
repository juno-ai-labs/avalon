import { asUserId, asWorkspaceId } from "@rally/contracts";
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext, Env } from '../src/env';
import { ResourceService } from '../src/services/resource-service';
import { reapDeletedResourceObjects } from '../src/services/resource-object-cleanup';
import { ATTACHMENT_TEXT_EXTRACTOR_VERSION } from '../src/services/attachment-derivative-service';
import { sha256Hex } from '../src/lib/crypto';
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";
import { runStructuredInference } from "../src/services/structured-inference";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { createTestWorkspaceDO, workspaceObjectRpcs } from "./helpers/workspace-object-rpcs";

// The naming model cannot run here; a pasted upload's call is counted instead.
vi.mock("../src/services/structured-inference", async (original) => ({
  ...await original<object>(),
  runStructuredInference: vi.fn(async () => { throw new Error("model unreachable"); }),
}));

const workspaceId = asWorkspaceId('00000000-0000-7000-8000-000000000001');
const userId = asUserId('00000000-0000-7000-8000-000000000002');
const draftId = '019fcc00-0000-7000-8000-000000000003';
const connectionId = '00000000-0000-7000-8000-000000000021';
const connectorResourceId = '00000000-0000-7000-8000-000000000022';
const markdownResourceId = '00000000-0000-7000-8000-000000000023';
const csvResourceId = '00000000-0000-7000-8000-000000000024';
const documentResourceId = '00000000-0000-7000-8000-000000000025';
const audioResourceId = '00000000-0000-7000-8000-000000000026';
const heifResourceId = '00000000-0000-7000-8000-000000000027';
const tiffResourceId = '00000000-0000-7000-8000-000000000028';

const auth: AuthContext = {
  sessionId: 'session-1',
  userId,
  workspaceId,
  region: 'global',
  role: 'owner',
};

const open: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const database of open.splice(0)) database.close(); });

interface UploadFixture {
  database: DatabaseSync;
  env: Env;
  /** Throw this from the named typed method instead of running it. */
  refuse: (method: string, error: Error, options?: { afterCommit?: boolean }) => void;
  /** Answer the named typed method from the test instead of the object. */
  answer: (method: string, value: unknown) => void;
}

/**
 * The drafts and their history live in a real WorkspaceDO over its own
 * schema: the upload commit, the draft delete, the hydration swaps and the
 * cleanup claims are typed methods on the object, and the deletion outbox is
 * written by the object's own triggers rather than a copied fixture's.
 */
function fixture(payloads: Parameters<typeof createCloudflareTestBinding<R2Bucket>>[0], bindings: Partial<Env> = {}): UploadFixture {
  const regional = new DatabaseSync(':memory:');
  open.push(regional);
  regional.exec(`CREATE TABLE workspace_members(workspace_id TEXT, user_id TEXT, status TEXT, access_class TEXT DEFAULT 'member')`);
  regional.prepare("INSERT INTO workspace_members(workspace_id,user_id,status) VALUES (?, ?, 'active')").run(workspaceId, userId);
  const workspaceObject = createTestWorkspaceDO({
    workspaceId,
    regionalDatabase: regional,
    register: (created) => { open.push(created); },
  });
  const rpcs = workspaceObjectRpcs(workspaceObject.instance, [
    "resourceExists",
    "resourceAccess",
    "listWorkstreams",
    "createUploadDraftResource",
    "deleteUploadDraftResource",
    "refreshResourceHydration",
    "publishResourceHydration",
    "listResourceVersions",
    "claimResourceSlug",
    "listReapableResourceObjects",
    "claimResourceObjectRemoval",
    "retireResourceObjectStaging",
    "recordResourceObjectCleanupFailure",
    // The listing and visibility joins still ride the runtime port; the real
    // object answers that SQL over the same store the typed methods write.
    "executeRuntimeSql",
  ]);
  const refusals = new Map<string, { error: Error; afterCommit: boolean }>();
  const answers = new Map<string, unknown>();
  const stub = Object.fromEntries(Object.entries(rpcs).map(([name, method]) => [
    name,
    async (input: unknown) => {
      if (answers.has(name)) return answers.get(name);
      const refusal = refusals.get(name);
      if (refusal && !refusal.afterCommit) throw refusal.error;
      const value = await (method as (value: unknown) => unknown)(input);
      if (refusal) throw refusal.error;
      return value;
    },
  ]));
  const binding: Env["WORKSPACE_DOS"] = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => stub,
    jurisdiction: (): Env["WORKSPACE_DOS"] => binding,
  });
  return {
    database: workspaceObject.objectDatabase,
    env: createTestEnv({
      AVALON_REGION: 'global',
      APP_ENV: 'test',
      MAX_ATTACHMENT_BYTES: '25000000',
      SESSION_SIGNING_KEY: '0'.repeat(64),
      DB: sqliteD1(regional),
      WORKSPACE_DOS: binding,
      PAYLOADS: createCloudflareTestBinding<R2Bucket>(payloads),
      ...bindings,
    }),
    refuse: (method, error, options) => refusals.set(method, {
      error,
      afterCommit: options?.afterCommit ?? false,
    }),
    answer: (method, value) => answers.set(method, value),
  };
}

describe('uploaded attachment drafts', () => {
  it('does not open a search result merely because an upload is attached somewhere', async () => {
    const get = vi.fn(async () => ({
      body: new Blob(['private']).stream(), httpEtag: '"search-preview"', writeHttpMetadata() {},
    }));
    const { database, env } = fixture({ async put() {}, get });
    const service = new ResourceService(env, auth);
    await service.upload(new File(['private'], 'private.txt', { type: 'text/plain' }), undefined, draftId);
    database.prepare("UPDATE resources SET attachment_status = 'attached', uploaded_by_user_id = ? WHERE id = ?")
      .run('00000000-0000-7000-8000-000000000004', draftId);
    const expiredAt = Date.now() + 300_000;
    vi.spyOn(Date, 'now').mockReturnValue(expiredAt);
    await expect(service.searchPreview(draftId, new AbortController().signal)).rejects.toMatchObject({ status: 404 });
    expect(get).not.toHaveBeenCalled();
  });

  it('finishes an admitted search preview and refuses the next read after ownership changes', async () => {
    let revoke = () => {};
    const { database, env } = fixture({ async put() {}, async get() {
      revoke();
      return { body: new Blob(['private']).stream(), httpEtag: '"search-preview"', writeHttpMetadata() {} };
    } });
    const service = new ResourceService(env, auth);
    await service.upload(new File(['private'], 'private.txt', { type: 'text/plain' }), undefined, draftId);
    revoke = () => { database.prepare('UPDATE resources SET uploaded_by_user_id = ? WHERE id = ?')
      .run('00000000-0000-7000-8000-000000000004', draftId); };
    const admitted = await service.searchPreview(draftId, new AbortController().signal);
    expect(await admitted.text()).toBe('private');
    await expect(service.searchPreview(draftId, new AbortController().signal)).rejects.toMatchObject({ status: 404 });
  });

  it('uses the client draft ID, hides drafts from resource lists, and deletes storage on removal', async () => {
    const stored = new Set<string>();
    const { database, env } = fixture({
      async put(key: string) { stored.add(key); },
      async delete(key: string) { stored.delete(key); },
    });
    const service = new ResourceService(env, auth);

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
    // The committed pointer adopts its staged registration in the same
    // transaction, so nothing is left for the reaper to hold.
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM resource_object_deletion_outbox",
    ).get()).toEqual({ count: 0 });
    await expect(service.list({ limit: 10 })).resolves.toMatchObject({ items: [] });

    await service.deleteDraft(draftId);
    expect(stored).toHaveLength(1);
    await reapDeletedResourceObjects(env, workspaceId);
    expect(stored).toHaveLength(0);
    await expect(service.get(draftId)).rejects.toMatchObject({ status: 404, code: 'resource_not_found' });
  });

  it('stores a long paste under its detected type, typed only once the draft is new', async () => {
    const { database, env } = fixture({ async put() {}, async delete() {} }, { OPENROUTER_API_KEY: 'test-key' });
    const naming = vi.mocked(runStructuredInference);
    naming.mockClear();
    const service = new ResourceService(env, auth);
    const paste = () => new File(['# Launch plan\n\nShip it.'], 'Pasted text 2026-10-18 at 17.10.00.txt', { type: 'text/plain' });

    const uploaded = await service.upload(paste(), undefined, draftId, undefined, true);

    // The model is unreachable, so the stand-in stem stays under the detected type.
    expect(uploaded).toMatchObject({ title: 'Pasted text 2026-10-18 at 17.10.00.md', mimeType: 'text/markdown' });
    expect(database.prepare('SELECT title, mime_type FROM resources WHERE id = ?').get(draftId))
      .toEqual({ title: 'Pasted text 2026-10-18 at 17.10.00.md', mime_type: 'text/markdown' });
    expect(naming).toHaveBeenCalledOnce();

    // A retry of a draft that already landed is refused before any model call.
    await expect(service.upload(paste(), undefined, draftId, undefined, true))
      .rejects.toMatchObject({ status: 409, code: 'attachment_draft_exists' });
    expect(naming).toHaveBeenCalledOnce();
  });

  it('preserves uploaded bytes when the resource insert commits but its response is lost', async () => {
    const stored = new Set<string>();
    const deleted: string[] = [];
    const { database, env, refuse } = fixture({
      async put(key: string) { stored.add(key); },
      async delete(key: string) { deleted.push(key); stored.delete(key); },
    });
    refuse('createUploadDraftResource', new Error('forced_rpc_failure'), { afterCommit: true });

    await expect(new ResourceService(env, auth).upload(
      new File(['durable'], 'durable.txt', { type: 'text/plain' }),
      undefined,
      draftId,
    )).rejects.toThrow('forced_rpc_failure');

    const resource = database.prepare(
      'SELECT content_ref FROM resources WHERE id = ?',
    ).get(draftId) as { content_ref: string };
    expect(deleted).toEqual([]);
    expect(stored).toEqual(new Set([resource.content_ref]));
    // The commit adopted the staged registration, so the ambiguous caller has
    // nothing left to release and the bytes stay owned by the committed row.
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM resource_object_deletion_outbox`,
    ).get()).toEqual({ count: 0 });
  });

  it('releases the staged object when a concurrent upload wins the same draft id', async () => {
    // The duplicate is a typed outcome now, not a lost race surfacing as a
    // bare primary-key throw: the object wrote nothing, so the service hands
    // the staged bytes straight back to the reaper before its 409.
    const stored = new Set<string>();
    const { database, env, answer } = fixture({
      async put(key: string) { stored.add(key); },
      async delete(key: string) { stored.delete(key); },
    });
    const service = new ResourceService(env, auth);
    await service.upload(new File(['first'], 'first.txt', { type: 'text/plain' }), undefined, draftId);
    // The race: the pre-staging existence check ran before the first upload
    // committed, so the second attempt stages its bytes and only the object's
    // own critical section can refuse it.
    answer('resourceExists', { exists: false });

    await expect(service.upload(
      new File(['second'], 'second.txt', { type: 'text/plain' }),
      undefined,
      draftId,
    )).rejects.toMatchObject({ status: 409, code: 'attachment_draft_exists' });

    expect(database.prepare('SELECT title FROM resources WHERE id = ?').get(draftId))
      .toEqual({ title: 'first.txt' });
    // The loser's staged registration went back to the reaper.
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM resource_object_deletion_outbox WHERE cleanup_eligible = 1`,
    ).get()).toEqual({ count: 1 });
    expect(stored.size).toBe(2);
  });

  it('projects connector refresh support and watch state consistently for resource reads', async () => {
    const { database, env } = fixture({});
    insertHydratedResource(database, 'existing-original', 'b'.repeat(64));

    const refreshable = new ResourceService(env, auth, fakeHydrationRegistry({ revision: 2 }));
    await expect(refreshable.get(connectorResourceId)).resolves.toMatchObject({
      refreshSupported: true,
      watchEnabled: false,
      watchStatus: 'paused',
    });
    await expect(refreshable.list({ limit: 10 })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: connectorResourceId, refreshSupported: true })],
    });

    database.prepare(`INSERT INTO resource_watches
      (id, workspace_id, workstream_id, resource_id, connection_id, watch_type, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'poll', 1, ?, ?)`).run(
      '00000000-0000-7000-8000-000000000031', workspaceId,
      '00000000-0000-7000-8000-000000000032', connectorResourceId, connectionId,
      '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z',
    );
    await expect(refreshable.get(connectorResourceId)).resolves.toMatchObject({
      refreshSupported: true, watchEnabled: true, watchStatus: 'watching',
    });
    await expect(refreshable.list({ limit: 10 })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: connectorResourceId, refreshSupported: true, watchEnabled: true, watchStatus: 'watching' })],
    });
    database.prepare('UPDATE resource_watches SET enabled = 0 WHERE resource_id = ?').run(connectorResourceId);

    const notRefreshable = new ResourceService(env, auth, {
      get() { return {}; },
    } as never);
    await expect(notRefreshable.get(connectorResourceId)).resolves.toMatchObject({
      refreshSupported: false,
      watchStatus: 'paused',
    });
  });

  it("does not allow another member to delete a user's draft", async () => {
    const stored = new Set<string>();
    const { env } = fixture({
      async put(key: string) { stored.add(key); },
      async delete(key: string) { stored.delete(key); },
    });
    await new ResourceService(env, auth).upload(new File(['private'], 'private.txt'), undefined, draftId);

    const other = new ResourceService(env, { ...auth, userId: asUserId('00000000-0000-7000-8000-000000000004') });
    await expect(other.deleteDraft(draftId)).rejects.toMatchObject({ status: 404, code: 'attachment_draft_not_found' });
    expect(stored).toHaveLength(1);
  });

  it("refuses to delete a draft reserved by a pending work-stream input", async () => {
    const { database, env } = fixture({ async put() {}, async delete() {} });
    const service = new ResourceService(env, auth);
    await service.upload(new File(["pending"], "pending.txt"), undefined, draftId);
    database.prepare(
      `INSERT INTO pending_attachment_reservations
         (workspace_id, workstream_id, input_id, resource_id, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      workspaceId,
      "00000000-0000-7000-8000-000000000005",
      "00000000-0000-7000-8000-000000000006",
      draftId,
      userId,
      Date.now(),
    );

    await expect(service.deleteDraft(draftId)).rejects.toMatchObject({
      status: 404,
      code: "attachment_draft_not_found",
    });
    expect(database.prepare("SELECT id FROM resources WHERE id = ?").get(draftId))
      .toEqual({ id: draftId });
  });

  it('refreshes connector content with a fenced generation and invalidates every old derivative', async () => {
    const stored = new Map<string, string>([['old-original', 'old']]);
    const { database, env } = fixture({
      async put(key: string, value: string) { stored.set(key, value); },
      async delete(key: string) { stored.delete(key); },
    });
    insertHydratedResource(database, 'old-original', 'old-hash');
    const service = new ResourceService(env, auth, fakeHydrationRegistry({ revision: 2 }));

    await service.hydrate(connectorResourceId);

    const current = database.prepare(
      `SELECT content_ref, content_sha256, model_content_ref, model_content_status
         FROM resources WHERE id = ?`,
    ).get(connectorResourceId) as Record<string, unknown>;
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
  });

  it('serves source Markdown and a ready Office derivative through the preview boundary', async () => {
    const contents = new Map([
      ['source-markdown', '# Source brief'],
      ['source-csv', 'month,total\nJuly,42'],
      ['model-document', '# Converted proposal'],
      ['source-audio', 'ID3audio'],
    ]);
    const reads: string[] = [];
    const { database, env } = fixture({
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
    });
    const previewRow = database.prepare(`
      INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, mime_type, content_ref,
         content_sha256, model_content_ref, model_mime_type, model_content_sha256,
         model_content_status, model_content_extractor_version, model_content_character_count,
         metadata_json, attachment_status, created_at, updated_at)
      VALUES (?, ?, 'uploaded_file', 'avalon_upload', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}',
              'attached', '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z')
    `);
    previewRow.run(markdownResourceId, workspaceId, 'brief.md', 'text/markdown', 'source-markdown',
      'a'.repeat(64), null, null, null, 'pending', null, null);
    previewRow.run(csvResourceId, workspaceId, '数据.csv', 'text/csv', 'source-csv',
      'd'.repeat(64), null, null, null, 'pending', null, null);
    previewRow.run(documentResourceId, workspaceId, 'proposal.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'source-document', 'b'.repeat(64), 'model-document', 'text/markdown',
      'c'.repeat(64), 'ready', ATTACHMENT_TEXT_EXTRACTOR_VERSION, 20);
    previewRow.run(audioResourceId, workspaceId, 'voice.mp3', 'audio/mpeg', 'source-audio',
      'e'.repeat(64), null, null, null, 'unsupported', ATTACHMENT_TEXT_EXTRACTOR_VERSION, null);
    database.prepare('UPDATE resources SET uploaded_by_user_id = ?').run(userId);
    const service = new ResourceService(env, auth);

    const markdown = await service.preview(markdownResourceId, new AbortController().signal);
    expect(await markdown.text()).toBe('# Source brief');
    expect(markdown.headers.get('content-disposition')).toBe("inline; filename=\"brief.md\"; filename*=UTF-8''brief.md");

    const csv = await service.preview(csvResourceId, new AbortController().signal);
    expect(await csv.text()).toBe('month,total\nJuly,42');
    expect(csv.headers.get('content-disposition'))
      .toBe("inline; filename=\"__.csv\"; filename*=UTF-8''%E6%95%B0%E6%8D%AE.csv");

    const document = await service.preview(documentResourceId, new AbortController().signal);
    expect(await document.text()).toBe('# Converted proposal');
    const audio = await service.preview(audioResourceId, new AbortController().signal);
    expect(await audio.text()).toBe('ID3audio');
    expect(reads).toEqual(['source-markdown', 'source-csv', 'model-document', 'source-audio']);
  });

  it('validates cached images without reading R2 and refuses a revoked reader', async () => {
    const reads: string[] = [];
    const { database, env } = fixture({
      async get(key: string) {
        reads.push(key);
        return {
          body: new Blob([key === 'updated-image' ? 'updated image bytes' : 'PNG image bytes']).stream(), httpEtag: '"object-etag"',
          writeHttpMetadata(headers: Headers) { headers.set('content-type', 'image/png'); },
        };
      },
    });
    database.prepare(`INSERT INTO resources
      (id, workspace_id, resource_type, provider, title, mime_type, content_ref,
       content_sha256, model_content_status, metadata_json, attachment_status,
       uploaded_by_user_id, created_at, updated_at)
      VALUES (?, ?, 'uploaded_file', 'avalon_upload', 'image.png', 'image/png', 'original-image',
        ?, 'pending', '{}', 'attached', ?, '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z')`)
      .run(draftId, workspaceId, 'a'.repeat(64), userId);
    const service = new ResourceService(env, auth);
    const preview = (etag?: string) => service.preview(draftId, new AbortController().signal, etag);
    const first = await preview();
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('PNG image bytes');
    const etag = first.headers.get('etag')!;
    expect(etag).toBe(`"image-preview-v1:1:${'a'.repeat(64)}"`);
    const cached = await preview(`"another-image", W/${etag}`);
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe('');
    expect(cached.headers.get('cache-control')).toBe('private, no-store');
    expect(reads).toEqual(['original-image']);

    // A changed resource must ignore the old validator and deliver new bytes.
    database.prepare("UPDATE resources SET content_sha256 = ?, content_ref = 'updated-image' WHERE id = ?").run('b'.repeat(64), draftId);
    const changed = await preview(etag);
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe('updated image bytes');
    expect(changed.headers.get('etag')).not.toBe(etag);
    expect(reads).toEqual(['original-image', 'updated-image']);

    database.prepare('UPDATE resources SET uploaded_by_user_id = ? WHERE id = ?')
      .run('00000000-0000-7000-8000-000000000004', draftId);
    await expect(preview(changed.headers.get('etag')!)).rejects.toMatchObject({ status: 404 });
    expect(reads).toEqual(['original-image', 'updated-image']);
  });

  it('normalizes HEIF and TIFF preview bytes into a format Chromium can decode', async () => {
    const heif = new Uint8Array([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0,
    ]);
    const tiff = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const sources = new Map<string, Uint8Array>([['source-heif', heif], ['source-tiff', tiff]]);
    const { database, env } = fixture({
      async get(key: string) {
        const bytes = sources.get(key);
        if (!bytes) return null;
        return {
          size: bytes.byteLength,
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      },
    }, { IMAGES: fakeImagesBinding(jpeg) });
    const previewRow = database.prepare(`
      INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, mime_type, content_ref,
         content_sha256, model_content_status, metadata_json, attachment_status, created_at, updated_at)
      VALUES (?, ?, 'uploaded_file', 'avalon_upload', ?, ?, ?, ?, 'pending', '{}',
              'attached', '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z')
    `);
    previewRow.run(heifResourceId, workspaceId, 'phone.heic', 'image/heif', 'source-heif', 'f'.repeat(64));
    previewRow.run(tiffResourceId, workspaceId, 'scan.tiff', 'image/tiff', 'source-tiff', '1'.repeat(64));
    database.prepare('UPDATE resources SET uploaded_by_user_id = ?').run(userId);
    const service = new ResourceService(env, auth);

    for (const id of [heifResourceId, tiffResourceId]) {
      const response = await service.preview(id, new AbortController().signal);
      expect(response.headers.get('content-type')).toBe('image/jpeg');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(jpeg);
    }
  });

  it('updates only hydration timestamps when connector content is unchanged', async () => {
    const payload = { revision: 1 };
    const put = vi.fn(async () => undefined);
    const { database, env } = fixture({ put, async delete() { return undefined; } });
    insertHydratedResource(database, 'same-original', await sha256Hex(JSON.stringify(payload)));

    await new ResourceService(env, auth, fakeHydrationRegistry(payload)).hydrate(connectorResourceId);

    expect(put).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT content_ref, model_content_ref FROM resources WHERE id = ?",
    ).get(connectorResourceId)).toEqual({ content_ref: 'same-original', model_content_ref: 'old-model' });
    expect(database.prepare("SELECT COUNT(*) AS count FROM resource_object_deletion_outbox").get())
      .toEqual({ count: 0 });
  });

  it('stages an ambiguous connector generation while preserving the previous current state', async () => {
    const deleted: string[] = [];
    const stored = new Set<string>(['old-original']);
    const { database, env, refuse } = fixture({
      async put(key: string) { stored.add(key); },
      async delete(key: string) { deleted.push(key); stored.delete(key); },
    });
    insertHydratedResource(database, 'old-original', 'old-hash');
    // An RPC failure whose commit state is unknown: the swap must not be
    // retried blind, and the staged object must stay owned by its publisher.
    refuse('publishResourceHydration', new Error('forced_rpc_failure'));

    await expect(new ResourceService(env, auth, fakeHydrationRegistry({ revision: 3 }))
      .hydrate(connectorResourceId)).rejects.toThrow('forced_rpc_failure');

    expect(deleted).toEqual([]);
    expect([...stored]).toHaveLength(2);
    expect([...stored].find((key) => key !== 'old-original')).toMatch(/\/hydrated\//u);
    expect(database.prepare(
      "SELECT cleanup_eligible FROM resource_object_deletion_outbox WHERE object_kind = 'original'",
    ).get()).toEqual({ cleanup_eligible: 0 });
    expect(database.prepare(
      `SELECT content_ref, content_sha256, model_content_ref
         FROM resources WHERE id = ?`,
    ).get(connectorResourceId)).toEqual({
      content_ref: 'old-original',
      content_sha256: 'old-hash',
      model_content_ref: 'old-model',
    });
  });
});

function insertHydratedResource(database: DatabaseSync, contentRef: string, contentSha256: string): void {
  database.prepare(`
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, display_name, status,
       model_plugin_id, created_at, updated_at)
    VALUES (?, ?, 'granola', 'workspace', 'Granola', 'healthy', 'granola-plugin',
            '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z')
  `).run(connectionId, workspaceId);
  database.prepare(`
    INSERT INTO resources
      (id, workspace_id, connection_id, resource_type, provider, provider_resource_id, title,
       content_ref, content_sha256, model_content_ref, model_mime_type, model_content_sha256,
       model_content_status, metadata_json, attachment_status, created_at, updated_at)
    VALUES (?, ?, ?, 'meeting', 'granola', 'not_12345678901234', 'Meeting', ?, ?, 'old-model',
            'text/markdown', ?, 'ready', '{}', 'attached',
            '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z')
  `).run(connectorResourceId, workspaceId, connectionId, contentRef, contentSha256, 'a'.repeat(64));
}

function fakeHydrationRegistry(value: unknown): NonNullable<ConstructorParameters<typeof ResourceService>[2]> {
  return {
    get() {
      return { hydrateResource: async () => value };
    },
  } as never;
}

function fakeImagesBinding(output: Uint8Array): ImagesBinding {
  return createCloudflareTestBinding<ImagesBinding>({
    input() {
      const transformer = {
        transform() { return transformer; },
        async output() {
          return {
            image() { return new Blob([exactArrayBuffer(output)]).stream(); },
            contentType() { return 'image/jpeg'; },
            response() { return new Response(exactArrayBuffer(output), { headers: { 'content-type': 'image/jpeg' } }); },
          };
        },
      };
      return transformer;
    },
  });
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
