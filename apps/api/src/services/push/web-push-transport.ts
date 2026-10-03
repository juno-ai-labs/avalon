import type { Env } from "../../env";
import type { PushDevice } from "../push-device-service";

/**
 * Web Push for browser members: a VAPID-signed request (RFC 8292) carrying a
 * payload encrypted to the browser's subscription keys with `aes128gcm`
 * (RFC 8188, RFC 8291). Only WebCrypto, no library: the Worker already signs
 * APNs tokens the same way.
 */

// The same one-day retention the product owner chose for APNs.
export const WEB_PUSH_TTL_SECONDS = 24 * 60 * 60;
// RFC 8291 sends one record; the push service accepts at least 4096 bytes of
// body, and the header and tag take 103 of them.
export const WEB_PUSH_PAYLOAD_BYTES = 3_900;

export interface WebPushOutcome {
  outcome: "sent" | "skipped" | "unregistered" | "rejected" | "provider_auth_failed" | "transient";
  status?: number;
  reason?: string;
}

export function webPushConfigured(env: Env): boolean {
  return Boolean(env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim() && env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim() && env.WEB_PUSH_SUBJECT?.trim());
}

/** The same deployed-environment gate APNs uses: local and test runs contact no push service. */
export function webPushAvailable(env: Env): boolean {
  return webPushConfigured(env) && (env.APP_ENV === "production" || env.APP_ENV === "staging");
}

function base64url(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/u, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function concat(...parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** RFC 8291 §3.4: one `aes128gcm` record encrypted to the subscription. */
export async function encryptWebPushPayload(
  payload: Uint8Array<ArrayBuffer>,
  subscription: { p256dh: string; auth: string },
  seeds: { salt?: Uint8Array<ArrayBuffer>; serverKeys?: CryptoKeyPair } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const clientPublic = fromBase64url(subscription.p256dh);
  const authSecret = fromBase64url(subscription.auth);
  const serverKeys = seeds.serverKeys
    ?? await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey) as ArrayBuffer);
  const clientKey = await crypto.subtle.importKey("raw", clientPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: clientKey }, serverKeys.privateKey, 256));
  const encoder = new TextEncoder();
  const keyInfo = concat(encoder.encode("WebPush: info\0"), clientPublic, serverPublic);
  const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32);
  const salt = seeds.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  // 0x02 marks the last (and only) record.
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(payload, new Uint8Array([2]))));
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([serverPublic.length]), serverPublic, ciphertext);
}

/** RFC 8292: a VAPID JWT for the push service's origin. */
export async function vapidAuthorization(env: Env, endpoint: string, now: number): Promise<string> {
  const publicKey = fromBase64url(env.WEB_PUSH_VAPID_PUBLIC_KEY!.trim());
  const jwk: JsonWebKey = {
    kty: "EC", crv: "P-256", ext: true,
    x: base64url(publicKey.slice(1, 33)), y: base64url(publicKey.slice(33, 65)),
    d: env.WEB_PUSH_VAPID_PRIVATE_KEY!.trim(),
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const body = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({
    aud: new URL(endpoint).origin, exp: now + 12 * 60 * 60, sub: env.WEB_PUSH_SUBJECT!.trim(),
  })}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(body)));
  return `vapid t=${body}.${base64url(signature)}, k=${env.WEB_PUSH_VAPID_PUBLIC_KEY!.trim()}`;
}

export async function sendWebPush(env: Env, device: PushDevice, payload: string, collapseId: string): Promise<WebPushOutcome> {
  if (!webPushAvailable(env)) return { outcome: "skipped" };
  if (!device.web_push_p256dh || !device.web_push_auth) return { outcome: "rejected", reason: "subscription_keys_missing" };
  const bytes = new TextEncoder().encode(payload);
  if (bytes.byteLength > WEB_PUSH_PAYLOAD_BYTES) return { outcome: "rejected", reason: "payload_too_large" };
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = await encryptWebPushPayload(bytes, { p256dh: device.web_push_p256dh, auth: device.web_push_auth });
  } catch {
    // Keys that are not a P-256 point never will be: retire the subscription
    // rather than retrying it until the queue gives up.
    return { outcome: "unregistered", reason: "subscription_keys_invalid" };
  }
  try {
    const response = await fetch(device.token, {
      method: "POST",
      headers: {
        authorization: await vapidAuthorization(env, device.token, Math.floor(Date.now() / 1000)),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(WEB_PUSH_TTL_SECONDS),
        urgency: "high",
        // A later alert for the same intent replaces this one; Topic is at most 32 URL-safe characters.
        topic: collapseId.slice(0, 32),
      },
      body,
    });
    if (response.status >= 200 && response.status < 300) return { outcome: "sent", status: response.status };
    // RFC 8030 §7.3: the subscription is gone; the browser will not receive again.
    if (response.status === 404 || response.status === 410) return { outcome: "unregistered", status: response.status, reason: "subscription_expired" };
    // RFC 8292 §4: the push service refused our VAPID credentials. That is the
    // deployment's fault, not the device's, and every browser is affected.
    if (response.status === 401 || response.status === 403) return { outcome: "provider_auth_failed", status: response.status, reason: `push_service_${response.status}` };
    return { outcome: response.status === 429 || response.status >= 500 ? "transient" : "rejected", status: response.status, reason: `push_service_${response.status}` };
  } catch {
    return { outcome: "transient", reason: "request_failed" };
  }
}
