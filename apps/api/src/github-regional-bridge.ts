import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { serializeGitHubRegionalRpcResult } from "./services/github-routing-service";
import { ConnectionService } from "./services/connection-service";
import { ProviderWebhookService } from "./services/provider-webhook-service";
import {
  GitHubRegionalSetupFailureInputSchema,
  GitHubRegionalSetupInputSchema,
  RegionalWebhookInputSchema,
  parseRpcInput,
} from "./lib/rpc-contracts";
import { requireWorkstreamIngress } from "./services/workstream-authority";

/**
 * Account-internal RPC surface used by the shared Global GitHub ingress. It
 * deliberately exposes no public HTTP route and hands exact request bytes to
 * the regional webhook service.
 */
export class GitHubRegionalBridge extends WorkerEntrypoint<Env> {
  setupGitHub(input: unknown) {
    return serializeGitHubRegionalRpcResult(async () => {
      await requireWorkstreamIngress(this.env);
      const parsed = parseRpcInput(GitHubRegionalSetupInputSchema, input, "setupGitHub");
      return new ConnectionService(this.env).setupGitHub(parsed.installationId, parsed.state);
    });
  }

  failGitHubSetup(input: unknown) {
    return serializeGitHubRegionalRpcResult(async () => {
      await requireWorkstreamIngress(this.env);
      const parsed = parseRpcInput(GitHubRegionalSetupFailureInputSchema, input, "failGitHubSetup");
      return new ConnectionService(this.env).failProviderAttempt("github", parsed.state, parsed.errorCode);
    });
  }

  ingestGitHub(input: unknown) {
    return serializeGitHubRegionalRpcResult(async () => {
      await requireWorkstreamIngress(this.env);
      const parsed = parseRpcInput(RegionalWebhookInputSchema, input, "ingestGitHub");
      return new ProviderWebhookService(this.env).ingestGitHub(new Uint8Array(parsed.rawBody), parsed.headers);
    });
  }
}
