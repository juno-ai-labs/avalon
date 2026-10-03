const WORKSTREAM_MAX_MODEL_ITERATIONS = 1_000;

/**
 * LIMIT UNSET — open until the team chooses an import-run lifetime.
 * Bounds a browser import whose desktop disappears without answering or cancelling.
 * Root runs otherwise have no wall clock and keep renewing their execution lease.
 * Direction: upper bound; open value +Infinity creates no timer and is not serialized.
 * Trips: the run ends with run_wall_time_limit_exceeded; existing profile cleanup
 * retires only unopened reservations, preserving already committed Channels.
 * Derive from: allowed import/reconnect time, rather than ordinary tool latency.
 */
export const MAX_SESSION_IMPORT_RUN_MS = Number.POSITIVE_INFINITY;

export function workstreamRunLimits(maxWallClockMs = Number.POSITIVE_INFINITY, elapsedMs = 0) {
  return {
    maxIterations: WORKSTREAM_MAX_MODEL_ITERATIONS,
    ...(Number.isFinite(maxWallClockMs) ? { maxWallClockMs: Math.max(0, maxWallClockMs - elapsedMs) } : {}),
  };
}

/**
 * Cloudflare Workflows supplies a ten-minute timeout when a step omits one and
 * has no "disabled" timeout value. A one-year root-run deadline removes a
 * task-scale cutoff while staying within Cloudflare's documented Workflow
 * duration vocabulary.
 */
export function workstreamWorkflowStepTimeout() {
  return "1 year" as const;
}
