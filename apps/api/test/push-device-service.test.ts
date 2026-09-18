import { afterEach, describe, expect, it } from "vitest";
import { asUserId, asWorkspaceId } from "@rally/contracts";
import { APNS_TOPICS } from "@rally/contracts/push-notifications";
import { registerPushDevice, deletePushDevice, livePushDevices } from "../src/services/push-device-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import type { DatabaseSync } from "node:sqlite";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = migratedSqliteDatabase(); databases.push(db);
  const userId = asUserId(crypto.randomUUID());
  db.prepare(`INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES (?, ?, ?, 'Person', ?, ?)`)
    .run(userId, userId, `${userId}@example.test`, '2026-01-01', '2026-01-01');
  for (const session of ['a', 'b']) db.prepare(`INSERT INTO sessions (id, user_id, region, refresh_token_hash, expires_at, created_at) VALUES (?, ?, 'global', ?, '2099-01-01', '2026-01-01')`).run(session, userId, session);
  const env = createTestEnv({ DB: sqliteD1(db) });
  const auth = { userId, workspaceId: asWorkspaceId(crypto.randomUUID()), sessionId: 'a', region: 'global' as const, role: 'member' as const };
  const input = { platform: 'macos' as const, transport: 'apns' as const, topic: APNS_TOPICS.macos, apnsEnvironment: 'production' as const, token: 'ab'.repeat(32), appVersion: '1' };
  return { db, env, auth, input };
}
describe('push device registry', () => {
  it('updates one installation and only accepts sessions bound to that installation', async () => {
    const { db, env, auth, input } = fixture();
    await registerPushDevice(env, auth, 'first', input);
    await registerPushDevice(env, { ...auth, sessionId: 'b' }, 'second', { ...input, token: 'cd'.repeat(32) });
    await registerPushDevice(env, auth, 'first', { ...input, token: 'ef'.repeat(32) });
    expect(await livePushDevices(env, auth.userId)).toHaveLength(2);
    db.prepare(`UPDATE sessions SET revoked_at = '2026-01-02' WHERE id = 'a'`).run();
    expect((await livePushDevices(env, auth.userId)).map(d => d.token)).toEqual(['cd'.repeat(32)]);
    db.prepare(`UPDATE sessions SET expires_at = '2020-01-01' WHERE id = 'b'`).run();
    expect(await livePushDevices(env, auth.userId)).toEqual([]);
  });
  it('reassigns an Apple token to the newly signed-in account', async () => {
    const { db, env, auth, input } = fixture();
    await registerPushDevice(env, auth, 'first', input);
    const otherUser = asUserId(crypto.randomUUID());
    db.prepare(`INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES (?, ?, ?, 'Other', '2026-01-01', '2026-01-01')`)
      .run(otherUser, otherUser, `${otherUser}@example.test`);
    db.prepare(`INSERT INTO sessions (id, user_id, region, refresh_token_hash, expires_at, created_at) VALUES ('other', ?, 'global', 'other', '2099-01-01', '2026-01-01')`).run(otherUser);
    await registerPushDevice(env, { ...auth, userId: otherUser, sessionId: 'other' }, 'first', input);
    expect(await livePushDevices(env, auth.userId)).toEqual([]);
    expect(await livePushDevices(env, otherUser)).toHaveLength(1);
  });
  it('deletes a device and its session bindings', async () => {
    const { db, env, auth, input } = fixture();
    await registerPushDevice(env, auth, 'first', input);
    await deletePushDevice(env, auth.userId, 'first');
    expect(await livePushDevices(env, auth.userId)).toEqual([]);
    expect(db.prepare('SELECT * FROM user_push_device_sessions').all()).toEqual([]);
  });
  it('keeps an iPhone sandbox registration live and replaces its environment on re-register', async () => {
    const { env, auth } = fixture();
    const ios = {
      platform: 'ios' as const,
      transport: 'apns' as const,
      topic: APNS_TOPICS.ios,
      apnsEnvironment: 'sandbox' as const,
      token: '11'.repeat(32),
      appVersion: '1.0.0',
    };
    await registerPushDevice(env, auth, 'phone', ios);
    expect(await livePushDevices(env, auth.userId)).toEqual([
      expect.objectContaining({ token: '11'.repeat(32), topic: APNS_TOPICS.ios, apns_environment: 'sandbox' }),
    ]);
    await registerPushDevice(env, auth, 'phone', { ...ios, apnsEnvironment: 'production', token: '22'.repeat(32) });
    expect(await livePushDevices(env, auth.userId)).toEqual([
      expect.objectContaining({ token: '22'.repeat(32), apns_environment: 'production' }),
    ]);
  });
});
