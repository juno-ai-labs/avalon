import type { RegisterPushDeviceRequest } from "@rally/contracts/push-notifications";
import type { AuthContext, Env } from "../env";
import { workspaceRegionalDatabase } from "./workspace-runtime-database";

export interface PushDevice {
  id: string; token: string; topic: string; last_seen_at: string;
}
export async function registerPushDevice(env: Env, auth: AuthContext, installationId: string, input: RegisterPushDeviceRequest): Promise<void> {
  const db = workspaceRegionalDatabase(env);
  const now = new Date().toISOString();
  const token = input.token.toLowerCase();
  await db.batch([
    db.prepare(`UPDATE user_push_devices SET disabled_at = ?, disabled_reason = 'token_reassigned'
      WHERE token = ? AND user_id <> ?`).bind(now, token, auth.userId),
    db.prepare(`INSERT INTO user_push_devices
      (id, user_id, installation_id, platform, transport, topic, apns_environment, token, app_version, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, installation_id, transport) DO UPDATE SET
      token = excluded.token, topic = excluded.topic, app_version = excluded.app_version,
      last_seen_at = excluded.last_seen_at, disabled_at = NULL, disabled_reason = NULL`)
      .bind(crypto.randomUUID(), auth.userId, installationId, input.platform, input.transport,
        input.topic, input.apnsEnvironment, token, input.appVersion, now),
    db.prepare(`INSERT OR IGNORE INTO user_push_device_sessions (device_id, session_id)
      SELECT id, ? FROM user_push_devices WHERE user_id = ? AND installation_id = ? AND transport = 'apns'`)
      .bind(auth.sessionId, auth.userId, installationId),
  ]);
}
export async function deletePushDevice(env: Env, userId: string, installationId: string): Promise<void> {
  await workspaceRegionalDatabase(env).prepare(`DELETE FROM user_push_devices WHERE user_id = ? AND installation_id = ?`)
    .bind(userId, installationId).run();
}
export async function livePushDevices(env: Env, userId: string): Promise<PushDevice[]> {
  const rows = await workspaceRegionalDatabase(env).prepare(`SELECT d.id, d.token, d.topic, d.last_seen_at
    FROM user_push_devices d WHERE d.user_id = ? AND d.disabled_at IS NULL
      AND EXISTS (SELECT 1 FROM user_push_device_sessions ds JOIN sessions s ON s.id = ds.session_id
        WHERE ds.device_id = d.id AND s.revoked_at IS NULL AND s.expires_at > ?)`)
    .bind(userId, new Date().toISOString()).all<PushDevice>();
  return rows.results;
}
