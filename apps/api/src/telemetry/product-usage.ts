import type { UserId, WorkspaceId } from '@rally/contracts';
import type {
  TelemetryEventName,
  TelemetryEventProperties,
} from '@rally/contracts/telemetry';
import type { Env, IdentityAuthContext } from '../env';
import {
  apiTelemetryEnvelope,
  emitAuthenticatedApiTelemetry,
  emitWorkspaceApiTelemetry,
} from './api-emitter';

export type TelemetryCountBucket =
  | 'zero'
  | 'one'
  | 'two_to_five'
  | 'six_to_twenty'
  | 'twenty_one_to_one_hundred'
  | 'over_one_hundred';

export type TelemetryJourneyDuration =
  | 'unknown'
  | 'lt_1s'
  | '1s_5s'
  | '5s_30s'
  | '30s_2m'
  | '2m_10m'
  | 'gte_10m';

export function telemetryCountBucket(value: number): TelemetryCountBucket {
  const count = Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0));
  if (count === 0) return 'zero';
  if (count === 1) return 'one';
  if (count <= 5) return 'two_to_five';
  if (count <= 20) return 'six_to_twenty';
  if (count <= 100) return 'twenty_one_to_one_hundred';
  return 'over_one_hundred';
}

export function telemetryJourneyDuration(milliseconds: number): TelemetryJourneyDuration {
  const duration = Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0);
  if (duration < 1_000) return 'lt_1s';
  if (duration < 5_000) return '1s_5s';
  if (duration < 30_000) return '5s_30s';
  if (duration < 2 * 60_000) return '30s_2m';
  if (duration < 10 * 60_000) return '2m_10m';
  return 'gte_10m';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * Produces a stable UUIDv7 insert id for a semantic observation owned by an
 * existing resource. The namespace changes the last random nibble, so separate
 * lifecycle observations cannot collide with one another or with the resource
 * id while retries remain idempotent.
 */
export function resourceTelemetryEventId(resourceId: string, namespace: number): string {
  if (!UUID.test(resourceId) || !Number.isInteger(namespace) || namespace < 1 || namespace > 15) {
    throw new Error('telemetry_resource_event_id_invalid');
  }
  const normalized = `${resourceId.slice(0, 14)}7${resourceId.slice(15)}`;
  const final = Number.parseInt(normalized.at(-1)!, 16) ^ namespace;
  return `${normalized.slice(0, -1)}${final.toString(16)}`;
}

interface ProductTelemetryInput<TName extends TelemetryEventName> {
  workspaceId: WorkspaceId;
  userId?: UserId;
  name: TName;
  properties: TelemetryEventProperties<TName>;
  operationId: string;
  eventId: string;
}

export async function emitProductUsageTelemetry<TName extends TelemetryEventName>(
  env: Env,
  input: ProductTelemetryInput<TName>,
): Promise<void> {
  const identityScope = input.userId ? 'workspace-user' : 'workspace';
  const event = apiTelemetryEnvelope(
    env,
    input.name,
    input.properties,
    input.operationId,
    identityScope,
    env.AVALON_REGION,
    input.eventId,
  );
  if (!input.userId) {
    await emitWorkspaceApiTelemetry(env, input.workspaceId, event);
    return;
  }
  const auth: IdentityAuthContext = {
    sessionId: `telemetry:${input.name}:${input.eventId}`,
    userId: input.userId,
    workspaceId: input.workspaceId,
    region: env.AVALON_REGION,
    role: null,
  };
  await emitAuthenticatedApiTelemetry(env, auth, event);
}
