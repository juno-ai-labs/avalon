import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import {
  RegionalOnboardingService,
  serializeRegionalRpcResult,
  type PlatformIdentity,
  type RegionalAcceptInput,
  type RegionalActivateInput,
  type RegionalCreateInput,
  type RegionalDeclineInput,
  type RegionalRpcResult,
} from "./services/platform-onboarding-service";
import type { Session } from "@avalon/contracts";

/**
 * Account-internal RPC entrypoint used by the Global identity control plane.
 * It is deliberately a named WorkerEntrypoint rather than an HTTP route, so
 * none of these trusted-identity operations are reachable on the EU hostname.
 */
export class RegionalIdentityBridge extends WorkerEntrypoint<Env> {
  discover(identity: PlatformIdentity) {
    return serializeRegionalRpcResult(() => new RegionalOnboardingService(this.env).discover(identity));
  }

  activate(input: RegionalActivateInput): Promise<RegionalRpcResult<Session>> {
    return serializeRegionalRpcResult(() => new RegionalOnboardingService(this.env).activate(input));
  }

  create(input: RegionalCreateInput): Promise<RegionalRpcResult<Session>> {
    return serializeRegionalRpcResult(() => new RegionalOnboardingService(this.env).create(input));
  }

  accept(input: RegionalAcceptInput): Promise<RegionalRpcResult<Session>> {
    return serializeRegionalRpcResult(() => new RegionalOnboardingService(this.env).accept(input));
  }

  decline(input: RegionalDeclineInput) {
    return serializeRegionalRpcResult(() => new RegionalOnboardingService(this.env).decline(input));
  }
}
