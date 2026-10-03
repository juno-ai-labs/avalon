import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "./helpers/cloudflare-test";
import { encryptWebPushPayload, sendWebPush, vapidAuthorization } from "../src/services/push/web-push-transport";
import type { PushDevice } from "../src/services/push-device-service";

afterEach(() => { vi.unstubAllGlobals(); });

function bytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/=+$/u, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

// RFC 8291, Appendix A: the worked example, byte for byte.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

async function serverKeys(): Promise<CryptoKeyPair> {
  const point = bytes(RFC.asPublic);
  const x = base64url(point.slice(1, 33)), y = base64url(point.slice(33, 65));
  return {
    privateKey: await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y, d: RFC.asPrivate }, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", point, { name: "ECDH", namedCurve: "P-256" }, true, []),
  };
}

describe("Web Push transport", () => {
  it("encrypts exactly as RFC 8291's worked example does", async () => {
    const body = await encryptWebPushPayload(new TextEncoder().encode(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth },
      { salt: bytes(RFC.salt), serverKeys: await serverKeys() });
    expect(base64url(body)).toBe(RFC.body);
  });

  it("signs a VAPID token for the push service's origin with the configured key", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const publicKey = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer));
    const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const env = createTestEnv({ WEB_PUSH_VAPID_PUBLIC_KEY: publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: d!, WEB_PUSH_SUBJECT: "mailto:ops@example.test" });
    const header = await vapidAuthorization(env, "https://fcm.googleapis.com/fcm/send/abc", 1_000);
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/u.exec(header)!;
    expect(match[4]).toBe(publicKey);
    expect(JSON.parse(new TextDecoder().decode(bytes(match[2]!)))).toEqual({ aud: "https://fcm.googleapis.com", exp: 1_000 + 12 * 60 * 60, sub: "mailto:ops@example.test" });
    const verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, bytes(match[3]!), new TextEncoder().encode(`${match[1]}.${match[2]}`));
    expect(verified).toBe(true);
  });

  it("posts an encrypted record and reads a dropped subscription as unregistered", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]) as CryptoKeyPair;
    const env = createTestEnv({ APP_ENV: "production",
      WEB_PUSH_VAPID_PUBLIC_KEY: base64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer)),
      WEB_PUSH_VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey("jwk", pair.privateKey)).d!, WEB_PUSH_SUBJECT: "mailto:ops@example.test" });
    const device: PushDevice = { id: "browser", token: "https://fcm.googleapis.com/fcm/send/abc", topic: "web", apns_environment: "none",
      last_seen_at: "2026-10-03", transport: "webpush", web_push_p256dh: RFC.uaPublic, web_push_auth: RFC.auth };
    const request = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", request);
    expect(await sendWebPush(env, device, '{"title":"t"}', "a".repeat(64))).toMatchObject({ outcome: "sent" });
    const [url, init] = request.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(url).toBe(device.token);
    expect(headers["content-encoding"]).toBe("aes128gcm");
    expect(headers.topic).toBe("a".repeat(32));
    expect((init.body as Uint8Array).byteLength).toBeGreaterThan(86);
    request.mockResolvedValueOnce(new Response(null, { status: 410 }));
    expect(await sendWebPush(env, device, "{}", "c")).toMatchObject({ outcome: "unregistered" });
    request.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(await sendWebPush(env, device, "{}", "c")).toMatchObject({ outcome: "transient" });
  });
});
