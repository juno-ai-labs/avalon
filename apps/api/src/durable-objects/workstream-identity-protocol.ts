import type { z } from "zod";

import {
  type Exhaustive,
  objectPortRequestSchema,
  operationGuard,
  type ObjectPortOf,
} from "./object-port-protocol";
import type { WorkstreamIdentityStorage } from "./workstream-identity-storage";

/**
 * The wire contract for what one work stream *is* and who is on it.
 *
 * The same three layers as the five authorities before it. What is specific
 * here is that this authority is the one every other slice's callers also
 * touched: `workstreams` was the table a routed statement joined against to
 * check an archive gate, read a title, or find a creator, and the retired
 * `_runtime_workstreams` view was the widest of the compatibility views for
 * exactly that reason.
 */
export type IdentityOperation = keyof WorkstreamIdentityStorage;

export type IdentityObjectPort = ObjectPortOf<WorkstreamIdentityStorage>;

const DISPATCHED_OPERATIONS = [
  "identity",
  "participants",
  "provision",
] as const satisfies readonly IdentityOperation[];

/** Every operation the endpoint will dispatch, proven complete both ways. */
export const IDENTITY_OPERATIONS:
  Exhaustive<IdentityOperation, typeof DISPATCHED_OPERATIONS> = DISPATCHED_OPERATIONS;

/**
 * The operations that change what the work stream is.
 *
 * A provision is what makes a system-created work stream appear in a sidebar,
 * so it commits its directory projection with the row. Named here rather than
 * tested for at the endpoint, for the reason the scheduling protocol gives.
 */
const IDENTITY_WRITES = new Set<IdentityOperation>(["provision"]);

export function mutatesIdentity(operation: IdentityOperation): boolean {
  return IDENTITY_WRITES.has(operation);
}

export const isIdentityOperation = operationGuard(IDENTITY_OPERATIONS);

export const IdentityOperationRequestSchema = objectPortRequestSchema(
  isIdentityOperation,
  "unknown_identity_operation",
);

export type IdentityOperationRequest = z.infer<typeof IdentityOperationRequestSchema>;
