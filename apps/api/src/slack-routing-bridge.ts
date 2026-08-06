import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { serializeSlackRpcResult, SlackRoutingService, type SlackRouteInput, type SlackRouteStatusInput } from "./services/slack-routing-service";

export class SlackRoutingBridge extends WorkerEntrypoint<Env> {
  registerSlackRoute(input: SlackRouteInput) {
    return serializeSlackRpcResult(() => new SlackRoutingService(this.env).registerInGlobal(input));
  }

  setSlackRouteStatus(input: SlackRouteStatusInput) {
    return serializeSlackRpcResult(() => new SlackRoutingService(this.env).setStatusInGlobal(input));
  }
}
