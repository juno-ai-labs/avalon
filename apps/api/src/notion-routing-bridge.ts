import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import {
  NotionRoutingService,
  serializeNotionRpcResult,
} from "./services/notion-routing-service";
import {
  NotionRouteInputSchema,
  NotionRouteStatusInputSchema,
  parseRpcInput,
} from "./lib/rpc-contracts";

/** Internal Regional-to-Global route-registration surface; it has no public URL. */
export class NotionRoutingBridge extends WorkerEntrypoint<Env> {
  registerNotionRoute(input: unknown) {
    return serializeNotionRpcResult(() =>
      new NotionRoutingService(this.env).registerInGlobal(
        parseRpcInput(NotionRouteInputSchema, input, "registerNotionRoute"),
      ));
  }

  setNotionRouteStatus(input: unknown) {
    return serializeNotionRpcResult(() =>
      new NotionRoutingService(this.env).setStatusInGlobal(
        parseRpcInput(NotionRouteStatusInputSchema, input, "setNotionRouteStatus"),
      ));
  }
}
