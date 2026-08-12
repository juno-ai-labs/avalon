import type { HarnessOutcome } from "@avalon/agent-harness";

import type { Env } from "../env";
import { logStructuredEvent } from "./logger";

/**
 * `RUN_ANALYTICS` is an ordered Workers Analytics Engine dataset. Keep this map
 * next to the write: the runtime API accepts positional arrays rather than
 * named columns, so reordering a field silently changes every SQL query.
 *
 * index1  source:region (the Analytics Engine sampling key)
 * blob1   schema_version
 * blob2   source
 * blob3   terminal_status
 * blob4   model
 * blob5   failure_code
 * blob6   region
 * blob7   app_version
 * blob8   build_sha
 * double1 duration_ms
 * double2 turns
 * double3 tool_calls
 * double4 model_time_ms
 * double5 tool_time_ms
 * double6 input_tokens
 * double7 output_tokens
 * double8 cost_cents
 * double9 iterations (includes routed retries)
 * double10 output_tokens_per_second
 */
const RUN_ANALYTICS_SCHEMA_VERSION = "harness_run_v1";

interface HarnessRunObservation {
  workspaceId: string;
  workstreamId: string;
  harnessRunId: string;
  source: "workstream" | "hypersight";
  status: "completed" | "needs_input" | "failed" | "stopped";
  failureCode?: string;
  durationMs: number;
  outcome: HarnessOutcome;
}

export function recordHarnessRunObservation(
  env: Pick<Env, "RUN_ANALYTICS" | "LOG_LEVEL" | "AVALON_REGION" | "APP_VERSION" | "BUILD_SHA">,
  observation: HarnessRunObservation,
): void {
  const fields = {
    request_id: observation.harnessRunId,
    workspace_id: observation.workspaceId,
    workstream_id: observation.workstreamId,
    source: observation.source,
    status: observation.status,
    model: observation.outcome.model,
    ...(observation.failureCode ? { code: observation.failureCode } : {}),
    duration_ms: finiteNonNegative(observation.durationMs),
    turns: finiteNonNegative(observation.outcome.stats.turns),
    iterations: finiteNonNegative(observation.outcome.iterations),
    tool_calls: finiteNonNegative(observation.outcome.stats.toolCalls),
    model_time_ms: finiteNonNegative(observation.outcome.stats.modelTimeMs),
    tool_time_ms: finiteNonNegative(observation.outcome.stats.toolTimeMs),
    input_tokens: finiteNonNegative(observation.outcome.stats.inputTokens),
    output_tokens: finiteNonNegative(observation.outcome.stats.outputTokens),
    cost_cents: finiteNonNegative(observation.outcome.usage.cost_cents ?? 0),
    output_tokens_per_second: finiteNonNegative(observation.outcome.stats.outputTokensPerSecond ?? 0),
  };

  // Workers Logs is the correlated diagnostic row; it reaches the existing
  // regional 90-day Logpush export as well as the seven-day dashboard index.
  logStructuredEvent(env, "info", "harness_run_finished", fields);

  try {
    // Analytics Engine is the aggregate/time-series copy. The write is
    // non-blocking in the Workers runtime and contains no prompt, transcript,
    // tool input/output, connector content, or user-authored text.
    env.RUN_ANALYTICS.writeDataPoint({
      // Source and region are the dimensions operators will most often query
      // while tuning a caller's run policy. Do not use the run UUID here:
      // Analytics Engine samples per index, and its documentation explicitly
      // warns that a unique index per row harms aggregate/time-series reads.
      indexes: [`${observation.source}:${env.AVALON_REGION}`],
      blobs: [
        RUN_ANALYTICS_SCHEMA_VERSION,
        observation.source,
        observation.status,
        observation.outcome.model ?? "unknown",
        observation.failureCode ?? "none",
        env.AVALON_REGION,
        env.APP_VERSION ?? "unknown",
        env.BUILD_SHA ?? "unknown",
      ],
      doubles: [
        fields.duration_ms,
        fields.turns,
        fields.tool_calls,
        fields.model_time_ms,
        fields.tool_time_ms,
        fields.input_tokens,
        fields.output_tokens,
        fields.cost_cents,
        fields.iterations,
        fields.output_tokens_per_second,
      ],
    });
  } catch (error) {
    // Telemetry can never change the durable terminal outcome.
    logStructuredEvent(env, "warn", "harness_run_analytics_failed", {
      request_id: observation.harnessRunId,
      workspace_id: observation.workspaceId,
      workstream_id: observation.workstreamId,
      source: observation.source,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
