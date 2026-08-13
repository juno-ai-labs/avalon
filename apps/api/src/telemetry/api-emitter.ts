import { newId } from '@avalon/db';
import { TELEMETRY_EVENTS, TelemetryEnvelopeSchema, type TelemetryEnvelope, type TelemetryEventName } from '@avalon/contracts/telemetry';
import type { Env, IdentityAuthContext } from '../env';
import { acceptAuthenticatedTelemetry } from './authenticated';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function telemetryOperationId(header: string | undefined): string | null {
  return header && UUID_V7.test(header) ? header : null;
}

export function apiTelemetryEnvelope(
  env: Env,
  name: TelemetryEventName,
  properties: Record<string, unknown>,
  operationId: string,
  identityScope: 'platform-user' | 'workspace-user',
  region: 'global' | 'eu' = env.AVALON_REGION,
  eventId?: string,
): TelemetryEnvelope {
  const now = new Date();
  const registry = TELEMETRY_EVENTS[name];
  return TelemetryEnvelopeSchema.parse({
    schema: 'com.avalon.telemetry.event',
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
