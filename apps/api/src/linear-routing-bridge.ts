import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import {
  LinearRoutingService,
  serializeLinearRpcResult,
} from "./services/linear-routing-service";
import {
  LinearRouteInputSchema,
  LinearRouteStatusInputSchema,
  parseRpcInput,
} from "./lib/rpc-contracts";

/** Internal Regional-to-Global route-registration surface; it has no public URL. */
export class LinearRoutingBridge extends WorkerEntrypoint<Env> {
  registerLinearRoute(input: unknown) {
    return serializeLinearRpcResult(() =>
      new LinearRoutingService(this.env).registerInGlobal(
        parseRpcInput(LinearRouteInputSchema, input, "registerLinearRoute"),
      ));
  }

  setLinearRouteStatus(input: unknown) {
    return serializeLinearRpcResult(() =>
      new LinearRoutingService(this.env).setStatusInGlobal(
        parseRpcInput(LinearRouteStatusInputSchema, input, "setLinearRouteStatus"),
      ));
  }
}
