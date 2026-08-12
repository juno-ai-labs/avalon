const WORKSTREAM_MAX_MODEL_ITERATIONS = 1_000;
const HYPERSIGHT_RUN_LIMITS = {
  maxIterations: 8,
  maxToolCalls: 24,
  maxWallClockMs: 240_000,
  maxCostCents: 500,
} as const;

export function workstreamRunLimits(hyperSightRun: boolean) {
  return hyperSightRun
    ? HYPERSIGHT_RUN_LIMITS
    : { maxIterations: WORKSTREAM_MAX_MODEL_ITERATIONS } as const;
}

/**
 * Cloudflare Workflows supplies a ten-minute timeout when a step omits one and
 * has no "disabled" timeout value. A one-year ordinary-run deadline removes a
 * task-scale cutoff while staying within Cloudflare's documented Workflow
 * duration vocabulary. HyperSight keeps one minute of host cleanup headroom
 * beyond its four-minute harness deadline.
 */
export function workstreamWorkflowStepTimeout(hyperSightRun: boolean) {
  return hyperSightRun ? "5 minutes" as const : "1 year" as const;
}
