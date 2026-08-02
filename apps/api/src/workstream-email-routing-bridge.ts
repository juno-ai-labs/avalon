import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { ApiError } from "./lib/api-error";
import {
  WorkstreamEmailRoutingService,
  type AutomationEmailRouteInput,
  type AutomationEmailRouteStatusInput,
  type WorkstreamEmailRouterRpcResult,
  type WorkstreamEmailRouteInput,
  type WorkstreamEmailRouteStatusInput,
} from "./services/workstream-email-routing-service";

/** Global-only address registry used by both regional data planes. */
export class WorkstreamEmailRoutingBridge extends WorkerEntrypoint<Env> {
  ping() {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).pingGlobalRegistry());
  }

  reserve(input: WorkstreamEmailRouteInput) {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).reserveInGlobalRegistry(input));
  }

  reserveMany(inputs: WorkstreamEmailRouteInput[]) {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).reserveManyInGlobalRegistry(inputs));
  }

  activateMany(inputs: WorkstreamEmailRouteInput[]) {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).activateManyInGlobalRegistry(inputs));
  }

  setStatus(input: WorkstreamEmailRouteStatusInput) {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).setStatus(input));
  }

  reserveAutomation(input: AutomationEmailRouteInput) {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).reserveAutomationInGlobalRegistry(input));
  }

  reserveAutomations(inputs: AutomationEmailRouteInput[]) {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).reserveAutomationsInGlobalRegistry(inputs));
  }

  activateAutomations(inputs: AutomationEmailRouteInput[]) {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).activateAutomationsInGlobalRegistry(inputs));
  }

  setAutomationStatuses(inputs: AutomationEmailRouteStatusInput[]) {
    return rpcResult(() => new WorkstreamEmailRoutingService(this.env).setAutomationStatusesInGlobalRegistry(inputs));
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
