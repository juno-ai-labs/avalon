import { describe, expect, it } from "vitest";
import { APNS_PAYLOAD_BYTES, renderPushPayload, pushCollapseId } from "../src/services/push/push-payload";
import { mintProviderToken } from "../src/services/push/apns-transport";
const data = { v: 1 as const, kind: 'mention' as const, region: 'global' as const, workspaceId: 'workspace', url: 'https://rallywith.ai/app/workstreams/example' };
describe('push payload', () => {
  it('fits multibyte previews into the complete APNs payload', () => {
    const payload = renderPushPayload({ title: 'Long title'.repeat(30), body: '😀'.repeat(2000), threadKey: 'thread', badge: 4, data });
    expect(new TextEncoder().encode(payload).length).toBeLessThanOrEqual(APNS_PAYLOAD_BYTES);
    expect(JSON.parse(payload).aps.alert.body).toMatch(/…$/);
    expect(JSON.parse(payload).aps.badge).toBe(4);
    const longTitle = renderPushPayload({ title: '😀'.repeat(2000), body: 'Hello', threadKey: 'thread', badge: 0, data });
    expect(new TextEncoder().encode(longTitle).length).toBeLessThanOrEqual(APNS_PAYLOAD_BYTES);
    expect(JSON.parse(longTitle).aps.badge).toBe(0);
  });
  it('gives existing non-UUID intent IDs stable, distinct collapse IDs', async () => {
    expect(await pushCollapseId('workspace', 'mention:message:person')).toMatch(/^[a-f0-9]{64}$/);
    expect(await pushCollapseId('workspace', 'a')).not.toBe(await pushCollapseId('workspace', 'b'));
  });
  it('signs an ES256 token that verifies with the public key', async () => {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
    const jwt = await mintProviderToken(pem, 'KEY', 1234);
    const parts = jwt.split('.');
    expect(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString())).toEqual({ iss: '7ZLT6A8W25', iat: 1234 });
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, Buffer.from(parts[2]!, 'base64url'), new TextEncoder().encode(parts.slice(0, 2).join('.')))).toBe(true);
  });
});
