const WORKSTREAM_MAX_MODEL_ITERATIONS = 1_000;

/**
 * A run's limits: its model iterations only. Root runs have no wall clock and
 * keep renewing their execution lease; the one run-wide wall clock, for a
 * browser import, retired with session import.
 */
export function workstreamRunLimits(): { maxIterations: number } {
  return { maxIterations: WORKSTREAM_MAX_MODEL_ITERATIONS };
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
