/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * An Organization's attention is its person's unseen Activity: the account
 * menu's number for an Organization in the background, and the badge a push
 * sets, so an alert that arrives while Rally is closed sets the count rather
 * than clearing it. `docs/activity.md` owns the count's rule.
 */
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { asUserId, asWorkspaceId, asWorkstreamId } from '@rally/contracts';
import migration from '../../../packages/db/migrations/0107_user_push_devices.sql?raw';
import webPushMigration from '../../../packages/db/migrations/0117_web_push_device_keys.sql?raw';
import { workspaceDOName } from '../src/durable-objects/names';
import { markAllActivitySeen } from '../src/durable-objects/workspace-activity';
import { splitSqlStatements } from '../src/lib/sql-statements';
import { deliverPush } from '../src/queues/push-delivery-consumer';
import { clearFlagTargetingAttributeCache } from '../src/services/flag-targeting-attributes';
import { registerPushDevice } from '../src/services/push-device-service';
import type { ApnsOutcome } from '../src/services/push/apns-transport';
import type { PushPayloads } from '../src/services/push/push-payload';
import { createTestEnv } from '../test/helpers/cloudflare-test';

const workspaceId = asWorkspaceId('00000000-0000-7000-8000-00000000e601');
const canvasId = asWorkstreamId('00000000-0000-7000-8000-00000000e602');
const hiddenCanvasId = '00000000-0000-7000-8000-00000000e603';
const sidekickId = '00000000-0000-7000-8000-00000000e604';
const userId = asUserId('00000000-0000-7000-8000-00000000e605');
const actorId = asUserId('00000000-0000-7000-8000-00000000e606');
const workspace = () => env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName('global', workspaceId)));
const flags = createTestEnv({ FLAGS: { getBooleanDetails: async () => ({ value: true, reason: 'TARGETING_MATCH' }) } }).FLAGS!;
const pushEnv = () => ({ ...env, FLAGS: flags });
const attention = () => workspace().attention({ workspaceId, userId, accessClass: 'member' });

/** One Activity row, as a producer writes it beside its intent. */
function row(sql: SqlStorage, itemId: string, kind: string, parentKind: 'canvas' | 'automation', parentId: string, createdAt: number, runId: string | null = null) {
  sql.exec(`INSERT INTO workspace_activity_items
    (item_id, workspace_id, recipient_user_id, kind, parent_kind, parent_id, substream_id, run_id, actor_kind, actor_id, attention_ordinal, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '0', ?, 'person', ?, NULL, ?)`, itemId, workspaceId, userId, kind, parentKind, parentId, runId, actorId, createdAt);
}

beforeEach(async () => {
  await reset(); clearFlagTargetingAttributeCache();
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, region TEXT, abandoned_at TEXT, placement_affinity TEXT NOT NULL DEFAULT 'wnam')`),
    env.DB.prepare(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT)`),
    env.DB.prepare(`CREATE TABLE workspace_members (access_class TEXT NOT NULL DEFAULT 'member', workspace_id TEXT, user_id TEXT, status TEXT, role TEXT, revision INTEGER NOT NULL DEFAULT 1, incarnation TEXT NOT NULL DEFAULT 'existing-member')`),
    env.DB.prepare(`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, revoked_at TEXT, expires_at TEXT, impersonator_user_id TEXT)`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, region, abandoned_at) VALUES (?, 'Juno Labs', 'global', NULL)`).bind(workspaceId),
    env.DB.prepare(`INSERT INTO users VALUES (?, 'robin@example.test', 'Robin')`).bind(userId),
    env.DB.prepare(`INSERT INTO workspace_members (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'member')`).bind(workspaceId, userId),
    env.DB.prepare(`INSERT INTO sessions VALUES ('session', ?, NULL, '2099-01-01', NULL)`).bind(userId),
    ...[migration, webPushMigration].flatMap(splitSqlStatements).map((sql) => env.DB.prepare(sql)),
  ]);
  await workspace().initializeWorkspace(workspaceId, 'wnam');
  await runInDurableObject(workspace(), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`INSERT INTO workspace_member_status (user_id, relationship_json, removed_incarnation, active, sequence, updated_at)
      VALUES (?, ?, NULL, 1, 1, 0)`, userId, JSON.stringify({ workspaceId, userId, accessClass: 'member', role: 'member', status: 'active', incarnation: 'i1', revision: 1 }));
    sql.exec(`INSERT INTO canvas_directory (canvas_id, workspace_id, title, created_by_user_id, created_at, updated_at, visibility, authority_generation)
      VALUES (?, ?, 'Launch plan', ?, 0, 0, 'workspace', 1), (?, ?, 'Private', ?, 0, 0, 'creator', 1)`,
      canvasId, workspaceId, actorId, hiddenCanvasId, workspaceId, actorId);
  });
  await registerPushDevice(env, { userId, workspaceId, sessionId: 'session', region: 'global', role: 'member' }, 'aa', {
    platform: 'macos', transport: 'apns', topic: 'ai.rallywith.desktop', apnsEnvironment: 'production', token: 'aa'.repeat(32), appVersion: '1',
  });
});

it('counts the unseen Activity the person may open, its waiting runs apart, and nothing after Mark all seen', async () => {
  expect(await attention()).toEqual({ waitingForYou: 0, waitingReason: null, hasUnreadActivity: false, readerAttentionCount: 0 });
  await runInDurableObject(workspace(), (_instance, state) => row(state.storage.sql, 'mention:one', 'mention', 'canvas', canvasId, 10));
  expect(await attention()).toEqual({ waitingForYou: 0, waitingReason: 'unseen', hasUnreadActivity: true, readerAttentionCount: 1 });
  await runInDurableObject(workspace(), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`INSERT INTO automation_directory
        (automation_id, workspace_id, author_user_id, source_version, payload_hash, lifecycle, scope, owning_workstream_id, title, description, projected_at, authority_generation, region)
      VALUES (?, ?, ?, 1, 'hash', 'active', 'workspace', NULL, 'Deploy watcher', '', 1, 1, 'global')`, sidekickId, workspaceId, actorId);
    row(sql, 'needs_input:one', 'needs_input', 'automation', sidekickId, 11, 'run-1');
    // A row about a Canvas the person cannot open counts toward nothing, as the page lists it nowhere.
    row(sql, 'mention:hidden', 'mention', 'canvas', hiddenCanvasId, 12);
  });
  expect(await attention()).toEqual({ waitingForYou: 1, waitingReason: 'needs_input', hasUnreadActivity: true, readerAttentionCount: 2 });
  await runInDurableObject(workspace(), (_instance, state) => markAllActivitySeen(state.storage.sql, userId, 20));
  expect(await attention()).toEqual({ waitingForYou: 0, waitingReason: null, hasUnreadActivity: false, readerAttentionCount: 0 });
});

it("sets a push's badge to the count with its own row in it", async () => {
  await runInDurableObject(workspace(), (_instance, state) => {
    const sql = state.storage.sql;
    row(sql, 'mention:earlier', 'mention', 'canvas', canvasId, 5);
    const payload = { kind: 'access_granted', parentId: canvasId, parentTitle: 'Launch plan', requestId: 'r1', deciderName: 'Avery' };
    sql.exec(`INSERT INTO workstream_notification_intents
      (intent_id, workspace_id, workstream_id, recipient_user_id, source_message_id, source_generation,
       source_version, required_directory_version, notification_kind, payload_json, payload_hash, state, attempts, created_at, updated_at)
      VALUES ('access_granted:r1', ?, ?, ?, 'access_granted:r1', 1, 1, 1, 'access_granted', ?, 'hash', 'delivered', 0, ?, ?)`,
      workspaceId, canvasId, userId, JSON.stringify(payload), new Date().toISOString(), new Date().toISOString());
    row(sql, 'access_granted:r1', 'access_granted', 'canvas', canvasId, 6);
  });
  const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: 'sent' }));
  expect(await deliverPush(pushEnv(), { region: 'global', workspaceId, recipientUserId: userId, intentId: 'access_granted:r1' }, send)).toBe(true);
  const payload = (send.mock.calls[0] as unknown[])[2] as PushPayloads;
  const apns = JSON.parse(payload.apns) as { aps: { badge: number }; rally: { badge: number } };
  expect([apns.aps.badge, apns.rally.badge, (JSON.parse(payload.web) as { badge: number }).badge]).toEqual([2, 2, 2]);
});
