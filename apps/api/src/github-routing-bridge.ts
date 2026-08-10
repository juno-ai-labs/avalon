import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import {
  GitHubRoutingService,
  serializeGitHubRegionalRpcResult,
  type GitHubRouteStatusInput,
} from "./services/github-routing-service";

/** Internal regional-to-Global GitHub route lifecycle surface. */
export class GitHubRoutingBridge extends WorkerEntrypoint<Env> {
  setGitHubRouteStatus(input: GitHubRouteStatusInput) {
    return serializeGitHubRegionalRpcResult(() =>
      new GitHubRoutingService(this.env).setStatusInGlobal(input));
  }
}
