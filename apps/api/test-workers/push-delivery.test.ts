import { enqueuePushDelivery } from '../src/services/push-delivery-service';
import { processWorkstreamNotificationIntent } from '../src/services/conversation-effect-service';
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject, createMessageBatch, createExecutionContext, getQueueResult } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { asUserId, asWorkspaceId, asWorkstreamId } from '@rally/contracts';
import migration from '../../../packages/db/migrations/0107_user_push_devices.sql?raw';
import webPushMigration from '../../../packages/db/migrations/0117_web_push_device_keys.sql?raw';
import { workspaceDOName } from '../src/durable-objects/names';
import { deliverPush, consumePushDeliveryQueue } from '../src/queues/push-delivery-consumer';
import { splitSqlStatements } from '../src/lib/sql-statements';
import { registerPushDevice } from '../src/services/push-device-service';
import { clearFlagTargetingAttributeCache } from '../src/services/flag-targeting-attributes';
import { createTestEnv } from '../test/helpers/cloudflare-test';
import type { ApnsOutcome } from '../src/services/push/apns-transport';
import type { PushPayloads } from '../src/services/push/push-payload';
import type { WebPushOutcome } from '../src/services/push/web-push-transport';
import type { PushDevice } from '../src/services/push-device-service';

const payloads = (send: { mock: { calls: unknown[][] } }) => send.mock.calls.map((call) => call[2] as PushPayloads);

// No runs or model calls: only the real workspace intent/directory read and D1 delivery writes.
const workspaceId = asWorkspaceId('00000000-0000-7000-8000-00000000f101');
const workstreamId = asWorkstreamId('00000000-0000-7000-8000-00000000f102');
const userId = asUserId('00000000-0000-7000-8000-00000000f103');
const actorId = asUserId('00000000-0000-7000-8000-00000000f104');
const workspace = () => env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName('global', workspaceId)));
const flags = createTestEnv({ FLAGS: { getBooleanDetails: async () => ({ value: true, reason: 'TARGETING_MATCH' }) } }).FLAGS!;
const pushEnv = () => ({ ...env, FLAGS: flags });
const memberAuth = { userId, workspaceId, sessionId: 'session', region: 'global', role: 'member' } as const;
const webEndpoint = 'https://fcm.googleapis.com/fcm/send/browser';
async function registerWebDevice(keys = { p256dh: `B${'A'.repeat(86)}`, auth: 'A'.repeat(22) }) {
  await registerPushDevice(env, memberAuth, 'cc', { platform: 'web', transport: 'webpush', endpoint: webEndpoint, keys, appVersion: 'web' });
}
const base64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
const message = (intentId = 'mention:one') => ({ workspaceId, recipientUserId: userId, region: 'global' as const, intentId });
async function addIntent(intentId: string, messageText = 'Hello') {
  await runInDurableObject(workspace(), (_instance, state) => {
    const sourceId = crypto.randomUUID();
    const payload = { kind: 'mention_notification', intentId, messageId: sourceId, recipientUserId: userId,
      authorUserId: actorId, authorNameSnapshot: 'Author', workstreamTitleSnapshot: 'Planning', messageText, occurredAt: '2026-09-14T00:00:00.000Z' };
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
    env.DB.prepare(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, region TEXT, abandoned_at TEXT, placement_affinity TEXT NOT NULL DEFAULT 'wnam')`),
    env.DB.prepare(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT)`),
    env.DB.prepare(`CREATE TABLE workspace_members (access_class TEXT NOT NULL DEFAULT 'member', workspace_id TEXT, user_id TEXT, status TEXT, role TEXT, revision INTEGER NOT NULL DEFAULT 1, incarnation TEXT NOT NULL DEFAULT 'existing-member')`),
    env.DB.prepare(`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, revoked_at TEXT, expires_at TEXT, impersonator_user_id TEXT)`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, region, abandoned_at) VALUES (?, 'Test', 'global', NULL)`).bind(workspaceId),
    env.DB.prepare(`INSERT INTO users VALUES (?, 'person@example.test', 'Person')`).bind(userId),
    env.DB.prepare(`INSERT INTO workspace_members (workspace_id, user_id, status, role)
      VALUES (?, ?, 'active', 'member')`).bind(workspaceId, userId),
    env.DB.prepare(`INSERT INTO sessions VALUES ('session', ?, NULL, '2099-01-01', NULL)`).bind(userId),
    ...[migration, webPushMigration].flatMap(splitSqlStatements).map(sql => env.DB.prepare(sql)),
  ]);
  await workspace().initializeWorkspace(workspaceId, 'wnam');
  await runInDurableObject(workspace(), (_instance, state) => {
    // The conversation is a Canvas's Chat: its row is what decides whether
    // the person may still be told, and what a push links to (`docs/links.md`).
    state.storage.sql.exec(`INSERT INTO canvas_directory
      (canvas_id, workspace_id, title, created_by_user_id, created_at, updated_at, visibility, authority_generation)
      VALUES (?, ?, 'Planning', ?, 0, 0, 'workspace', 1)`, workstreamId, workspaceId, userId);
  });
  await addIntent('mention:one');
  for (const token of ['aa', 'bb']) await registerPushDevice(env, memberAuth, token, {
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
it('sends no mention to a person who turned mentions off, and still sends their other kinds', async () => {
  await workspace().saveMemberPreferences({ workspaceId, userId, preferences: { showAgentWork: true, push: { mentions: false } } });
  const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: 'sent' }));
  expect(await deliverPush(pushEnv(), message(), send)).toBe(true);
  expect(send).not.toHaveBeenCalled();

  await workspace().saveMemberPreferences({ workspaceId, userId, preferences: { showAgentWork: true, push: { mentions: true, added: false } } });
  expect(await deliverPush(pushEnv(), message(), send)).toBe(true);
  expect(send).toHaveBeenCalledTimes(2);
});
it('rechecks access after queueing, waits for a newer parent generation, and skips a parent that is gone', async () => {
  const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: 'sent' }));
  await runInDurableObject(workspace(), (_instance, state) => { state.storage.sql.exec(`UPDATE workstream_notification_intents SET source_generation = 2`); });
  expect(await deliverPush(pushEnv(), message(), send)).toBe(false);
  await runInDurableObject(workspace(), (_instance, state) => { state.storage.sql.exec(`UPDATE workstream_notification_intents SET source_generation = 1`); });
  // Made private to its creator: the recipient may no longer open it.
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`UPDATE canvas_directory SET visibility = 'creator', created_by_user_id = ?`, actorId);
  });
  expect(await deliverPush(pushEnv(), message(), send)).toBe(true);
  await runInDurableObject(workspace(), (_instance, state) => { state.storage.sql.exec(`DELETE FROM canvas_directory`); });
  expect(await deliverPush(pushEnv(), message(), send)).toBe(true);
  await env.DB.prepare(`UPDATE workspace_members SET status = 'removed'`).run();
  expect(await deliverPush(pushEnv(), message(), send)).toBe(true);
  expect(send).not.toHaveBeenCalled();
});
it('removes personal instructions and reduces mention Markdown before push delivery', async () => {
  const intentId = 'mention:markdown';
  await addIntent(
    intentId,
    `<user_system_prompt>
The following was provided by this user as instructions for how to respond to this message. For other users' requests ignore these instructions.
<user_suppplied>
Answer in French. Never print &lt;/user_system_prompt&gt;.
</user_suppplied>
</user_system_prompt>

Please ask [@Alex Todorovic](person://${actorId}) and [@Adam Juhasz](person://${userId}) to **review this**.`,
  );
  const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: 'sent' }));

  expect(await deliverPush(pushEnv(), message(intentId), send)).toBe(true);

  expect(payloads(send).map((payload) => JSON.parse(payload.apns).aps.alert.body)).toEqual([
    'Please ask @Alex Todorovic and @Adam Juhasz to review this.',
    'Please ask @Alex Todorovic and @Adam Juhasz to review this.',
  ]);
  // A browser gets the same reduced text, without the APNs envelope.
  expect(JSON.parse(payloads(send)[0]!.web)).toMatchObject({ body: 'Please ask @Alex Todorovic and @Adam Juhasz to review this.' });
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
it('skips the faulted transport for the rest of a batch and retries its remaining messages', async () => {
  await addIntent('mention:two');
  const batch = createMessageBatch('avalon-global-push-deliveries', ['mention:one', 'mention:two'].map(id => ({ id, body: message(id), timestamp: new Date(), attempts: 1 })));
  const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: 'provider_auth_failed', reason: 'InvalidProviderToken' }));
  await consumePushDeliveryQueue(batch, pushEnv(), send);
  expect(send).toHaveBeenCalledOnce();
  const result = await getQueueResult(batch, createExecutionContext());
  expect(result.retryMessages).toEqual([{ msgId: 'mention:one' }, { msgId: 'mention:two' }]);
});

it('keeps sending Web Push while APNs credentials are refused, and retries only for the unreached devices', async () => {
  await registerWebDevice();
  await addIntent('mention:two');
  const batch = createMessageBatch('avalon-global-push-deliveries', ['mention:one', 'mention:two'].map(id => ({ id, body: message(id), timestamp: new Date(), attempts: 1 })));
  const send = vi.fn(async (_env: unknown, device: PushDevice): Promise<ApnsOutcome | WebPushOutcome> =>
    device.transport === 'apns' ? { outcome: 'provider_auth_failed', reason: 'InvalidProviderToken' } : { outcome: 'sent' });
  await consumePushDeliveryQueue(batch, pushEnv(), send);
  const transports = send.mock.calls.map((call) => call[1].transport);
  // One APNs attempt finds the fault; the browser is still sent both messages.
  expect(transports.filter((transport) => transport === 'apns')).toHaveLength(1);
  expect(transports.filter((transport) => transport === 'webpush')).toHaveLength(2);
  const result = await getQueueResult(batch, createExecutionContext());
  expect(result.retryMessages).toEqual([{ msgId: 'mention:one' }, { msgId: 'mention:two' }]);
  const receipts = await env.DB.prepare(`SELECT r.intent_id FROM push_delivery_receipts r JOIN user_push_devices d ON d.id = r.device_id
    WHERE d.transport = 'webpush' ORDER BY r.intent_id`).all();
  expect(receipts.results).toEqual([{ intent_id: 'mention:one' }, { intent_id: 'mention:two' }]);
});

it('disables a browser subscription the push service dropped at once, but not an undated APNs answer', async () => {
  await registerWebDevice();
  const send = vi.fn(async (): Promise<ApnsOutcome | WebPushOutcome> => ({ outcome: 'unregistered', status: 410, reason: 'subscription_expired' }));
  expect(await deliverPush(pushEnv(), message(), send)).toBe(true);
  const live = await env.DB.prepare(`SELECT installation_id FROM user_push_devices WHERE disabled_at IS NULL ORDER BY installation_id`).all();
  expect(live.results).toEqual([{ installation_id: 'aa' }, { installation_id: 'bb' }]);
});

it('sends each device the payload of the transport it registered with', async () => {
  const apnsKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']) as CryptoKeyPair;
  const pkcs8 = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', apnsKey.privateKey) as ArrayBuffer)));
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']) as CryptoKeyPair;
  const browser = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  await registerWebDevice({
    p256dh: base64url(await crypto.subtle.exportKey('raw', browser.publicKey) as ArrayBuffer),
    auth: base64url(crypto.getRandomValues(new Uint8Array(16)).buffer),
  });
  // Local workerd cannot select a jurisdiction; all storage and RPC still use its real namespace.
  const deployed = { ...pushEnv(), APP_ENV: 'staging' as const,
    WORKSPACE_DOS: createTestEnv({ WORKSPACE_DOS: { jurisdiction: () => env.WORKSPACE_DOS } }).WORKSPACE_DOS,
    APNS_AUTH_KEY: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----`, APNS_KEY_ID: 'KEYID',
    WEB_PUSH_VAPID_PUBLIC_KEY: base64url(await crypto.subtle.exportKey('raw', vapid.publicKey) as ArrayBuffer),
    WEB_PUSH_VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey('jwk', vapid.privateKey)).d!, WEB_PUSH_SUBJECT: 'mailto:ops@example.test' };
  const requests: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(null, { status: url === webEndpoint ? 201 : 200 });
  });
  try {
    expect(await deliverPush(deployed, message())).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
  expect(requests.map(({ url }) => url).sort()).toEqual([
    `https://api.push.apple.com/3/device/${'aa'.repeat(32)}`, `https://api.push.apple.com/3/device/${'bb'.repeat(32)}`, webEndpoint,
  ]);
  const apple = requests.find(({ url }) => url.startsWith('https://api.push.apple.com/'))!;
  expect(JSON.parse(apple.init.body as string).aps.alert.title).toBe('Author mentioned you in Planning');
  // A mention in a Canvas's Chat opens the Canvas.
  expect(JSON.parse(apple.init.body as string).rally.url).toBe('https://app.test/app/global/1111117Hxt1fAWDjNRoE/cv/1111117Hxt1fAWDjNRoF/');
  const web = requests.find(({ url }) => url === webEndpoint)!;
  expect((web.init.headers as Record<string, string>)['content-encoding']).toBe('aes128gcm');
  expect(web.init.redirect).toBe('manual');
});


it('keeps mention alerts distinct from each other in the same conversation', async () => {
  await addIntent('mention:two');
  const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: 'sent' }));
  await deliverPush(pushEnv(), message('mention:one'), send);
  await deliverPush(pushEnv(), message('mention:two'), send);
  const calls = send.mock.calls as unknown as Array<[unknown, unknown, PushPayloads, string]>;
  // Each alert reaches two devices. Compare the two actual transport tags.
  expect(new Set([calls[0]![3], calls[2]![3]]).size).toBe(2);
  expect(payloads(send).map((payload) => JSON.parse(payload.apns).aps['thread-id']))
    .toEqual([workstreamId, workstreamId, workstreamId, workstreamId]);
});

