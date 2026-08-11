import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { ApiError } from "./lib/api-error";
import {
  WorkstreamEmailRoutingService,
  type WorkstreamEmailRouterRpcResult,
} from "./services/workstream-email-routing-service";
import {
  AutomationEmailRouteInputSchema,
  AutomationEmailRouteStatusInputSchema,
  WorkstreamEmailRouteInputSchema,
  WorkstreamEmailRouteStatusInputSchema,
  parseRpcInput,
  rpcBatch,
} from "./lib/rpc-contracts";

/** Global-only address registry used by both regional data planes. */
export class WorkstreamEmailRoutingBridge extends WorkerEntrypoint<Env> {
  ping() {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).pingGlobalRegistry());
  }

  reserve(input: unknown) {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).reserveInGlobalRegistry(
      parseRpcInput(WorkstreamEmailRouteInputSchema, input, "reserve"),
    ));
  }

  reserveMany(inputs: unknown) {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).reserveManyInGlobalRegistry(
      parseRpcInput(rpcBatch(WorkstreamEmailRouteInputSchema), inputs, "reserveMany"),
    ));
  }

  activateMany(inputs: unknown) {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).activateManyInGlobalRegistry(
      parseRpcInput(rpcBatch(WorkstreamEmailRouteInputSchema), inputs, "activateMany"),
    ));
  }

  setStatus(input: unknown) {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).setStatus(
      parseRpcInput(WorkstreamEmailRouteStatusInputSchema, input, "setStatus"),
    ));
  }

  reserveAutomation(input: unknown) {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).reserveAutomationInGlobalRegistry(
      parseRpcInput(AutomationEmailRouteInputSchema, input, "reserveAutomation"),
    ));
  }

  reserveAutomations(inputs: unknown) {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).reserveAutomationsInGlobalRegistry(
      parseRpcInput(rpcBatch(AutomationEmailRouteInputSchema), inputs, "reserveAutomations"),
    ));
  }

  activateAutomations(inputs: unknown) {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).activateAutomationsInGlobalRegistry(
      parseRpcInput(rpcBatch(AutomationEmailRouteInputSchema), inputs, "activateAutomations"),
    ));
  }

  setAutomationStatuses(inputs: unknown) {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).setAutomationStatusesInGlobalRegistry(
      parseRpcInput(rpcBatch(AutomationEmailRouteStatusInputSchema), inputs, "setAutomationStatuses"),
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
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      };
    }
    throw error;
  }
}
