import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import type {
  LinearRouteInput,
  LinearRouteStatusInput,
} from "./services/linear-routing-service";
import {
  LinearRoutingService,
  serializeLinearRpcResult,
} from "./services/linear-routing-service";

/** Internal EU-to-Global route-registration surface; it has no public URL. */
export class LinearRoutingBridge extends WorkerEntrypoint<Env> {
  registerLinearRoute(input: LinearRouteInput) {
    return serializeLinearRpcResult(() =>
      new LinearRoutingService(this.env).registerInGlobal(input));
  }

  setLinearRouteStatus(input: LinearRouteStatusInput) {
    return serializeLinearRpcResult(() =>
      new LinearRoutingService(this.env).setStatusInGlobal(input));
  }
}
