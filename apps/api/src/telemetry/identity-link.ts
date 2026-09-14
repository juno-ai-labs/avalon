import type { Region } from "@rally/contracts/regions";
import { newId } from '@rally/db';
import type { LinkAnonymousTelemetryResponse } from '@rally/contracts/telemetry';
import type { Env, IdentityAuthContext } from '../env';
import { TelemetryBootstrapService } from './bootstrap';

export async function linkAnonymousTelemetry(
  env: Env,
  auth: Pick<IdentityAuthContext, 'userId' | 'workspaceId' | 'region'>,
  capability: string,
): Promise<LinkAnonymousTelemetryResponse> {
  if (auth.region !== env.AVALON_REGION) throw new Error('telemetry_link_route_mismatch');
  const localVerifier = env.AVALON_REGION === 'global' ? new TelemetryBootstrapService(env) : null;
  let claims: { route: Region; anonymousEpochId: string; closed: boolean };
  if (localVerifier) {
    claims = await localVerifier.authorizeLink(capability, 'global');
  } else {
    if (!env.GLOBAL_TELEMETRY_CONTROL) throw new Error('telemetry_control_unavailable');
    claims = await env.GLOBAL_TELEMETRY_CONTROL.authorizeJourneyLink({
      capability,
      expectedRoute: 'global',
    });
  }
  const user = await env.DB.prepare(
    `SELECT analytics_person_id, product_analytics_enabled, email, name
     FROM users WHERE id = ?`,
  ).bind(auth.userId).first<{
    analytics_person_id: string | null;
    product_analytics_enabled: number;
    email: string;
    name: string;
  }>();
  if (!user) throw new Error('telemetry_link_user_missing');
  const candidate = newId();
  await env.DB.prepare(
    'UPDATE users SET analytics_person_id = COALESCE(analytics_person_id, ?) WHERE id = ?',
  ).bind(candidate, auth.userId).run();
  const resolved = await env.DB.prepare(
    'SELECT analytics_person_id FROM users WHERE id = ?',
  ).bind(auth.userId).first<{ analytics_person_id: string | null }>();
  if (!resolved?.analytics_person_id) throw new Error('telemetry_link_user_missing');
  const existing = await env.DB.prepare(
    'SELECT analytics_person_id, route FROM telemetry_identity_links WHERE anonymous_epoch_id = ?',
  ).bind(claims.anonymousEpochId).first<{ analytics_person_id: string; route: Region }>();
  if (existing) {
    if (existing.analytics_person_id !== resolved.analytics_person_id || existing.route !== env.AVALON_REGION) {
      throw new Error('telemetry_link_conflict');
    }
    await closeJourney(env, localVerifier, capability);
    return { result: 'duplicate' };
  }
  if (claims.closed) throw new Error('telemetry_journey_closed');
  if (user.product_analytics_enabled !== 1) {
    await closeJourney(env, localVerifier, capability);
    return { result: 'suppressed' };
  }

  const now = new Date();
  const deleteAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1_000).toISOString();
  const statements = [env.DB.prepare(
    `INSERT INTO telemetry_identity_links
      (anonymous_epoch_id, analytics_person_id, route, linked_at, delete_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    claims.anonymousEpochId,
    resolved.analytics_person_id,
    env.AVALON_REGION,
    now.toISOString(),
    deleteAt,
  )];
  statements.push(env.DB.prepare(
      `INSERT INTO telemetry_profile_jobs
        (id, subject_user_id, workspace_id, job_kind, destination_analytics_id,
         anonymous_epoch_id, properties_json, version, state, created_at, delete_at)
       VALUES (?, ?, NULL, 'epoch_transition', ?, ?, ?, 1, 'pending', ?, ?)`,
    ).bind(
      newId(now.getTime()),
      auth.userId,
      resolved.analytics_person_id,
      claims.anonymousEpochId,
      JSON.stringify({ email: user.email, name: user.name }),
      now.toISOString(),
      deleteAt,
    ));
  await env.DB.batch(statements);
  await closeJourney(env, localVerifier, capability);
  return { result: 'linked' };
}

async function closeJourney(
  env: Env,
  localVerifier: TelemetryBootstrapService | null,
  capability: string,
): Promise<void> {
  if (localVerifier) {
    await localVerifier.closeJourney(capability, 'global');
    return;
  }
  if (!env.GLOBAL_TELEMETRY_CONTROL) throw new Error('telemetry_control_unavailable');
  await env.GLOBAL_TELEMETRY_CONTROL.closeJourney({ capability, expectedRoute: 'global' });
}
