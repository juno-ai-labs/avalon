import { z } from "zod";
import type { Env } from "../../env";
import { APNS_PAYLOAD_BYTES } from "./push-payload";
import type { PushDevice } from "../push-device-service";

// Selected by the product owner, 2026-09-14: retain offline alerts for one day.
export const APNS_EXPIRATION_SECONDS = 24 * 60 * 60;
const CachedTokenSchema = z.object({ token: z.string(), iat: z.number() });
const ErrorSchema = z.object({ reason: z.string().optional(), timestamp: z.number().optional() });
export interface ApnsOutcome {
  outcome: "sent" | "skipped" | "unregistered" | "bad_token" | "rejected" | "provider_auth_failed" | "provider_token_throttled" | "transient";
  status?: number; reason?: string | undefined; timestamp?: number | undefined;
}
export function pushConfigured(env: Env): boolean {
  return Boolean(env.APNS_AUTH_KEY?.trim() && env.APNS_KEY_ID?.trim());
}
export function pushAvailable(env: Env): boolean {
  return pushConfigured(env) && (env.APP_ENV === "production" || env.APP_ENV === "staging");
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
export async function mintProviderToken(pem: string, kid: string, iat: number): Promise<string> {
  const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const body = `${encode({ alg: "ES256", kid })}.${encode({ iss: "7ZLT6A8W25", iat })}`;
  const raw = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(body));
  return `${body}.${base64url(new Uint8Array(signature))}`;
}
export async function sendApns(env: Env, device: PushDevice, payload: string, collapseId: string): Promise<ApnsOutcome> {
  if (!pushAvailable(env)) return { outcome: "skipped" };
  if (new TextEncoder().encode(payload).byteLength > APNS_PAYLOAD_BYTES) return { outcome: "rejected", reason: "payload_too_large" };
  const cacheKey = `apns-provider:${env.APNS_KEY_ID!}`;
  try {
    const now = Math.floor(Date.now() / 1000);
    const cached = CachedTokenSchema.safeParse(await env.INFERENCE_PRICING_CACHE.get(cacheKey, "json")).data;
    const token = cached && now - cached.iat < 50 * 60 ? cached.token : await mintProviderToken(env.APNS_AUTH_KEY!, env.APNS_KEY_ID!, now);
    if (token !== cached?.token) await env.INFERENCE_PRICING_CACHE.put(cacheKey, JSON.stringify({ token, iat: now }), { expirationTtl: 60 * 60 });
    const response = await fetch(`https://api.push.apple.com/3/device/${device.token}`, {
      method: "POST", headers: { authorization: `bearer ${token}`, "apns-topic": device.topic,
        "apns-push-type": "alert", "apns-priority": "10", "apns-id": crypto.randomUUID(),
        "apns-collapse-id": collapseId, "apns-expiration": String(now + APNS_EXPIRATION_SECONDS),
        "content-type": "application/json" }, body: payload,
    });
    const text = await response.text();
    if (response.status === 200) return { outcome: "sent", status: 200 };
    const details = ErrorSchema.safeParse(text ? JSON.parse(text) : {}).data ?? {};
    const result = { status: response.status, ...details };
    if (response.status === 410) return details.timestamp === undefined
      ? { ...result, outcome: "transient", reason: "missing_unregistered_timestamp" }
      : { ...result, outcome: "unregistered" };
    if (details.reason === "BadDeviceToken") return { ...result, outcome: "bad_token" };
    if (response.status === 403 || details.reason === "TooManyProviderTokenUpdates") {
      const throttled = details.reason === "TooManyProviderTokenUpdates";
      if (!throttled) await env.INFERENCE_PRICING_CACHE.delete(cacheKey);
      return { ...result, outcome: throttled ? "provider_token_throttled" : "provider_auth_failed" };
    }
    return { ...result, outcome: response.status === 429 || response.status >= 500 ? "transient" : "rejected" };
  } catch {
    return { outcome: "transient", reason: "request_failed" };
  }
}
