import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import { newId } from '@rally/db';
import type { MiddlewareHandler } from 'hono';
import type { Env, HonoAppEnv, IdentityAuthContext } from '../env';
import { requestDeferral } from '../lib/defer';
import {
  apiTelemetryEnvelope,
  emitAuthenticatedApiTelemetry,
  telemetryOperationId,
} from '../telemetry/api-emitter';

type Operation = 'workspace_create' | 'workspace_activate' | 'canvas_create';
type Result = 'success' | 'validation_error' | 'conflict' | 'denied' | 'unavailable' | 'failed';
type Duration = 'lt_100ms' | '100ms_1s' | '1s_5s' | '5s_30s' | 'gte_30s';

export interface ApiOperationProjection extends Record<string, unknown> {
  operation: Operation;
  result: Result;
  duration: Duration;
  correlationOperationId?: string;
}

const allowlist = new Map<string, Operation>([
  ['POST /canvases', 'canvas_create'],
]);

export function apiOperationTelemetry(options: {
  emit?: (env: Env, auth: IdentityAuthContext, projection: ApiOperationProjection) => Promise<void>;
  now?: () => number;
} = {}): MiddlewareHandler<HonoAppEnv> {
  const emit = options.emit ?? emitProjection;
  const now = options.now ?? Date.now;
  return async (c, next) => {
    const operation = allowlist.get(`${c.req.method} ${c.req.path}`);
    if (!operation) {
      await next();
      return;
    }
    const startedAt = now();
    const correlationOperationId = telemetryOperationId(readRallyHeader((name) => c.req.header(name), RALLY_HEADERS.OPERATION_ID));
    try {
      await next();
      deferSafely(c, () => emit(c.env, requiredAuth(c.get('auth')), {
        operation,
        result: resultForStatus(c.res.status),
        duration: durationBucket(now() - startedAt),
        ...(correlationOperationId ? { correlationOperationId } : {}),
      }));
    } catch (error) {
      deferSafely(c, () => emit(c.env, requiredAuth(c.get('auth')), {
        operation,
        result: 'failed',
        duration: durationBucket(now() - startedAt),
        ...(correlationOperationId ? { correlationOperationId } : {}),
      }));
      throw error;
    }
  };
}

function deferSafely(
  c: Parameters<MiddlewareHandler<HonoAppEnv>>[0],
  create: () => Promise<void>,
): void {
  try {
    requestDeferral(c)(create().catch(() => undefined));
  } catch {
    // Telemetry construction and deferral are observational. Neither may alter
    // the operation that just completed.
  }
}

function requiredAuth(auth: IdentityAuthContext | undefined): IdentityAuthContext {
  if (!auth) throw new Error('api_operation_telemetry_auth_required');
  return auth;
}

async function emitProjection(
  env: Env,
  auth: IdentityAuthContext,
  projection: ApiOperationProjection,
): Promise<void> {
  const { correlationOperationId, operation, result, duration } = projection;
  const event = apiTelemetryEnvelope(
    env,
    'api_operation_outcome',
    { operation, result, duration },
    correlationOperationId ?? newId(),
    auth.workspaceId ? 'workspace-user' : 'platform-user',
  );
  await emitAuthenticatedApiTelemetry(env, auth, event);
}

function resultForStatus(status: number): Result {
  if (status >= 200 && status < 400) return 'success';
  if (status === 400 || status === 413 || status === 422 || status === 426 || status === 429) {
    return 'validation_error';
  }
  if (status === 409) return 'conflict';
  if (status === 401 || status === 403 || status === 404) return 'denied';
  if (status === 502 || status === 503 || status === 504) return 'unavailable';
  return 'failed';
}

function durationBucket(durationMs: number): Duration {
  if (!Number.isFinite(durationMs) || durationMs < 0) return 'gte_30s';
  if (durationMs < 100) return 'lt_100ms';
  if (durationMs < 1_000) return '100ms_1s';
  if (durationMs < 5_000) return '1s_5s';
  if (durationMs < 30_000) return '5s_30s';
  return 'gte_30s';
}
