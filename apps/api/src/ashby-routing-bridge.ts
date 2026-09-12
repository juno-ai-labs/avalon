import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './env';
import { AshbyRouteSchema, registerAshbyRoute, serializeAshbyRpcResult } from './services/ashby-routing-service';
import { z } from 'zod';
import { workspaceRegionalDatabase } from './services/workspace-runtime-database';
import { ApiError } from './lib/api-error';

/** Internal EU-to-Global opaque routing registration, with no public mutation URL. */
export class AshbyRoutingBridge extends WorkerEntrypoint<Env> {
  lookupRoute(connectionId: unknown) {
    return serializeAshbyRpcResult(async () => {
      if (this.env.AVALON_REGION !== 'global') throw new ApiError(503, 'ashby_router_wrong_region', 'Ashby routing must run in Global');
      const id = z.string().uuid().parse(connectionId);
      const route = await workspaceRegionalDatabase(this.env).prepare("SELECT region FROM ashby_connection_routes WHERE connection_id = ? AND status = 'active'").bind(id).first<{ region: string }>();
      if (!route) throw new ApiError(404, 'connection_not_found', 'Ashby connection route not found');
      return { region: z.enum(['global', 'eu']).parse(route.region) };
    });
  }
  registerRoute(input: unknown) {
    return serializeAshbyRpcResult(async () => {
      if (this.env.AVALON_REGION !== 'global') throw new ApiError(503, 'ashby_router_wrong_region', 'Ashby routing must run in Global');
      return registerAshbyRoute(this.env, AshbyRouteSchema.parse(input));
    });
  }
}
