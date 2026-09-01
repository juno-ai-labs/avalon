import { newId } from "@rally/db";
import type { TelemetryBatch, TelemetryEnvelope } from "@rally/contracts/telemetry";
import type { Env, IdentityAuthContext } from "../env";
import { ApiError } from "../lib/api-error";
import { TelemetryCollector, type TelemetryAcceptanceResult } from "./collector";

export async function ensurePersonAnalyticsId(env: Env, userId: string): Promise<string> {
  const candidate = newId();
  await env.DB.prepare(
    "UPDATE users SET analytics_person_id = COALESCE(analytics_person_id, ?) WHERE id = ?",
  ).bind(candidate, userId).run();
  const row = await env.DB.prepare(
    "SELECT analytics_person_id FROM users WHERE id = ?",
  ).bind(userId).first<{ analytics_person_id: string | null }>();
  if (!row?.analytics_person_id) throw new ApiError(401, "session_revoked", "The session is no longer active");
  return row.analytics_person_id;
}

export async function ensureWorkspaceAnalyticsId(env: Env, workspaceId: string): Promise<string> {
  const candidate = newId();
  await env.DB.prepare(
    "UPDATE workspaces SET analytics_workspace_id = COALESCE(analytics_workspace_id, ?) WHERE id = ? AND region = ?",
  ).bind(candidate, workspaceId, env.AVALON_REGION).run();
  const row = await env.DB.prepare(
    "SELECT analytics_workspace_id FROM workspaces WHERE id = ? AND region = ?",
  ).bind(workspaceId, env.AVALON_REGION).first<{ analytics_workspace_id: string | null }>();
  if (!row?.analytics_workspace_id) throw new ApiError(401, "session_revoked", "The session is no longer active");
  return row.analytics_workspace_id;
}

function subjectFor(
  event: TelemetryEnvelope,
  installationId: string | undefined,
  personAnalyticsId: string,
): string {
  if (event.identityScope === "installation") {
    if (!installationId) throw new ApiError(400, "telemetry_installation_required", "The request is invalid");
    return installationId;
  }
  if (event.identityScope === "anonymous-epoch") {
    throw new ApiError(400, "telemetry_identity_scope_forbidden", "The request is invalid");
  }
  return personAnalyticsId;
}

export async function acceptAuthenticatedTelemetry(
  env: Env,
  auth: IdentityAuthContext,
  batch: TelemetryBatch,
): Promise<TelemetryAcceptanceResult[]> {
  if (batch.events.some((event) => event.identityScope === "workspace")) {
    throw new ApiError(403, "telemetry_identity_scope_forbidden", "The request is invalid");
  }
  const [personAnalyticsId, workspaceAnalyticsId] = await Promise.all([
    ensurePersonAnalyticsId(env, auth.userId),
    auth.workspaceId ? ensureWorkspaceAnalyticsId(env, auth.workspaceId) : Promise.resolve(null),
  ]);
  await queueProfileJobs(env, auth, personAnalyticsId, workspaceAnalyticsId);
  const collector = new TelemetryCollector(env);
  return Promise.all(batch.events.map((event) => {
    if (event.context.region && event.context.region !== env.AVALON_REGION) {
      return { result: "route_mismatch", eventId: event.eventId } as const;
    }
    if (event.identityScope === "workspace-user" && !workspaceAnalyticsId) {
      throw new ApiError(403, "workspace_setup_required", "Choose or join a workspace to continue");
    }
    return collector.accept(event, {
      route: env.AVALON_REGION,
      routingBasis: "explicit_binding",
      analyticsSubjectId: subjectFor(event, batch.installationId, personAnalyticsId),
      subjectUserId: event.identityScope === "installation" ? null : auth.userId,
      workspaceAnalyticsId: event.identityScope === "workspace-user" ? workspaceAnalyticsId : null,
    });
  }));
}

async function queueProfileJobs(
  env: Env,
  auth: IdentityAuthContext,
  personAnalyticsId: string,
  workspaceAnalyticsId: string | null,
): Promise<void> {
  if (env.AVALON_REGION !== 'global') return;
  const user = await env.DB.prepare(
    'SELECT email, name, product_analytics_enabled FROM users WHERE id = ?',
  ).bind(auth.userId).first<{ email: string; name: string; product_analytics_enabled: number }>();
  if (!user || user.product_analytics_enabled !== 1) return;
  const now = new Date();
  const deleteAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1_000).toISOString();
  const personProperties = JSON.stringify({ email: user.email, name: user.name });
  const transition = await env.DB.prepare(
    `SELECT id, properties_json FROM telemetry_profile_jobs
     WHERE subject_user_id = ? AND job_kind = 'epoch_transition' AND state = 'pending'
     ORDER BY created_at LIMIT 1`,
  ).bind(auth.userId).first<{ id: string; properties_json: string }>();
  if (transition && transition.properties_json !== personProperties) await env.DB.prepare(
    `UPDATE telemetry_profile_jobs
     SET properties_json = ?, version = version + 1
     WHERE id = ? AND job_kind = 'epoch_transition' AND state = 'pending'`,
  ).bind(personProperties, transition.id).run();
  const statements = [];
  if (!transition) {
    const latestPerson = await env.DB.prepare(
      `SELECT properties_json FROM telemetry_profile_jobs
       WHERE subject_user_id = ? AND job_kind = 'person_profile'
         AND state IN ('pending', 'acknowledged')
       ORDER BY created_at DESC LIMIT 1`,
    ).bind(auth.userId).first<{ properties_json: string }>();
    if (latestPerson?.properties_json !== personProperties) {
    statements.push(
      env.DB.prepare(
        `UPDATE telemetry_profile_jobs SET state = 'suppressed'
         WHERE subject_user_id = ? AND job_kind = 'person_profile' AND state = 'pending'`,
      ).bind(auth.userId),
      env.DB.prepare(
        `INSERT INTO telemetry_profile_jobs
          (id, subject_user_id, workspace_id, job_kind, destination_analytics_id,
           anonymous_epoch_id, properties_json, version, state, created_at, delete_at)
         VALUES (?, ?, NULL, 'person_profile', ?, NULL, ?, 1, 'pending', ?, ?)`,
      ).bind(newId(now.getTime()), auth.userId, personAnalyticsId, personProperties, now.toISOString(), deleteAt),
    );
    }
  }
  if (auth.workspaceId && workspaceAnalyticsId) {
    const workspace = await env.DB.prepare(
      'SELECT name FROM workspaces WHERE id = ? AND region = ?',
    ).bind(auth.workspaceId, env.AVALON_REGION).first<{ name: string }>();
    if (workspace) {
      const groupProperties = JSON.stringify({ name: workspace.name });
      const latestGroup = await env.DB.prepare(
        `SELECT properties_json FROM telemetry_profile_jobs
         WHERE workspace_id = ? AND job_kind = 'group_profile'
           AND state IN ('pending', 'acknowledged')
         ORDER BY created_at DESC LIMIT 1`,
      ).bind(auth.workspaceId).first<{ properties_json: string }>();
      if (latestGroup?.properties_json !== groupProperties) {
      statements.push(
        env.DB.prepare(
          `UPDATE telemetry_profile_jobs SET state = 'suppressed'
           WHERE workspace_id = ? AND job_kind = 'group_profile' AND state = 'pending'`,
        ).bind(auth.workspaceId),
        env.DB.prepare(
          `INSERT INTO telemetry_profile_jobs
            (id, subject_user_id, workspace_id, job_kind, destination_analytics_id,
             anonymous_epoch_id, properties_json, version, state, created_at, delete_at)
           VALUES (?, ?, ?, 'group_profile', ?, NULL, ?, 1, 'pending', ?, ?)`,
        ).bind(
          newId(now.getTime()), auth.userId, auth.workspaceId, workspaceAnalyticsId,
          groupProperties, now.toISOString(), deleteAt,
        ),
      );
      }
    }
  }
  if (statements.length > 0) await env.DB.batch(statements);
}
