import {
  type Exhaustive,
  objectPortRequestSchema,
  operationGuard,
  type ObjectPortOf,
} from "./object-port-protocol";
import type { WorkstreamResidentContextStorage } from "./workstream-resident-context-storage";
import type { z } from "zod";
import { deferredZodSchema } from "@rally/contracts/deferred-zod-schema";

/**
 * The wire contract a producer of resident context blocks uses.
 *
 * Only the operations a *producer* needs cross this port: what is resident,
 * recording a load, and invalidating a source. Delivery, rendering, and the
 * compaction transitions are the conversation object's own business and are
 * called on the storage directly, inside the transactions they belong to.
 */
export type ResidentContextOperation = keyof Pick<
  WorkstreamResidentContextStorage,
  "residentBlocks" | "recordLoaded" | "invalidateKind"
>;

export type ResidentContextObjectPort = ObjectPortOf<
  WorkstreamResidentContextStorage,
  ResidentContextOperation
>;

const DISPATCHED_OPERATIONS = [
  "residentBlocks",
  "recordLoaded",
  "invalidateKind",
] as const satisfies readonly ResidentContextOperation[];

/** Every operation the endpoint will dispatch, proven complete both ways. */
export const RESIDENT_CONTEXT_OPERATIONS:
  Exhaustive<ResidentContextOperation, typeof DISPATCHED_OPERATIONS> = DISPATCHED_OPERATIONS;

export const isResidentContextOperation = operationGuard(RESIDENT_CONTEXT_OPERATIONS);

export const ResidentContextOperationRequestSchema = deferredZodSchema(() => objectPortRequestSchema(
  isResidentContextOperation,
  "unknown_resident_context_operation",
));

export type ResidentContextOperationRequest = z.infer<typeof ResidentContextOperationRequestSchema>;
