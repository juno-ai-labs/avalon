import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { serializeLinearRpcResult } from "./services/linear-routing-service";
import { ProviderWebhookService } from "./services/provider-webhook-service";
import { RegionalWebhookInputSchema, parseRpcInput } from "./lib/rpc-contracts";

/** Account-internal exact-byte handoff from the shared Linear ingress. */
export class LinearRegionalBridge extends WorkerEntrypoint<Env> {
  ingestLinear(input: unknown) {
    return serializeLinearRpcResult(() => {
      const parsed = parseRpcInput(RegionalWebhookInputSchema, input, "ingestLinear");
      return new ProviderWebhookService(this.env).ingestLinear(new Uint8Array(parsed.rawBody), parsed.headers);
    });
  }
}
