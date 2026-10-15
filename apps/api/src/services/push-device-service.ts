import type { RegisterPushDeviceRequest } from "@rally/contracts/push-notifications";
import type { AuthContext, Env } from "../env";
import { workspaceRegionalDatabase } from "./workspace-runtime-database";

export interface PushDevice {
  id: string; token: string; topic: string; apns_environment: string; last_seen_at: string;
  transport: "apns" | "webpush"; web_push_p256dh: string | null; web_push_auth: string | null;
}
export async function registerPushDevice(env: Env, auth: AuthContext, installationId: string, input: RegisterPushDeviceRequest): Promise<void> {
  const db = workspaceRegionalDatabase(env);
  const now = new Date().toISOString();
  // An APNs token is hex, compared case-insensitively; a Web Push endpoint is a URL.
  const token = input.transport === "apns" ? input.token.toLowerCase() : input.endpoint;
  const apnsEnvironment = input.transport === "apns" ? input.apnsEnvironment : "none";
  const topic = input.transport === "apns" ? input.topic : "web";
  const keys = input.transport === "webpush" ? input.keys : null;
  await db.batch([
    db.prepare(`UPDATE user_push_devices SET disabled_at = ?, disabled_reason = 'token_reassigned'
      WHERE token = ? AND user_id <> ?`).bind(now, token, auth.userId),
    db.prepare(`INSERT INTO user_push_devices
      (id, user_id, installation_id, platform, transport, topic, apns_environment, token, app_version, last_seen_at,
       web_push_p256dh, web_push_auth)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, installation_id, transport) DO UPDATE SET
      token = excluded.token, topic = excluded.topic, apns_environment = excluded.apns_environment,
      app_version = excluded.app_version, last_seen_at = excluded.last_seen_at,
      web_push_p256dh = excluded.web_push_p256dh, web_push_auth = excluded.web_push_auth,
      disabled_at = NULL, disabled_reason = NULL`)
      .bind(crypto.randomUUID(), auth.userId, installationId, input.platform, input.transport,
        topic, apnsEnvironment, token, input.appVersion, now, keys?.p256dh ?? null, keys?.auth ?? null),
    db.prepare(`INSERT OR IGNORE INTO user_push_device_sessions (device_id, session_id)
      SELECT id, ? FROM user_push_devices WHERE user_id = ? AND installation_id = ? AND transport = ?`)
      .bind(auth.sessionId, auth.userId, installationId, input.transport),
  ]);
}
export async function deletePushDevice(env: Env, userId: string, installationId: string): Promise<void> {
  await workspaceRegionalDatabase(env).prepare(`DELETE FROM user_push_devices WHERE user_id = ? AND installation_id = ?`)
    .bind(userId, installationId).run();
}
export async function livePushDevices(env: Env, userId: string): Promise<PushDevice[]> {
  const rows = await workspaceRegionalDatabase(env).prepare(`SELECT d.id, d.token, d.topic, d.apns_environment, d.last_seen_at,
      d.transport, d.web_push_p256dh, d.web_push_auth
    FROM user_push_devices d WHERE d.user_id = ? AND d.disabled_at IS NULL
      AND EXISTS (SELECT 1 FROM user_push_device_sessions ds JOIN sessions s ON s.id = ds.session_id
        WHERE ds.device_id = d.id AND s.revoked_at IS NULL AND s.expires_at > ?)`)
    .bind(userId, new Date().toISOString()).all<PushDevice>();
  return rows.results;
}
/**
 * The active members of a workspace, their access class, and whether each has
 * at least one live device: `livePushDevices`'s test, for a set of people in
 * one read. `userIds` null asks about every active member.
 */
export async function activeMembersForActivity(
  env: Env,
  workspaceId: string,
  userIds: readonly string[] | null,
): Promise<Array<{ userId: string; accessClass: "member" | "guest"; hasDevice: boolean }>> {
  if (userIds !== null && userIds.length === 0) return [];
  const rows = await workspaceRegionalDatabase(env).prepare(`SELECT m.user_id AS userId, m.access_class AS accessClass,
      EXISTS (SELECT 1 FROM user_push_devices d
        JOIN user_push_device_sessions ds ON ds.device_id = d.id
        JOIN sessions s ON s.id = ds.session_id
        WHERE d.user_id = m.user_id AND d.disabled_at IS NULL AND s.revoked_at IS NULL AND s.expires_at > ?3) AS hasDevice
    FROM workspace_members m
    WHERE m.workspace_id = ?1 AND m.status = 'active'
      AND (?2 IS NULL OR m.user_id IN (SELECT value FROM json_each(?2)))`)
    .bind(workspaceId, userIds === null ? null : JSON.stringify(userIds), new Date().toISOString())
    .all<{ userId: string; accessClass: "member" | "guest"; hasDevice: number }>();
  return rows.results.map((row) => ({ userId: row.userId, accessClass: row.accessClass, hasDevice: row.hasDevice === 1 }));
}
