import type { TelemetryEventProperties } from '@rally/contracts/telemetry';
import type { Env } from '../env';
import { runtimeDeferral } from '../lib/defer';
import { diagnosticErrorCode, logWarn } from '../observability/logger';
import { apiTelemetryEnvelope } from './api-emitter';
import { TelemetryCollector } from './collector';
import { resourceTelemetryEventId } from './product-usage';

export type SignupPlatform = 'browser' | 'desktop';
export interface SignupFlow { flowId: string | null; clientPlatform: SignupPlatform }
type SignupEvent = 'signup_started' | 'signup_email_submitted' | 'signup_verification_requested'
  | 'signup_verification_completed' | 'authentication_completed' | 'signup_completed' | 'signup_failed'
  | 'signup_viewed' | 'signup_account_created' | 'signup_organization_requested' | 'signup_organization_ready' | 'signup_onboarding_completed';
const namespaces: Record<SignupEvent, number> = {
  signup_viewed: 8, signup_account_created: 9, signup_organization_requested: 10, signup_organization_ready: 11, signup_onboarding_completed: 12,
  signup_started: 1, signup_email_submitted: 2, signup_verification_requested: 3,
  signup_verification_completed: 4, authentication_completed: 5, signup_completed: 6, signup_failed: 7,
};

/** Server-observed stages share an opaque attempt identity, including across magic-link tabs.
 * Authentication never awaits analytics. Known accounts retain their collection preference. */
export function observeSignup(
  env: Env, flow: SignupFlow, name: SignupEvent,
  method: TelemetryEventProperties<'signup_started'>['method'],
  input: { observedAt?: string; clientPlatform?: SignupPlatform; userId?: string; result?: 'success' | 'failed' | 'denied'; created?: boolean; signupPath?: 'new_organization' | 'existing_organization' } = {},
): void {
  if (!flow.flowId) return; // Proofs issued before this instrumentation have no lineage.
  try {
    const namespace = name === 'signup_organization_requested' ? (input.signupPath === 'new_organization' ? 13 : 14) : namespaces[name];
    const event = apiTelemetryEnvelope(env, name, {
      flowId: flow.flowId, clientPlatform: input.clientPlatform ?? flow.clientPlatform, entryPlatform: flow.clientPlatform, method, result: input.result ?? 'success',
      ...(input.signupPath ? { signupPath: input.signupPath } : {}),
      ...(input.created === undefined ? {} : { accountStatus: input.created ? 'new' : 'existing' }),
    }, flow.flowId, 'anonymous-epoch', env.AVALON_REGION, resourceTelemetryEventId(flow.flowId, namespace));
    if (input.observedAt) event.originalTimestamp = input.observedAt;
    runtimeDeferral(new TelemetryCollector(env).accept(event, {
      route: env.AVALON_REGION, routingBasis: 'explicit_binding', analyticsSubjectId: flow.flowId,
      subjectUserId: input.userId ?? null, workspaceAnalyticsId: null,
    }).catch((error: unknown) => { logWarn(env, 'signup_telemetry_delivery_failed', { event: name, code: diagnosticErrorCode(error, 'signup_telemetry_delivery_failed') }); }));
  } catch (error) {
    logWarn(env, 'signup_telemetry_registration_failed', { event: name, code: diagnosticErrorCode(error, 'signup_telemetry_registration_failed') });
  }
}

export function observeAuthenticationCompleted(env: Env, flow: SignupFlow, method: 'google' | 'email', userId: string, created: boolean): void {
  observeSignup(env, flow, 'authentication_completed', method, { userId, created });
  if (created) {
    observeSignup(env, flow, 'signup_account_created', method, { userId, created });
  }
}

/** Join/setup observations run after the authoritative mutation and follow only a new account's first flow. */
export function observeSignupProgress(env: Env, userId: string, name: 'signup_organization_requested' | 'signup_organization_ready' | 'signup_onboarding_completed', signupPath?: 'new_organization' | 'existing_organization', clientPlatform: SignupPlatform = 'desktop'): void {
  const observedAt = new Date().toISOString();
  runtimeDeferral((async () => {
    const row = await env.DB.prepare(`SELECT signup_flow_id,signup_client_platform,signup_path,signup_completed_at
      FROM users WHERE id=?`).bind(userId).first<{ signup_flow_id:string|null;signup_client_platform:SignupPlatform;signup_path:'new_organization'|'existing_organization'|null;signup_completed_at:string|null }>();
    if (!row?.signup_flow_id || row.signup_completed_at) return;
    const flow = { flowId: row.signup_flow_id, clientPlatform: row.signup_client_platform };
    let path = signupPath ?? row.signup_path ?? undefined;
    if (name === 'signup_organization_ready' && signupPath) {
      const saved = await env.DB.prepare('UPDATE users SET signup_path=COALESCE(signup_path,?) WHERE id=? RETURNING signup_path')
        .bind(signupPath,userId).first<{ signup_path: 'new_organization' | 'existing_organization' }>();
      path = saved?.signup_path;
    }
    observeSignup(env, flow, name, 'unknown', { observedAt, clientPlatform, userId, created: true, ...(path ? { signupPath: path } : {}) });
    if (name === 'signup_organization_requested') return;
    // Read both conditions at the write, not from the initial asynchronous
    // snapshot: organization readiness and profile introduction may overlap.
    const completed = await env.DB.prepare(`UPDATE users SET signup_completed_at=? WHERE id=? AND signup_completed_at IS NULL
      AND signup_path IS NOT NULL AND (onboarding_eligible!=1 OR onboarding_introduced=1) RETURNING signup_path`)
      .bind(new Date().toISOString(),userId).first<{ signup_path: 'new_organization' | 'existing_organization' }>();
    if (completed) observeSignup(env, flow, 'signup_completed', 'unknown', { clientPlatform, userId, created: true, signupPath: completed.signup_path });
  })().catch((error: unknown) => { logWarn(env, 'signup_progress_telemetry_failed', { event: name, code: diagnosticErrorCode(error, 'signup_progress_telemetry_failed') }); }));
}
