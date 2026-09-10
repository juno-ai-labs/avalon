/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { asSubstreamId, asUserId, asWorkspaceId } from '@rally/contracts';
import { createCloudflareTestBinding } from '../test/helpers/cloudflare-test';
import { workspaceDOName } from '../src/durable-objects/names';
import { flushSearchAuthorizationPush } from '../src/durable-objects/search-authorization-projection';
import { AuthorizationService } from '../src/services/authorization-service';
import { pushSearchAuthorization } from '../src/services/search-authorization';
import type { AuthorizationResource } from '../src/services/authorization-policy';

const WORKSPACE_ID = asWorkspaceId('00000000-0000-7000-8000-000000000c01');
const OWNER = '00000000-0000-7000-8000-000000000c02';
const MEMBER = '00000000-0000-7000-8000-000000000c03';
const OUTSIDER = '00000000-0000-7000-8000-000000000c04';
const OPEN_ROOM = '00000000-0000-7000-8000-000000000c11';
const PRIVATE_ROOM = '00000000-0000-7000-8000-000000000c12';
const ARCHIVED_ROOM = '00000000-0000-7000-8000-000000000c13';
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
      status TEXT NOT NULL, role TEXT NOT NULL, last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id))`),
    ...[[OWNER, 'active'], [MEMBER, 'active'], [OUTSIDER, 'removed']].map(([userId, status]) => env.DB.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, status, role) VALUES (?, ?, ?, 'member')
       ON CONFLICT(workspace_id, user_id) DO UPDATE SET status = excluded.status`).bind(WORKSPACE_ID, userId, status)),
  ]);
});
afterEach(() => vi.restoreAllMocks());

/** The directories a WorkspaceDO projects from its owners, written directly: the universe reads only these. */
async function seededWorkspace(name = workspaceDOName('global', WORKSPACE_ID)) {
  const stub = env.WORKSPACE_DOS.getByName(name);
  await stub.initializeWorkspace(WORKSPACE_ID, 'wnam');
  const seeded = await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec('SELECT 1 FROM workspace_workstream_directory WHERE workstream_id = ?', OPEN_ROOM).toArray().length > 0);
  if (seeded) return stub;
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    const room = (id: string, scope: string, archivedAt: number | null, n: number) => sql.exec(`INSERT INTO workspace_workstream_directory
      (workstream_id, authority_generation, waterline, source_event_id, payload_hash, title, description, preview, scope, exact_state,
       system_kind, last_activity_at, completed_at, archived_at, email_address, origin_type, origin_label, created_by_user_id,
       automation_subscription_id, automation_run_id, planned_for, title_status, latest_attention_ordinal, unread_tracking_start_ordinal,
       next_wakeup_due_at, next_wakeup_prompt, next_terminal_action_at, source_created_at, source_updated_at, projected_at)
      VALUES (?, 1, ?, ?, 'test', ?, '', '', ?, 'idle', NULL, ?, NULL, ?, NULL, 'ad_hoc', NULL, ?, NULL, NULL, NULL, 'settled', 0, 0, NULL, NULL, NULL, ?, ?, ?)`,
    id, n, `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`, `Room ${n}`, scope, n, archivedAt, OWNER, n, n, n);
    room(OPEN_ROOM, 'workspace', null, 1);
    room(PRIVATE_ROOM, 'personal', null, 2);
    room(ARCHIVED_ROOM, 'workspace', 5, 3);
    const viewer = (roomId: string, userId: string, participant: number, n: number) => sql.exec(`INSERT INTO workspace_workstream_viewers
      (workstream_id, user_id, authority_generation, waterline, source_event_id, payload_hash, is_participant, participant_added_at,
       unread_count, you_are_mentioned, unseen, listable, seen_attention_ordinal, manual_unread_from_ordinal, manual_unread_generation,
       latest_mention_attention_ordinal, projected_at) VALUES (?, ?, 1, 1, ?, 'test', ?, 1, 0, 0, 0, 1, 0, NULL, 0, 0, 1)`,
    roomId, userId, `00000000-0000-7000-8001-${String(n).padStart(12, '0')}`, participant);
    viewer(PRIVATE_ROOM, OWNER, 1, 1);
    viewer(PRIVATE_ROOM, MEMBER, 0, 2);
    viewer(PRIVATE_ROOM, OUTSIDER, 1, 3);
    sql.exec(`INSERT INTO automation_directory (automation_id, workspace_id, author_user_id, source_version, payload_hash, lifecycle, scope,
      owning_workstream_id, title, description, next_run_at, projected_at) VALUES (?, ?, ?, 1, 'test', 'active', 'workstream', ?, 'Auto', '', NULL, 1)`,
    AUTOMATION, WORKSPACE_ID, MEMBER, PRIVATE_ROOM);
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
    file(NOTE, 'avalon_note', null, OWNER);
  });
  await stub.applyAuthorizationLocations({ workspaceId: WORKSPACE_ID, parentId: OPEN_ROOM, substreamId: '0', parentKind: 'workstream',
    revision: 1, validatedAt: 1, resourceIds: [UPLOAD, SYNCED_FILE] });
  return stub;
}

describe('search projection universe', () => {
  it('reaches every member of an open room, only participants of a private one, and nobody for an unknown parent', async () => {
    const stub = await seededWorkspace('search-universe-parents');
    const open = await stub.enumerateSearchAuthorization({ workspaceId: WORKSPACE_ID, target: { kind: 'parent', id: OPEN_ROOM } });
    expect(sorted(open.map((pair) => pair.subject.userId))).toEqual(sorted([OWNER, MEMBER]));
    // The main feed, plus the located upload; the synced file is admitted by its connection instead.
    expect(sorted(open[0]!.resources)).toEqual(sorted([conversation(OPEN_ROOM, '0'), resource(UPLOAD)]));
    const closed = await stub.enumerateSearchAuthorization({ workspaceId: WORKSPACE_ID, target: { kind: 'parent', id: PRIVATE_ROOM } });
    expect(closed.map((pair) => pair.subject.userId)).toEqual([OWNER]);
    expect(sorted(closed[0]!.resources)).toEqual(sorted([conversation(PRIVATE_ROOM, '0'), conversation(PRIVATE_ROOM, CHILD)]));
    // A room-owned automation inherits the room's participants and adds its author.
    const automation = await stub.enumerateSearchAuthorization({ workspaceId: WORKSPACE_ID, target: { kind: 'parent', id: AUTOMATION } });
    expect(sorted(automation.map((pair) => pair.subject.userId))).toEqual(sorted([OWNER, MEMBER]));
    expect(automation[0]!.resources).toEqual([conversation(AUTOMATION, RUN)]);
    expect(await stub.enumerateSearchAuthorization({ workspaceId: WORKSPACE_ID, target: { kind: 'parent', id: crypto.randomUUID() } })).toEqual([]);
  });

  it('reaches every member for a connection or a note, the located readers and owner for an upload, and nothing for a synced file', async () => {
    const stub = await seededWorkspace('search-universe-resources');
    const synced = await stub.enumerateSearchAuthorization({ workspaceId: WORKSPACE_ID, target: { kind: 'connection', id: WORKSPACE_CONNECTION } });
    expect(sorted(synced.map((pair) => pair.subject.userId))).toEqual(sorted([OWNER, MEMBER]));
    expect(synced[0]!.resources).toEqual([connection(WORKSPACE_CONNECTION)]);
    expect(await stub.enumerateSearchAuthorization({ workspaceId: WORKSPACE_ID, target: { kind: 'resource', id: SYNCED_FILE } })).toEqual([]);
    const note = await stub.enumerateSearchAuthorization({ workspaceId: WORKSPACE_ID, target: { kind: 'resource', id: NOTE } });
    expect(sorted(note.map((pair) => pair.subject.userId))).toEqual(sorted([OWNER, MEMBER]));
    const upload = await stub.enumerateSearchAuthorization({ workspaceId: WORKSPACE_ID, target: { kind: 'resource', id: UPLOAD } });
    expect(sorted(upload.map((pair) => pair.subject.userId))).toEqual(sorted([OWNER, MEMBER]));
    expect(upload[0]!.resources).toEqual([resource(UPLOAD)]);
  });

  it('reaches everything one member could read, skipping archived rooms and rooms they are not in', async () => {
    const stub = await seededWorkspace('search-universe-member');
    const [member, ...rest] = await stub.enumerateSearchAuthorization({ workspaceId: WORKSPACE_ID, target: { kind: 'member', id: MEMBER } });
    expect(rest).toEqual([]);
    expect(member!.subject.userId).toBe(MEMBER);
    expect(sorted(member!.resources)).toEqual(sorted([conversation(OPEN_ROOM, '0'), resource(UPLOAD), conversation(AUTOMATION, RUN),
      connection(WORKSPACE_CONNECTION), connection(PERSONAL_CONNECTION), resource(NOTE)]));
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

  it('projects a membership change for the member it names', async () => {
    const stub = await seededWorkspace('search-universe-membership');
    await runInDurableObject(stub, async (instance, state) => {
      await instance.publishSync(['member_directory'], WORKSPACE_ID, 'wnam', { memberUserIds: [MEMBER] });
      expect(state.storage.sql.exec("SELECT target_id FROM search_authorization_push WHERE kind = 'member'").toArray())
        .toEqual([{ target_id: MEMBER }]);
      const jobs: unknown[] = [];
      const queue = createCloudflareTestBinding<Queue>({ sendBatch: async (messages) => { jobs.push(...Array.from(messages, (message) => message.body)); } });
      await flushSearchAuthorizationPush(state.storage.sql, { ...env, ACTIVITY_QUEUE: queue }, WORKSPACE_ID);
      expect(jobs).toContainEqual(expect.objectContaining({ target: { kind: 'member', id: MEMBER } }));
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
