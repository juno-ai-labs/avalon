import type { z } from "zod";
import { deferredZodSchema } from "@rally/contracts/deferred-zod-schema";

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
  "readAuthorizationFacts",
  "identity",
  "participants",
  "provision",
  "archiveSystemWorkstream",
  "archiveScheduledWorkstream",
  "adoptEmailAddress",
  "rename",
  "recolor",
  "redescribe",
  "admitParticipant",
  "adoptCreator",
  "seedFromFixture",
] as const satisfies readonly IdentityOperation[];

/** Every operation the endpoint will dispatch, proven complete both ways. */
export const IDENTITY_OPERATIONS:
  Exhaustive<IdentityOperation, typeof DISPATCHED_OPERATIONS> = DISPATCHED_OPERATIONS;

/**
 * The operations that change what the work stream is.
 *
 * Every one of them changes something a sidebar renders — whether the work
 * stream is listed at all, its name, its description, its state, who is on it
 * — so each commits its directory projection with the row it writes. A write
 * whose projection is a second commit can be applied and never shown. Named
 * here rather than tested for at the endpoint, for the reason the scheduling
 * protocol gives.
 */
const IDENTITY_WRITES = new Set<IdentityOperation>([
  "provision",
  "archiveSystemWorkstream",
  "archiveScheduledWorkstream",
  "adoptEmailAddress",
  "rename",
  "recolor",
  "redescribe",
  "admitParticipant",
  "adoptCreator",
  "seedFromFixture",
]);

export function mutatesIdentity(operation: IdentityOperation): boolean {
  return IDENTITY_WRITES.has(operation);
}

export const isIdentityOperation = operationGuard(IDENTITY_OPERATIONS);

export const IdentityOperationRequestSchema = deferredZodSchema(() => objectPortRequestSchema(
  isIdentityOperation,
  "unknown_identity_operation",
));

export type IdentityOperationRequest = z.infer<typeof IdentityOperationRequestSchema>;
