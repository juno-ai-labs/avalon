import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { ApiError } from "./lib/api-error";
import {
  WorkstreamEmailRoutingService,
  type WorkstreamEmailRouterRpcResult,
} from "./services/workstream-email-routing-service";
import {
  AutomationEmailAddressClaimSchema,
  AutomationEmailRouteInputSchema,
  parseRpcInput,
  rpcBatch,
} from "./lib/rpc-contracts";

/** Global-only address registry used by both regional data planes. */
export class WorkstreamEmailRoutingBridge extends WorkerEntrypoint<Env> {
  ping() {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).pingGlobalRegistry());
  }

  reserveAutomation(input: unknown) {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).reserveAutomationInGlobalRegistry(
      parseRpcInput(AutomationEmailRouteInputSchema, input, "reserveAutomation"),
    ));
  }

  claimAutomation(input: unknown) {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).claimAutomationInGlobalRegistry(
      parseRpcInput(AutomationEmailAddressClaimSchema, input, "claimAutomation"),
    ));
  }

  reserveAutomations(inputs: unknown) {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).reserveAutomationsInGlobalRegistry(
      parseRpcInput(rpcBatch(AutomationEmailRouteInputSchema), inputs, "reserveAutomations"),
    ));
  }

}

async function rpcResult<T>(operation: () => Promise<T>): Promise<WorkstreamEmailRouterRpcResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        ok: false,
        error: {
          status: error.status,
          code: error.code,
          // `details` deliberately does not travel. `unwrapRpcResult` rebuilds
          // an `ApiError` from this envelope and `errorHandler` echoes its
          // details into the HTTP body, so forwarding them would put internal
          // RPC method names and schema field paths in front of the client.
          // The other four bridge serializers already project to these three
          // fields; this one was the outlier.
          message: error.message,
        },
      };
    }
    throw error;
  }
}
