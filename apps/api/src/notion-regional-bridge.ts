import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { serializeNotionRpcResult } from "./services/notion-routing-service";
import { ConnectionService } from "./services/connection-service";
import { ProviderWebhookService } from "./services/provider-webhook-service";
import {
  NotionCallbackFailureInputSchema,
  NotionCallbackInputSchema,
  NotionCallbackStateInputSchema,
  NotionChallengeInputSchema,
  RegionalWebhookInputSchema,
  parseRpcInput,
} from "./lib/rpc-contracts";
import { requireWorkstreamIngress } from "./services/workstream-authority";

/**
 * Account-internal RPC surface used by the shared Global Notion ingress. It
 * exposes no public HTTP route: the authorization code and the exact signed
 * webhook bytes arrive over the service binding and are exchanged, verified, and
 * persisted here, in the region that owns the connection.
 */
export class NotionRegionalBridge extends WorkerEntrypoint<Env> {
  completeNotion(input: unknown) {
    return serializeNotionRpcResult(async () => {
      await requireWorkstreamIngress(this.env);
      const parsed = parseRpcInput(NotionCallbackInputSchema, input, "completeNotion");
      return new ConnectionService(this.env).completeProvider("notion", parsed.code, parsed.state);
    });
  }

  denyNotion(input: unknown) {
    return serializeNotionRpcResult(async () => {
      await requireWorkstreamIngress(this.env);
      const parsed = parseRpcInput(NotionCallbackStateInputSchema, input, "denyNotion");
      return new ConnectionService(this.env).completeProviderDenial("notion", parsed.state);
    });
  }

  failNotionAttempt(input: unknown) {
    return serializeNotionRpcResult(async () => {
      await requireWorkstreamIngress(this.env);
      const parsed = parseRpcInput(NotionCallbackFailureInputSchema, input, "failNotionAttempt");
      return new ConnectionService(this.env).failProviderAttempt("notion", parsed.state, parsed.errorCode);
    });
  }

  ingestNotion(input: unknown) {
    return serializeNotionRpcResult(async () => {
      await requireWorkstreamIngress(this.env);
      const parsed = parseRpcInput(RegionalWebhookInputSchema, input, "ingestNotion");
      return new ProviderWebhookService(this.env).ingestNotion(new Uint8Array(parsed.rawBody), parsed.headers);
    });
  }

  storeNotionChallenge(input: unknown) {
    return serializeNotionRpcResult(async () => {
      await requireWorkstreamIngress(this.env);
      const parsed = parseRpcInput(NotionChallengeInputSchema, input, "storeNotionChallenge");
      await new ProviderWebhookService(this.env).storeNotionChallengeToken(
        parsed.verificationToken,
        null,
        parsed.setupGeneration,
      );
      return { stored: true as const };
    });
  }
}
