import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import type { LinearRegionalWebhookInput } from "./services/linear-routing-service";
import { serializeLinearRpcResult } from "./services/linear-routing-service";
import { ProviderWebhookService } from "./services/provider-webhook-service";

/** Account-internal exact-byte handoff from the shared Linear ingress. */
export class LinearRegionalBridge extends WorkerEntrypoint<Env> {
  ingestLinear(input: LinearRegionalWebhookInput) {
    return serializeLinearRpcResult(() =>
      new ProviderWebhookService(this.env).ingestLinear(
        new Uint8Array(input.rawBody),
        input.headers,
      ));
  }
}
