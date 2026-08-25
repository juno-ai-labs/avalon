import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import {
  RegionalOnboardingService,
  platformIdentitySchema,
  regionalAcceptSchema,
  regionalActivateSchema,
  regionalCreateSchema,
  regionalDeclineSchema,
  serializeRegionalRpcResult,
  type RegionalRpcResult,
} from "./services/platform-onboarding-service";
import { parseRpcInput } from "./lib/rpc-contracts";
import type { Session } from "@rally/contracts";

/**
 * Account-internal RPC entrypoint used by the Global identity control plane.
 * It is deliberately a named WorkerEntrypoint rather than an HTTP route, so
 * none of these trusted-identity operations are reachable on the EU hostname.
 *
 * The schemas were already written — they are what the input types are inferred
 * from — but were applied deeper in the service, so an argument that never
 * reached one crossed the region boundary unchecked.
 */
export class RegionalIdentityBridge extends WorkerEntrypoint<Env> {
  discover(identity: unknown) {
    return serializeRegionalRpcResult(() => new RegionalOnboardingService(this.env).discover(
      parseRpcInput(platformIdentitySchema, identity, "discover"),
    ));
  }

  activate(input: unknown): Promise<RegionalRpcResult<Session>> {
    return serializeRegionalRpcResult(() => new RegionalOnboardingService(this.env).activate(
      parseRpcInput(regionalActivateSchema, input, "activate"),
    ));
  }

  create(input: unknown): Promise<RegionalRpcResult<Session>> {
    return serializeRegionalRpcResult(() => new RegionalOnboardingService(this.env).create(
      parseRpcInput(regionalCreateSchema, input, "create"),
    ));
  }

  accept(input: unknown): Promise<RegionalRpcResult<Session>> {
    return serializeRegionalRpcResult(() => new RegionalOnboardingService(this.env).accept(
      parseRpcInput(regionalAcceptSchema, input, "accept"),
    ));
  }

  decline(input: unknown) {
    return serializeRegionalRpcResult(() => new RegionalOnboardingService(this.env).decline(
      parseRpcInput(regionalDeclineSchema, input, "decline"),
    ));
  }
}
