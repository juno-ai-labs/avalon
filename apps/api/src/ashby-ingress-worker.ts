import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import type { AshbyRegionalBridgeRpcBinding, GlobalAshbyRouterRpcBinding } from './services/ashby-routing-service';

export interface AshbyIngressEnv {
  GLOBAL_ASHBY_ROUTER: GlobalAshbyRouterRpcBinding;
  GLOBAL_ASHBY_BRIDGE: AshbyRegionalBridgeRpcBinding;
  EU_ASHBY_BRIDGE: AshbyRegionalBridgeRpcBinding;
}
const ConnectionIdSchema = z.string().uuid();

/** A separate startup graph: no API application, connector registry, or agent runtime. */
export default class AshbyIngressWorker extends WorkerEntrypoint<AshbyIngressEnv> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return Response.json({ ok: true });
    const match = /^\/ingest\/ashby\/([^/]+)$/u.exec(url.pathname);
    if (request.method !== 'POST' || !match) return new Response(null, { status: 404 });
    const connection = ConnectionIdSchema.safeParse(match[1]);
    if (!connection.success) return new Response(null, { status: 404 });
    const route = await this.env.GLOBAL_ASHBY_ROUTER.lookupRoute(connection.data);
    if (!route.ok) return Response.json({ error: route.error }, { status: route.error.status });
    const bridge = route.value.region === 'eu' ? this.env.EU_ASHBY_BRIDGE : this.env.GLOBAL_ASHBY_BRIDGE;
    // Do not decode, parse, re-serialize, or log signed provider bytes here.
    // Workspace authority, signature verification, and persistence stay regional.
    const result = await bridge.ingest({ connectionId: connection.data,
      rawBody: await request.arrayBuffer(), signature: request.headers.get('Ashby-Signature') });
    return result.ok ? Response.json(result.value)
      : Response.json({ error: result.error }, { status: result.error.status });
  }
}
