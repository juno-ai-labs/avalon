import { configuredRegions, regionConfiguration } from "@rally/contracts/regions";
import { RegionSchema } from "@rally/contracts/regions";
import { readBoundedRequestBytes } from './lib/bounded-request-body';
import { providerWebhookMaxBytes } from './lib/bounded-request-body';
import { ApiError } from './lib/api-error';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import type { AshbyRegionalBridgeRpcBinding, GlobalAshbyRouterRpcBinding } from './services/ashby-routing-service';

export interface AshbyIngressEnv {
  PROVIDER_WEBHOOK_MAX_BYTES?: string;
  GLOBAL_ASHBY_ROUTER: GlobalAshbyRouterRpcBinding;
  GLOBAL_ASHBY_BRIDGE: AshbyRegionalBridgeRpcBinding;
  [binding: `${string}_ASHBY_BRIDGE`]: AshbyRegionalBridgeRpcBinding;
}
const ConnectionIdSchema = z.string().uuid();

/** A separate startup graph: no API application, connector registry, or agent runtime. */
export default class AshbyIngressWorker extends WorkerEntrypoint<AshbyIngressEnv> {
  private bridge(region: string): AshbyRegionalBridgeRpcBinding {
    const binding = this.env[`${regionConfiguration(region).bindingPrefix}_ASHBY_BRIDGE`];
    if (!binding) throw new Error('ashby_bridge_unavailable');
    return binding;
  }
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      try {
        const checks = await Promise.all([this.env.GLOBAL_ASHBY_ROUTER.health(), ...configuredRegions.map((region) => this.bridge(region).health())]);
        const expected = ['global', ...configuredRegions];
        const health = z.strictObject({ ok: z.literal(true), value: z.strictObject({ region: RegionSchema }) });
        if (checks.some((check, index) => { const parsed = health.safeParse(check); return !parsed.success || parsed.data.value.region !== expected[index]; })) throw new Error('ashby_bridge_unavailable');
        return Response.json({ ok: true });
      } catch { return Response.json({ ok: false, error: { code: 'ashby_ingress_unavailable', message: 'Ashby ingress dependencies are unavailable' } }, { status: 503 }); }
    }
    const match = /^\/ingest\/ashby\/([^/]+)$/u.exec(url.pathname);
    if (request.method !== 'POST' || !match) return new Response(null, { status: 404 });
    const connection = ConnectionIdSchema.safeParse(match[1]);
    if (!connection.success) return new Response(null, { status: 404 });
    let bytes: Uint8Array<ArrayBuffer>;
    try { bytes = await readBoundedRequestBytes(request, providerWebhookMaxBytes(this.env)); }
    catch (error) {
      if (error instanceof ApiError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
      throw error;
    }
    const route = await this.env.GLOBAL_ASHBY_ROUTER.lookupRoute(connection.data);
    if (!route.ok) return Response.json({ error: route.error }, { status: route.error.status });
    const bridge = this.bridge(route.value.region);
    // Do not decode, parse, re-serialize, or log signed provider bytes here.
    // Workspace authority, signature verification, and persistence stay regional.
    const result = await bridge.ingest({ connectionId: connection.data,
      rawBody: bytes.buffer, signature: request.headers.get('Ashby-Signature') });
    return result.ok ? Response.json(result.value)
      : Response.json({ error: result.error }, { status: result.error.status });
  }
}
