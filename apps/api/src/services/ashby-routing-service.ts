import { z } from 'zod';
import { ConnectorError } from '@rally/connectors';
import type { Env } from '../env';
import { ApiError } from '../lib/api-error';
import { workspaceRegionalDatabase } from './workspace-runtime-database';

export const AshbyRouteSchema = z.strictObject({ connectionId: z.string().uuid(), region: z.enum(['global', 'eu']), status: z.enum(['active', 'disabled']) });
export const AshbyIngressSchema = z.strictObject({ connectionId: z.string().uuid(), rawBody: z.instanceof(ArrayBuffer), signature: z.string().nullable() });
export const AshbyIngestionResultSchema = z.union([
  z.strictObject({ ping: z.literal(true) }),
  z.strictObject({ duplicate: z.boolean(), activityId: z.string().uuid() }),
]);
export type AshbyRpcResult<T> = { ok: true; value: T } | { ok: false; error: { status: ApiError['status']; code: string; message: string } };
export interface GlobalAshbyRouterRpcBinding {
  health(): Promise<AshbyRpcResult<{ region: "global" | "eu" }>>;
  lookupRoute(connectionId: string): Promise<AshbyRpcResult<{ region: "global" | "eu" }>>;
  registerRoute(input: z.infer<typeof AshbyRouteSchema>): Promise<AshbyRpcResult<{ registered: true }>>;
}
export interface AshbyRegionalBridgeRpcBinding {
  health(): Promise<AshbyRpcResult<{ region: "global" | "eu" }>>;
  ingest(input: z.infer<typeof AshbyIngressSchema>): Promise<AshbyRpcResult<z.infer<typeof AshbyIngestionResultSchema>>>;
}
export async function serializeAshbyRpcResult<T>(operation: () => Promise<T>): Promise<AshbyRpcResult<T>> {
  try { return { ok: true, value: await operation() }; }
  catch (error) {
    if (error instanceof ApiError) return { ok: false, error: { status: error.status, code: error.code, message: error.message } };
    if (error instanceof ConnectorError) return { ok: false, error: {
      status: error.code === 'invalid_signature' || error.code === 'unauthorized' ? 401 : error.code === 'payload_too_large' ? 413 : 422,
      code: error.code, message: error.message,
    } };
    throw error;
  }
}
function unwrap<T>(result: AshbyRpcResult<T>): T {
  if (result.ok) return result.value;
  throw new ApiError(result.error.status, result.error.code, result.error.message);
}
/** Global stores only an opaque routing address, never API keys or signing secrets. */
export async function registerAshbyRoute(env: Env, input: z.infer<typeof AshbyRouteSchema>) {
  const route = AshbyRouteSchema.parse(input);
  if (env.AVALON_REGION === 'eu') {
    if (!env.GLOBAL_ASHBY_ROUTER) throw new ApiError(503, 'ashby_routing_unavailable', 'Ashby routing is unavailable');
    return unwrap(await env.GLOBAL_ASHBY_ROUTER.registerRoute(route));
  }
  await workspaceRegionalDatabase(env).prepare(`INSERT INTO ashby_connection_routes (connection_id, region, status, updated_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(connection_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
    WHERE ashby_connection_routes.region = excluded.region`).bind(route.connectionId, route.region, route.status, new Date().toISOString()).run();
  const persisted = await workspaceRegionalDatabase(env).prepare('SELECT region FROM ashby_connection_routes WHERE connection_id = ?').bind(route.connectionId).first<{ region: string }>();
  if (persisted?.region !== route.region) throw new ApiError(409, 'ashby_route_conflict', 'Ashby connection already belongs to another region');
  return { registered: true as const };
}
