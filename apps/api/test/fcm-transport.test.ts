import { afterEach, expect, it, vi } from 'vitest';
import { generateKeyPair, exportPKCS8, jwtVerify } from 'jose';
import { sendFcm } from '../src/services/push/fcm-transport';
import { renderFcmPayload } from '../src/services/push/push-payload';
import { createTestEnv } from './helpers/cloudflare-test';

const device = { id: 'android', transport: 'fcm' as const, token: 'DeviceToken-CaseSensitive', topic: 'android', apns_environment: 'none', last_seen_at: '2026-11-13', web_push_p256dh: null, web_push_auth: null };
const account = { project_id: 'rally-mobile', client_email: 'push@rally-mobile.iam.gserviceaccount.com', private_key: 'unused cached key' };
function cachedEnv() {
  return createTestEnv({ APP_ENV: 'staging', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(account), INFERENCE_PRICING_CACHE: { get: async () => ({ token: 'cached', expiresAt: Math.floor(Date.now() / 1000) + 3600 }), delete: vi.fn() } });
}
afterEach(() => vi.unstubAllGlobals());
it('authenticates with a signed Google service-account assertion and sends the original device token', async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  const private_key = await exportPKCS8(keys.privateKey);
  const env = createTestEnv({ APP_ENV: 'staging', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...account, private_key }),
    INFERENCE_PRICING_CACHE: { get: async () => null, put: vi.fn() } });
  const calls: { url: string; body: string }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    if (url === 'https://oauth2.googleapis.com/token') {
      const assertion = new URLSearchParams(String(init.body)).get('assertion')!;
      const verified = await jwtVerify(assertion, keys.publicKey, { issuer: account.client_email, audience: 'https://oauth2.googleapis.com/token' });
      expect(verified.payload.scope).toBe('https://www.googleapis.com/auth/firebase.messaging');
      return Response.json({ access_token: 'oauth-token', expires_in: 3600 });
    }
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer oauth-token');
    return Response.json({ name: 'projects/rally-mobile/messages/1' });
  });
  expect(await sendFcm(env, device, { title: 'Canvas changed' }, 'collapse')).toEqual({ outcome: 'sent', status: 200 });
  expect(calls[1]?.url).toBe('https://fcm.googleapis.com/v1/projects/rally-mobile/messages:send');
  expect(JSON.parse(calls[1]!.body)).toEqual({ message: { token: 'DeviceToken-CaseSensitive', data: { title: 'Canvas changed' }, android: { priority: 'HIGH', collapse_key: 'collapse', ttl: '86400s' } } });
});
it('retires only explicit unregistered tokens, and preserves devices for credential and payload errors', async () => {
  const response = vi.fn(); vi.stubGlobal('fetch', response);
  const env = cachedEnv();
  response.mockResolvedValueOnce(Response.json({ error: { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }, { status: 404 }));
  expect((await sendFcm(env, device, {}, 'x')).outcome).toBe('unregistered');
  for (const [status, outcome] of [[401, 'provider_auth_failed'], [403, 'provider_auth_failed'], [400, 'rejected'], [429, 'transient'], [503, 'transient']] as const) {
    response.mockResolvedValueOnce(Response.json({ error: {} }, { status }));
    expect((await sendFcm(env, device, {}, 'x')).outcome).toBe(outcome);
  }
});
it('fits Unicode notice text into FCM’s payload while preserving its canonical routing data', () => {
  const data = { v: 1 as const, kind: 'artifact_updated' as const, region: 'global' as const, workspaceId: 'workspace', url: 'https://rallywith.ai/app/example', badge: 3 };
  const result = renderFcmPayload({ title: '🌱'.repeat(2000), body: '🍎'.repeat(2000), data });
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(4096);
  expect(JSON.parse(result.body!)).toEqual({ rally: data });
  expect(result.channelId).toBe('default');
  expect(result.title).not.toContain('\uFFFD');
});

it('reports a malformed signing key as a provider configuration fault, without sending', async () => {
  const send = vi.fn(); vi.stubGlobal('fetch', send);
  const env = createTestEnv({ APP_ENV: 'staging', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(account), INFERENCE_PRICING_CACHE: { get: async () => null } });
  expect(await sendFcm(env, device, {}, 'x')).toEqual({ outcome: 'provider_auth_failed', reason: 'fcm_service_account_private_key_invalid' });
  expect(send).not.toHaveBeenCalled();
});
