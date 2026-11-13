import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import { zodDiagnosticCode } from '@rally/contracts/zod-diagnostics';
import type { Env } from '../../env';
import type { PushDevice } from '../push-device-service';
import type { ApnsOutcome } from './apns-transport';

const Account = z.object({ project_id: z.string().min(1), client_email: z.string().email(), private_key: z.string().min(1) });
const AccessToken = z.object({ access_token: z.string(), expires_in: z.number().positive() });
const CachedToken = z.object({ token: z.string(), expiresAt: z.number() });
const FcmError = z.object({ error: z.object({ details: z.array(z.object({ '@type': z.string(), errorCode: z.string().optional() })).optional() }) });

export function fcmAvailable(env: Env): boolean {
  return Boolean(env.FCM_SERVICE_ACCOUNT_JSON?.trim()) && (env.APP_ENV === 'production' || env.APP_ENV === 'staging');
}

/** FCM HTTP v1, using Google's documented service-account JWT OAuth flow. */
export async function sendFcm(env: Env, device: PushDevice, data: Record<string, string>, collapseId: string): Promise<ApnsOutcome> {
  if (!fcmAvailable(env)) return { outcome: 'skipped' };
  let account: z.infer<typeof Account>;
  try { account = Account.parse(JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON!)); }
  catch (error) { return { outcome: 'provider_auth_failed', reason: zodDiagnosticCode(error, 'fcm_service_account') ?? 'fcm_service_account_invalid_json' }; }
  try {
    // Key rotation must not reuse a token minted with the old credential.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.FCM_SERVICE_ACCOUNT_JSON!));
    const cacheKey = `fcm-provider:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    const now = Math.floor(Date.now() / 1000);
    const cached = CachedToken.safeParse(await env.INFERENCE_PRICING_CACHE.get(cacheKey, 'json')).data;
    let token = cached && cached.expiresAt > now ? cached.token : null;
    if (!token) {
      let privateKey;
      try { privateKey = await importPKCS8(account.private_key, 'RS256'); }
      catch { return { outcome: 'provider_auth_failed', reason: 'fcm_service_account_private_key_invalid' }; }
      const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
        .setProtectedHeader({ alg: 'RS256' }).setIssuer(account.client_email)
        .setAudience('https://oauth2.googleapis.com/token').setIssuedAt(now).setExpirationTime(now + 3600)
        .sign(privateKey);
      const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      });
      if (!response.ok) return { outcome: response.status === 429 || response.status >= 500 ? 'transient' : 'provider_auth_failed', reason: 'fcm_oauth_failed', status: response.status };
      const access = AccessToken.safeParse(await response.json());
      if (!access.success) return { outcome: 'transient', reason: zodDiagnosticCode(access.error, 'fcm_oauth_response')! };
      token = access.data.access_token;
      await env.INFERENCE_PRICING_CACHE.put(cacheKey, JSON.stringify({ token, expiresAt: now + access.data.expires_in }), { expirationTtl: access.data.expires_in });
    }
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      // Expo's Android receiver reads title/message/body from data, including when foregrounded.
      body: JSON.stringify({ message: { token: device.token, data, android: { priority: 'HIGH', collapse_key: collapseId, ttl: '86400s' } } }),
    });
    if (response.ok) return { outcome: 'sent', status: response.status };
    const details = FcmError.safeParse(await response.json()).data;
    const code = details?.error.details?.find((item) => item['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError')?.errorCode;
    if (code === 'UNREGISTERED') return { outcome: 'unregistered', reason: 'fcm_unregistered', status: response.status };
    if (response.status === 401 || response.status === 403) {
      await env.INFERENCE_PRICING_CACHE.delete(cacheKey);
      return { outcome: 'provider_auth_failed', reason: 'fcm_provider_auth_failed', status: response.status };
    }
    return { outcome: response.status === 429 || response.status >= 500 ? 'transient' : 'rejected', reason: 'fcm_send_failed', status: response.status };
  } catch { return { outcome: 'transient', reason: 'fcm_request_failed' }; }
}
