import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import {
  GitHubRoutingService,
  serializeGitHubRegionalRpcResult,
} from "./services/github-routing-service";
import { GitHubRouteStatusInputSchema, parseRpcInput } from "./lib/rpc-contracts";

/** Internal regional-to-Global GitHub route lifecycle surface. */
export class GitHubRoutingBridge extends WorkerEntrypoint<Env> {
  setGitHubRouteStatus(input: unknown) {
    return serializeGitHubRegionalRpcResult(() =>
      new GitHubRoutingService(this.env).setStatusInGlobal(
        parseRpcInput(GitHubRouteStatusInputSchema, input, "setGitHubRouteStatus"),
      ));
  }
}
