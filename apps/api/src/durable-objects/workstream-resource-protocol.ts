import {
  type Exhaustive,
  objectPortRequestSchema,
  operationGuard,
  type ObjectPortOf,
} from "./object-port-protocol";
import type { WorkstreamResourceStorage } from "./workstream-resource-storage";
import type { z } from "zod";
import { deferredZodSchema } from "@rally/contracts/deferred-zod-schema";

/**
 * The wire contract for one work stream's resource attachments.
 *
 * The same three layers as the four authorities before it. What is specific
 * here is how little of the "resources slice" reaches this port: the workspace
 * owns `resources` and the object owns the *link*, and the retired
 * `_runtime_resources` view existed only to let a routed statement join the two
 * as though they were one table.
 */
export type ResourceOperation = keyof WorkstreamResourceStorage;

export type ResourceObjectPort = ObjectPortOf<WorkstreamResourceStorage>;

const DISPATCHED_OPERATIONS = [
  "readAuthorizationFacts",
  "attachedLinks",
  "attachedResourceIds",
  "isAttached",
  "resourceIdsOnMessages",
  "setWatchEnabled",
  "inventoryRevision",
  "inheritanceContext",
] as const satisfies readonly ResourceOperation[];

/** Every operation the endpoint will dispatch, proven complete both ways. */
export const RESOURCE_OPERATIONS:
  Exhaustive<ResourceOperation, typeof DISPATCHED_OPERATIONS> = DISPATCHED_OPERATIONS;

/**
 * The operations that change what the work stream has attached.
 *
 * Only the watch toggle, which the sidebar renders. Named here rather than
 * tested for at the endpoint, for the reason the scheduling protocol gives: an
 * operation added to the storage class without a place in this set is visible
 * next to the list it belongs beside.
 */
const INVENTORY_WRITES = new Set<ResourceOperation>(["setWatchEnabled"]);

export function mutatesInventory(operation: ResourceOperation): boolean {
  return INVENTORY_WRITES.has(operation);
}

export const isResourceOperation = operationGuard(RESOURCE_OPERATIONS);

export const ResourceOperationRequestSchema = deferredZodSchema(() => objectPortRequestSchema(
  isResourceOperation,
  "unknown_resource_operation",
));

export type ResourceOperationRequest = z.infer<typeof ResourceOperationRequestSchema>;
