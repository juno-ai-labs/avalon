const WORKSTREAM_MAX_MODEL_ITERATIONS = 1_000;

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
