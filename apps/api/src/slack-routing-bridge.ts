import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { serializeSlackRpcResult, SlackRoutingService } from "./services/slack-routing-service";
import {
  SlackRouteInputSchema,
  SlackRouteStatusInputSchema,
  parseRpcInput,
} from "./lib/rpc-contracts";

export class SlackRoutingBridge extends WorkerEntrypoint<Env> {
  registerSlackRoute(input: unknown) {
    return serializeSlackRpcResult(() =>
      new SlackRoutingService(this.env).registerInGlobal(
        parseRpcInput(SlackRouteInputSchema, input, "registerSlackRoute"),
      ));
  }

  setSlackRouteStatus(input: unknown) {
    return serializeSlackRpcResult(() =>
      new SlackRoutingService(this.env).setStatusInGlobal(
        parseRpcInput(SlackRouteStatusInputSchema, input, "setSlackRouteStatus"),
      ));
  }
}
