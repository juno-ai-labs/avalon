/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { asSubstreamId, asUserId, asWorkspaceId } from '@rally/contracts';
import { workspaceDOName } from '../src/durable-objects/names';
import { AuthorizationService } from '../src/services/authorization-service';
import { pushSearchAuthorization } from '../src/services/search-authorization';
import type { AuthorizationResource } from '../src/services/authorization-policy';

const WORKSPACE_ID = asWorkspaceId('00000000-0000-7000-8000-000000000c01');
const OWNER = '00000000-0000-7000-8000-000000000c02';
const MEMBER = '00000000-0000-7000-8000-000000000c03';
const OUTSIDER = '00000000-0000-7000-8000-000000000c04';
/** A Canvas open to the Organization, and one only its creator and participants open. */
const OPEN_ROOM = '00000000-0000-7000-8000-000000000c11';
const PRIVATE_ROOM = '00000000-0000-7000-8000-000000000c12';
const AUTOMATION = '00000000-0000-7000-8000-000000000c21';
const CHILD = '00000000-0000-7000-8000-000000000c31';
const RUN = '00000000-0000-7000-8000-000000000c32';
const WORKSPACE_CONNECTION = '00000000-0000-7000-8000-000000000c41';
const PERSONAL_CONNECTION = '00000000-0000-7000-8000-000000000c42';
const SYNCED_FILE = '00000000-0000-7000-8000-000000000c51';
const UPLOAD = '00000000-0000-7000-8000-000000000c52';
const NOTE = '00000000-0000-7000-8000-000000000c53';

const subject = (userId: string) => ({ workspaceId: WORKSPACE_ID, userId: asUserId(userId), delegation: null });
const conversation = (parentId: string, substreamId: string) => ({ kind: 'conversation' as const, workspaceId: WORKSPACE_ID, parentId, substreamId: asSubstreamId(substreamId) });
const resource = (resourceId: string) => ({ kind: 'resource' as const, workspaceId: WORKSPACE_ID, resourceId });
const connection = (connectionId: string) => ({ kind: 'connection' as const, workspaceId: WORKSPACE_ID, connectionId });
const sorted = (items: readonly unknown[]) => [...items].map((item) => JSON.stringify(item)).sort();

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
      status TEXT NOT NULL, role TEXT NOT NULL, access_class TEXT DEFAULT 'member', last_seen_at TEXT, revision INTEGER NOT NULL DEFAULT 1, incarnation TEXT NOT NULL DEFAULT 'existing-member', PRIMARY KEY (workspace_id, user_id))`),
    ...[[OWNER, 'active'], [MEMBER, 'active'], [OUTSIDER, 'removed']].map(([userId, status]) => env.DB.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, status, role) VALUES (?, ?, ?, 'member')
       ON CONFLICT(workspace_id, user_id) DO UPDATE SET status = excluded.status`).bind(WORKSPACE_ID, userId, status)),
  ]);
  // Resource background work addresses the canonical workspace even when a
  // universe-only case uses its own named object for directory isolation.
  await env.WORKSPACE_DOS.getByName(workspaceDOName('global',WORKSPACE_ID)).initializeWorkspace(WORKSPACE_ID,'wnam');
});
afterEach(() => vi.restoreAllMocks());

/** The directories a WorkspaceDO projects from its owners, written directly: the universe reads only these. */
async function seededWorkspace(name = workspaceDOName('global', WORKSPACE_ID)) {
  const stub = env.WORKSPACE_DOS.getByName(name);
  await stub.initializeWorkspace(WORKSPACE_ID, 'wnam');
  const seeded = await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec('SELECT 1 FROM canvas_directory WHERE canvas_id = ?', OPEN_ROOM).toArray().length > 0);
  if (seeded) return stub;
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    const canvas = (id: string, visibility: string) => sql.exec(`INSERT INTO canvas_directory (canvas_id, workspace_id, title,
        created_by_user_id, created_at, updated_at, visibility, authority_generation) VALUES (?, ?, 'Canvas', ?, 1, 1, ?, 1)`,
    id, WORKSPACE_ID, OWNER, visibility);
    canvas(OPEN_ROOM, 'workspace');
    canvas(PRIVATE_ROOM, 'participants');
    // A participant who has left the Organization is not reached.
    sql.exec(`INSERT INTO canvas_participants (canvas_id, user_id, source, added_at) VALUES (?, ?, 'added', 1)`, PRIVATE_ROOM, OUTSIDER);
    sql.exec(`INSERT INTO automation_directory (automation_id, workspace_id, author_user_id, source_version, payload_hash, lifecycle, scope,
      title, description, next_run_at, projected_at) VALUES (?, ?, ?, 1, 'test', 'active', 'personal', 'Auto', '', NULL, 1)`,
    AUTOMATION, WORKSPACE_ID, MEMBER);
    sql.exec(`INSERT INTO authorization_inventories (parent_id, substream_id, revision, validated_at) VALUES (?, ?, 1, 1), (?, ?, 1, 1)`,
      PRIVATE_ROOM, CHILD, AUTOMATION, RUN);
    const connect = (id: string, scope: string, owner: string | null) => sql.exec(`INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, display_name, created_at, updated_at, model_plugin_id)
      VALUES (?, ?, 'google', ?, ?, 'Drive', '2026-09-10', '2026-09-10', ?)`, id, WORKSPACE_ID, scope, owner, `plugin-${id}`);
    connect(WORKSPACE_CONNECTION, 'workspace', null);
    connect(PERSONAL_CONNECTION, 'personal', OWNER);
    const file = (id: string, provider: string, connectionId: string | null, uploader: string | null) => sql.exec(`INSERT INTO resources
      (id, workspace_id, resource_type, provider, title, metadata_json, created_at, updated_at, connection_id, uploaded_by_user_id)
      VALUES (?, ?, 'file', ?, 'File', '{}', '2026-09-10', '2026-09-10', ?, ?)`, id, WORKSPACE_ID, provider, connectionId, uploader);
    file(SYNCED_FILE, 'google_drive', WORKSPACE_CONNECTION, null);
    file(UPLOAD, 'avalon_upload', null, MEMBER);
  });
  await stub.applyAuthorizationLocations({ workspaceId: WORKSPACE_ID, parentId: OPEN_ROOM, substreamId: '0', parentKind: 'canvas',
    revision: 1, validatedAt: 1, resourceIds: [UPLOAD, SYNCED_FILE] });
  return stub;
}

describe('search projection universe', () => {
  it('reaches every member for an open Canvas, its creator and participants for a private one, and nobody for an unknown parent', async () => {
    const stub = await seededWorkspace('search-universe-parents');
    const open = await stub.enumerateSearchAuthorization({ workspaceId: WORKSPACE_ID, target: { kind: 'parent', id: OPEN_ROOM } });
    expect(sorted(open.map((pair) => pair.subject.userId))).toEqual(sorted([OWNER, MEMBER]));
    // The main feed, plus the located upload; the synced file is admitted by its connection instead.
    expect(sorted(open[0]!.resources)).toEqual(sorted([conversation(OPEN_ROOM, '0'), resource(UPLOAD)]));
    const closed = await stub.enumerateSearchAuthorization({ workspaceId: WORKSPACE_ID, target: { kind: 'parent', id: PRIVATE_ROOM } });
    expect(closed.map((pair) => pair.subject.userId)).toEqual([OWNER]);
    expect(sorted(closed[0]!.resources)).toEqual(sorted([conversation(PRIVATE_ROOM, '0'), conversation(PRIVATE_ROOM, CHILD)]));
    // A personal Sidekick reaches its author.
    const automation = await stub.enumerateSearchAuthorization({ workspaceId: WORKSPACE_ID, target: { kind: 'parent', id: AUTOMATION } });
    expect(automation.map((pair) => pair.subject.userId)).toEqual([MEMBER]);
    expect(automation[0]!.resources).toEqual([conversation(AUTOMATION, RUN)]);
    expect(await stub.enumerateSearchAuthorization({ workspaceId: WORKSPACE_ID, target: { kind: 'parent', id: crypto.randomUUID() } })).toEqual([]);
  });

  it('reaches every member for a connection, the located readers and owner for an upload, and nothing for a synced file', async () => {
    const stub = await seededWorkspace('search-universe-resources');
    const synced = await stub.enumerateSearchAuthorization({ workspaceId: WORKSPACE_ID, target: { kind: 'connection', id: WORKSPACE_CONNECTION } });
    expect(sorted(synced.map((pair) => pair.subject.userId))).toEqual(sorted([OWNER, MEMBER]));
    expect(synced[0]!.resources).toEqual([connection(WORKSPACE_CONNECTION)]);
    expect(await stub.enumerateSearchAuthorization({ workspaceId: WORKSPACE_ID, target: { kind: 'resource', id: SYNCED_FILE } })).toEqual([]);
    const note = await stub.enumerateSearchAuthorization({ workspaceId: WORKSPACE_ID, target: { kind: 'resource', id: NOTE } });
    expect(note).toEqual([]);
    const upload = await stub.enumerateSearchAuthorization({ workspaceId: WORKSPACE_ID, target: { kind: 'resource', id: UPLOAD } });
    expect(sorted(upload.map((pair) => pair.subject.userId))).toEqual(sorted([OWNER, MEMBER]));
    expect(upload[0]!.resources).toEqual([resource(UPLOAD)]);
  });

  it('reaches everything one member could read, skipping a Canvas they cannot open', async () => {
    const stub = await seededWorkspace('search-universe-member');
    const [member, ...rest] = await stub.enumerateSearchAuthorization({ workspaceId: WORKSPACE_ID, target: { kind: 'member', id: MEMBER } });
    expect(rest).toEqual([]);
    expect(member!.subject.userId).toBe(MEMBER);
    expect(sorted(member!.resources)).toEqual(sorted([conversation(OPEN_ROOM, '0'), resource(UPLOAD), conversation(AUTOMATION, RUN),
      connection(WORKSPACE_CONNECTION), connection(PERSONAL_CONNECTION)]));
    expect(await stub.enumerateSearchAuthorization({ workspaceId: WORKSPACE_ID, target: { kind: 'member', id: OUTSIDER } })).toEqual([]);
  });

  it('registers what a target reaches before reloading owners, so a first search finds a decision', async () => {
    const stub = await seededWorkspace();
    await pushSearchAuthorization(env, { type: 'search_authorization_push_v1', region: 'global', workspaceId: WORKSPACE_ID,
      target: { kind: 'connection', id: WORKSPACE_CONNECTION } });
    const decisions = await stub.readSearchAuthorizationSnapshots({ subject: subject(MEMBER), resources: [connection(WORKSPACE_CONNECTION)] });
    expect(decisions[0]).toMatchObject({ decision: { status: 'allowed' } });
    expect(await stub.listSearchAuthorizationSnapshots({ workspaceId: WORKSPACE_ID, target: { kind: 'connection', id: WORKSPACE_CONNECTION } }))
      .toHaveLength(2);
  });

  it('records a membership change for the member it names', async () => {
    const stub = await seededWorkspace('search-universe-membership');
    await runInDurableObject(stub, async (instance, state) => {
      await instance.publishSync(['member_directory'], WORKSPACE_ID, 'wnam', { memberUserIds: [MEMBER] });
      expect(state.storage.sql.exec("SELECT target_id FROM search_authorization_push WHERE kind = 'member'").toArray())
        .toEqual([{ target_id: MEMBER }]);
    });
  });
});

describe('connection-level canonical authorization', () => {
  it('decides a connection once by its scope, owner and status', async () => {
    const stub = await seededWorkspace();
    const service = new AuthorizationService(env);
    const resources: AuthorizationResource[] = [connection(WORKSPACE_CONNECTION), connection(PERSONAL_CONNECTION), connection(crypto.randomUUID())];
    expect(await service.checkMany(subject(MEMBER), resources)).toMatchObject([
      { status: 'allowed' }, { status: 'denied', reason: 'connection_not_accessible' }, { status: 'not_found' }]);
    expect(await service.checkMany(subject(OWNER), [connection(PERSONAL_CONNECTION)])).toMatchObject([{ status: 'allowed' }]);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE connector_connections SET status = 'disabled' WHERE id = ?", WORKSPACE_CONNECTION);
    });
    expect(await service.checkMany(subject(MEMBER), [connection(WORKSPACE_CONNECTION)])).toMatchObject([{ status: 'denied' }]);
    expect(await service.checkMany(subject(OUTSIDER), [connection(WORKSPACE_CONNECTION)]))
      .toMatchObject([{ status: 'denied', reason: 'workspace_membership_required' }]);
  });
});
