import { enqueuePushDelivery } from '../src/services/push-delivery-service';
import { processWorkstreamNotificationIntent } from '../src/services/conversation-effect-service';
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject, createMessageBatch, createExecutionContext, getQueueResult } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { asUserId, asWorkspaceId, asWorkstreamId } from '@rally/contracts';
import migration from '../../../packages/db/migrations/0107_user_push_devices.sql?raw';
import { workspaceDOName } from '../src/durable-objects/names';
import { deliverPush, consumePushDeliveryQueue } from '../src/queues/push-delivery-consumer';
import { splitSqlStatements } from '../src/lib/sql-statements';
import { registerPushDevice } from '../src/services/push-device-service';
import { clearFlagTargetingAttributeCache } from '../src/services/flag-targeting-attributes';
import { createTestEnv } from '../test/helpers/cloudflare-test';
import type { ApnsOutcome } from '../src/services/push/apns-transport';

// No runs or model calls: only the real workspace intent/directory read and D1 delivery writes.
const workspaceId = asWorkspaceId('00000000-0000-7000-8000-00000000f101');
const workstreamId = asWorkstreamId('00000000-0000-7000-8000-00000000f102');
const userId = asUserId('00000000-0000-7000-8000-00000000f103');
const actorId = asUserId('00000000-0000-7000-8000-00000000f104');
const workspace = () => env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName('global', workspaceId)));
const flags = createTestEnv({ FLAGS: { getBooleanDetails: async () => ({ value: true, reason: 'TARGETING_MATCH' }) } }).FLAGS!;
const pushEnv = () => ({ ...env, FLAGS: flags });
const message = (intentId = 'mention:one') => ({ workspaceId, recipientUserId: userId, region: 'global' as const, intentId });
async function addIntent(intentId: string) {
  await runInDurableObject(workspace(), (_instance, state) => {
    const sourceId = crypto.randomUUID();
    const payload = { kind: 'mention_notification', intentId, messageId: sourceId, recipientUserId: userId,
      authorUserId: actorId, authorNameSnapshot: 'Author', workstreamTitleSnapshot: 'Planning', messageText: 'Hello', occurredAt: '2026-09-14T00:00:00.000Z' };
    state.storage.sql.exec(`INSERT INTO workstream_notification_intents
      (intent_id, workspace_id, workstream_id, recipient_user_id, source_message_id, source_generation,
       source_version, required_directory_version, notification_kind, payload_json, payload_hash, state, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 1, 1, 'mention', ?, 'hash', 'pending', 0, ?, ?)`,
      intentId, workspaceId, workstreamId, userId, sourceId, JSON.stringify(payload), new Date().toISOString(), new Date().toISOString());
  });
}
beforeEach(async () => {
  await reset(); clearFlagTargetingAttributeCache();
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, region TEXT, abandoned_at TEXT)`),
    env.DB.prepare(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT)`),
    env.DB.prepare(`CREATE TABLE workspace_members (workspace_id TEXT, user_id TEXT, status TEXT, role TEXT)`),
    env.DB.prepare(`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, revoked_at TEXT, expires_at TEXT)`),
    env.DB.prepare(`INSERT INTO workspaces VALUES (?, 'Test', 'global', NULL)`).bind(workspaceId),
    env.DB.prepare(`INSERT INTO users VALUES (?, 'person@example.test', 'Person')`).bind(userId),
    env.DB.prepare(`INSERT INTO workspace_members VALUES (?, ?, 'active', 'member')`).bind(workspaceId, userId),
    env.DB.prepare(`INSERT INTO sessions VALUES ('session', ?, NULL, '2099-01-01')`).bind(userId),
    ...splitSqlStatements(migration).map(sql => env.DB.prepare(sql)),
  ]);
  await workspace().initializeWorkspace(workspaceId, 'wnam');
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO workspace_workstream_directory
      (workstream_id, authority_generation, waterline, source_event_id, payload_hash, title, description, preview,
       scope, exact_state, last_activity_at, origin_type, title_status, latest_attention_ordinal,
       unread_tracking_start_ordinal, source_created_at, source_updated_at, projected_at)
      VALUES (?, 1, 1, 'source', 'hash', 'Planning', '', '', 'personal', 'idle', 0, 'ad_hoc', 'settled', 0, 0, 0, 0, 0)`, workstreamId);
    state.storage.sql.exec(`INSERT INTO workspace_workstream_viewers
      (workstream_id, user_id, authority_generation, waterline, source_event_id, payload_hash, is_participant,
       unread_count, you_are_mentioned, listable, seen_attention_ordinal, manual_unread_generation, latest_mention_attention_ordinal, projected_at)
      VALUES (?, ?, 1, 1, 'viewer', 'hash', 1, 0, 0, 1, 0, 0, 0, 0)`, workstreamId, userId);
  });
  await addIntent('mention:one');
  for (const token of ['aa', 'bb']) await registerPushDevice(env, { userId, workspaceId, sessionId: 'session', region: 'global', role: 'member' }, token, {
    platform: 'macos', transport: 'apns', topic: 'ai.rallywith.desktop', apnsEnvironment: 'production', token: token.repeat(32), appVersion: '1',
  });
});
it('retries only unreached devices and does not confuse newer notifications with older receipts', async () => {
  const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: 'sent' }));
  send.mockResolvedValueOnce({ outcome: 'sent' }).mockResolvedValueOnce({ outcome: 'transient' });
  expect(await deliverPush(pushEnv(), message(), send)).toBe(false);
  await addIntent('mention:two');
  expect(await deliverPush(pushEnv(), message('mention:two'), send)).toBe(true);
  expect(await deliverPush(pushEnv(), message(), send)).toBe(true);
  expect(send).toHaveBeenCalledTimes(5);
  expect(await deliverPush(pushEnv(), message(), send)).toBe(true);
  expect(send).toHaveBeenCalledTimes(5);
});
it('rechecks access after queueing and defers a directory that is still catching up', async () => {
  const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: 'sent' }));
  await runInDurableObject(workspace(), (_instance, state) => { state.storage.sql.exec(`UPDATE workstream_notification_intents SET required_directory_version = 2`); });
  expect(await deliverPush(pushEnv(), message(), send)).toBe(false);
  await runInDurableObject(workspace(), (_instance, state) => { state.storage.sql.exec(`UPDATE workstream_notification_intents SET required_directory_version = 1`); });
  await env.DB.prepare(`UPDATE workspace_members SET status = 'removed'`).run();
  expect(await deliverPush(pushEnv(), message(), send)).toBe(true);
  expect(send).not.toHaveBeenCalled();
});
it('sets the APNs badge to unread and needs-input work streams in this workspace', async () => {
  const needsInputId = asWorkstreamId('00000000-0000-7000-8000-00000000f105');
  const archivedId = asWorkstreamId('00000000-0000-7000-8000-00000000f106');
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`UPDATE workspace_workstream_directory SET latest_attention_ordinal = 2`);
    state.storage.sql.exec(
      `INSERT INTO workspace_workstream_directory
       (workstream_id, authority_generation, waterline, source_event_id, payload_hash, title, description, preview,
        scope, exact_state, last_activity_at, origin_type, title_status, latest_attention_ordinal,
        unread_tracking_start_ordinal, source_created_at, source_updated_at, projected_at)
       VALUES (?, 1, 1, 'needs', 'hash-needs', 'Needs input', '', '', 'personal', 'needs_input', 0, 'ad_hoc', 'settled', 1, 0, 0, 0, 0)`,
      needsInputId,
    );
    state.storage.sql.exec(
      `INSERT INTO workspace_workstream_viewers
       (workstream_id, user_id, authority_generation, waterline, source_event_id, payload_hash, is_participant,
        unread_count, you_are_mentioned, listable, seen_attention_ordinal, manual_unread_generation, latest_mention_attention_ordinal, projected_at)
       VALUES (?, ?, 1, 1, 'needs-viewer', 'hash-needs', 1, 0, 0, 1, 1, 0, 0, 0)`,
      needsInputId, userId,
    );
    state.storage.sql.exec(
      `INSERT INTO workspace_workstream_directory
       (workstream_id, authority_generation, waterline, source_event_id, payload_hash, title, description, preview,
        scope, exact_state, last_activity_at, archived_at, origin_type, title_status, latest_attention_ordinal,
        unread_tracking_start_ordinal, source_created_at, source_updated_at, projected_at)
       VALUES (?, 1, 1, 'archived', 'hash-archived', 'Archived unread', '', '', 'personal', 'idle', 0, 1, 'ad_hoc', 'settled', 4, 0, 0, 0, 0)`,
      archivedId,
    );
    state.storage.sql.exec(
      `INSERT INTO workspace_workstream_viewers
       (workstream_id, user_id, authority_generation, waterline, source_event_id, payload_hash, is_participant,
        unread_count, you_are_mentioned, listable, seen_attention_ordinal, manual_unread_generation, latest_mention_attention_ordinal, projected_at)
       VALUES (?, ?, 1, 1, 'archived-viewer', 'hash-archived', 1, 4, 0, 1, 0, 0, 0, 0)`,
      archivedId, userId,
    );
  });
  const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: 'sent' }));
  expect(await deliverPush(pushEnv(), message(), send)).toBe(true);
  expect(send).toHaveBeenCalledTimes(2);
  for (const call of send.mock.calls) {
    expect(JSON.parse(String(call[2])).aps.badge).toBe(2);
  }
});
it('disables devices Apple reports unregistered', async () => {
  const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: 'unregistered', timestamp: Date.now() + 1000 }));
  expect(await deliverPush(pushEnv(), message(), send)).toBe(true);
  expect((await env.DB.prepare(`SELECT id FROM user_push_devices WHERE disabled_at IS NULL`).all()).results).toHaveLength(0);
});

it('keeps enqueued content readable after the producer settles its intent', async () => {
  // Local workerd cannot select a jurisdiction; all storage and RPC still use its real namespace.
  const producerEnv = { ...pushEnv(), APP_ENV: 'staging' as const, APNS_AUTH_KEY: 'configured', APNS_KEY_ID: 'configured',
    WORKSPACE_DOS: createTestEnv({ WORKSPACE_DOS: { jurisdiction: () => env.WORKSPACE_DOS } }).WORKSPACE_DOS,
  };
  expect(await processWorkstreamNotificationIntent(producerEnv, workspaceId, 'mention:one')).toBe('delivered');
  const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: 'sent' }));
  expect(await deliverPush(producerEnv, message(), send)).toBe(true);
  expect(send).toHaveBeenCalledTimes(2);
});

it('does not enqueue a transport disabled in the local environment', async () => {
  expect(await enqueuePushDelivery({ ...pushEnv(), APP_ENV: 'development', APNS_AUTH_KEY: 'configured', APNS_KEY_ID: 'configured' }, message())).toBe(false);
});
it('stops a batch at the first provider credential fault and retries its remaining messages', async () => {
  await addIntent('mention:two');
  const batch = createMessageBatch('avalon-global-push-deliveries', ['mention:one', 'mention:two'].map(id => ({ id, body: message(id), timestamp: new Date(), attempts: 1 })));
  const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: 'provider_auth_failed', reason: 'InvalidProviderToken' }));
  await consumePushDeliveryQueue(batch, pushEnv(), send);
  expect(send).toHaveBeenCalledOnce();
  const result = await getQueueResult(batch, createExecutionContext());
  expect(result.retryMessages).toEqual([{ msgId: 'mention:one' }, { msgId: 'mention:two' }]);
});
