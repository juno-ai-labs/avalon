import {
  type Exhaustive,
  objectPortRequestSchema,
  operationGuard,
  type ObjectPortOf,
} from "./object-port-protocol";
import type { WorkstreamBlockDashboardStorage } from "./workstream-block-dashboard-storage";
import type { z } from "zod";

/**
 * The wire contract for one work stream's HyperSight block state.
 *
 * Block rows are object-local, but the three writers — the harness runtime, the
 * integrations service, and `BlockDashboardAgent` itself — all run in the
 * Worker. This endpoint is how they reach them. It replaces a routed
 * `D1Database` handle carrying D1-shaped SQL against
 * `_runtime_block_dashboard_runs`, and it replaces a fence-restated-per-write
 * with a fence read once inside the transaction that writes.
 */
export type BlockDashboardOperation = keyof WorkstreamBlockDashboardStorage;

export type BlockDashboardObjectPort = ObjectPortOf<WorkstreamBlockDashboardStorage>;

const DISPATCHED_OPERATIONS = [
  "admitDispatch",
  "blockRun",
  "blockRunForHarnessRun",
  "hasPersistedResult",
  "latestConfigurationVersionId",
  "submitMarkdown",
  "settleBlockRun",
  "recordBlockRunProgress",
  "abandonBlockRun",
] as const satisfies readonly BlockDashboardOperation[];

/** Every operation the endpoint will dispatch, proven complete both ways. */
export const BLOCK_DASHBOARD_OPERATIONS:
  Exhaustive<BlockDashboardOperation, typeof DISPATCHED_OPERATIONS> = DISPATCHED_OPERATIONS;

export const isBlockDashboardOperation = operationGuard(BLOCK_DASHBOARD_OPERATIONS);

export const BlockDashboardOperationRequestSchema = objectPortRequestSchema(
  isBlockDashboardOperation,
  "unknown_block_dashboard_operation",
);

export type BlockDashboardOperationRequest = z.infer<typeof BlockDashboardOperationRequestSchema>;
