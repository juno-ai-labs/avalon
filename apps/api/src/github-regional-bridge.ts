import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import type {
  GitHubRegionalSetupInput,
  GitHubRegionalWebhookInput,
} from "./services/github-routing-service";
import { serializeGitHubRegionalRpcResult } from "./services/github-routing-service";
import { ConnectionService } from "./services/connection-service";
import { ProviderWebhookService } from "./services/provider-webhook-service";

/**
 * Account-internal RPC surface used by the shared Global GitHub ingress. It
 * deliberately exposes no public HTTP route and hands exact request bytes to
 * the EU regional webhook service.
 */
export class GitHubRegionalBridge extends WorkerEntrypoint<Env> {
  setupGitHub(input: GitHubRegionalSetupInput) {
    return serializeGitHubRegionalRpcResult(() =>
      new ConnectionService(this.env).setupGitHub(
        input.installationId,
        input.state,
      ));
  }

  ingestGitHub(input: GitHubRegionalWebhookInput) {
    return serializeGitHubRegionalRpcResult(() =>
      new ProviderWebhookService(this.env).ingestGitHub(
        new Uint8Array(input.rawBody),
        input.headers,
      ));
  }
}
