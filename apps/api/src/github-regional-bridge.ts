import { WorkerEntrypoint } from "cloudflare:workers";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import type { Env } from "./env";
import { ApiError } from "./lib/api-error";
import { serializeGitHubRegionalRpcResult } from "./services/github-routing-service";
import { ConnectionService } from "./services/connection-service";
import { ProviderWebhookService } from "./services/provider-webhook-service";
import {
  GitHubRegionalSetupFailureInputSchema,
  GitHubRegionalSetupInputSchema,
  GitHubVerifiedDeliveryInputSchema,
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

  /**
   * Takes a delivery the Global receiver already verified and does not verify
   * it again: this entrypoint is reachable only over the account-internal
   * service binding, and the Global Queue consumer is its only caller. That
   * makes the binding part of the trust boundary: bytes that reach it are
   * treated as signed by GitHub.
   *
   * A rejected input names its field in the error code, which is all of the
   * error that survives the hop back to the consumer's log.
   */
  ingestVerifiedGitHub(input: unknown) {
    return serializeGitHubRegionalRpcResult(async () => {
      await requireWorkstreamIngress(this.env);
      const parsed = GitHubVerifiedDeliveryInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new ApiError(
          400,
          zodDiagnosticCode(parsed.error, "github_verified_delivery") ?? "github_verified_delivery_invalid",
          "Invalid ingestVerifiedGitHub input",
        );
      }
      return new ProviderWebhookService(this.env).ingestVerifiedGitHub(parsed.data);
    });
  }
}
