import type { Region } from "@rally/contracts/regions";
import { newId } from '@rally/db';
import { TELEMETRY_ENVELOPE_SCHEMA, TELEMETRY_EVENTS, TelemetryEnvelopeSchema, type TelemetryEnvelope, type TelemetryEventName } from '@rally/contracts/telemetry';
import type { Env, IdentityAuthContext } from '../env';
import { acceptAuthenticatedTelemetry, ensureWorkspaceAnalyticsId } from './authenticated';
import { TelemetryCollector } from './collector';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function telemetryOperationId(header: string | undefined): string | null {
  return header && UUID_V7.test(header) ? header : null;
}

export function apiTelemetryEnvelope(
  env: Env,
  name: TelemetryEventName,
  properties: Record<string, unknown>,
  operationId: string,
  identityScope: 'platform-user' | 'workspace-user' | 'workspace',
  region: Region = env.AVALON_REGION,
  eventId?: string,
): TelemetryEnvelope {
  const now = new Date();
  const registry = TELEMETRY_EVENTS[name];
  return TelemetryEnvelopeSchema.parse({
    schema: TELEMETRY_ENVELOPE_SCHEMA,
    schemaVersion: registry.schemaVersion,
    eventId: eventId ?? newId(now.getTime()),
    name,
    source: 'api',
    category: registry.category,
    identityScope,
    originalTimestamp: now.toISOString(),
    sentAt: now.toISOString(),
    context: {
      environment: env.APP_ENV ?? 'production',
      region,
      release: env.APP_VERSION ?? 'unknown',
      buildId: env.BUILD_SHA ?? env.APP_VERSION ?? 'unknown',
      operationId,
    },
    properties,
  }) as TelemetryEnvelope;
}

export async function emitAuthenticatedApiTelemetry(
  env: Env,
  auth: IdentityAuthContext,
  event: TelemetryEnvelope,
): Promise<void> {
  await acceptAuthenticatedTelemetry(env, auth, { events: [event] });
}

/**
 * Accepts telemetry produced by workspace-owned background execution without
 * inventing a user identity. These events remain group-addressable in PostHog
 * and do not create a person profile.
 */
export async function emitWorkspaceApiTelemetry(
  env: Env,
  workspaceId: string,
  event: TelemetryEnvelope,
): Promise<void> {
  if (event.source !== 'api' || event.identityScope !== 'workspace') {
    throw new Error('workspace_telemetry_identity_mismatch');
  }
  const workspaceAnalyticsId = await ensureWorkspaceAnalyticsId(env, workspaceId);
  await new TelemetryCollector(env).accept(event, {
    route: env.AVALON_REGION,
    routingBasis: 'explicit_binding',
    analyticsSubjectId: workspaceAnalyticsId,
    subjectUserId: null,
    workspaceAnalyticsId,
  });
}
