import type { HarnessOutcome } from "@rally/agent-harness";
import { z } from "zod";

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
 * double11 detailed_timing_available (1 when turns/model/tool timing is exact)
 */
const RUN_ANALYTICS_SCHEMA_VERSION = "harness_run_v1";

export const HarnessRunMetricsSchema = z.object({
  model: z.string().nullable(),
  durationMs: z.number(),
  turns: z.number(),
  iterations: z.number(),
  toolCalls: z.number(),
  modelTimeMs: z.number(),
  toolTimeMs: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costCents: z.number(),
  outputTokensPerSecond: z.number(),
  detailedTimingAvailable: z.boolean(),
});

export type HarnessRunMetrics = z.infer<typeof HarnessRunMetricsSchema>;

interface HarnessRunObservation {
  workspaceId: string;
  workstreamId: string;
  harnessRunId: string;
  source: "workstream";
  status: "completed" | "needs_input" | "failed" | "stopped";
  failureCode?: string;
  metrics: HarnessRunMetrics;
}

export function summarizeHarnessRun(outcome: HarnessOutcome, durationMs: number): HarnessRunMetrics {
  // Bind returns exact runToolLoop timing on its normal result paths. A thrown
  // failed/stopped path retains counters in ToolLoopState but currently has no
  // result.stats object, so outcome() fills the detailed timing fields with
  // zero. Mark those values unavailable instead of presenting them as measured
  // zeros. End-to-end duration, routed attempts, calls, tokens, and cost still
  // come from independently accumulated state and remain valid.
  const detailedTimingAvailable = outcome.status === "completed" || outcome.status === "needs_input";
  return {
    model: outcome.model,
    durationMs: finiteNonNegative(durationMs),
    turns: detailedTimingAvailable ? finiteNonNegative(outcome.stats.turns) : 0,
    iterations: finiteNonNegative(outcome.iterations),
    toolCalls: finiteNonNegative(outcome.stats.toolCalls),
    modelTimeMs: detailedTimingAvailable ? finiteNonNegative(outcome.stats.modelTimeMs) : 0,
    toolTimeMs: detailedTimingAvailable ? finiteNonNegative(outcome.stats.toolTimeMs) : 0,
    inputTokens: finiteNonNegative(outcome.stats.inputTokens),
    outputTokens: finiteNonNegative(outcome.stats.outputTokens),
    costCents: finiteNonNegative(outcome.usage.cost_cents ?? 0),
    outputTokensPerSecond: detailedTimingAvailable
      ? finiteNonNegative(outcome.stats.outputTokensPerSecond ?? 0)
      : 0,
    detailedTimingAvailable,
  };
}

export function recordHarnessRunObservation(
  env: Pick<Env, "RUN_ANALYTICS" | "LOG_LEVEL" | "AVALON_REGION" | "APP_VERSION" | "BUILD_SHA">,
  observation: HarnessRunObservation,
): void {
  const { metrics } = observation;
  const fields = {
    request_id: observation.harnessRunId,
    workspace_id: observation.workspaceId,
    workstream_id: observation.workstreamId,
    source: observation.source,
    status: observation.status,
    model: metrics.model,
    ...(observation.failureCode ? { code: observation.failureCode } : {}),
    duration_ms: metrics.durationMs,
    iterations: metrics.iterations,
    tool_calls: metrics.toolCalls,
    input_tokens: metrics.inputTokens,
    output_tokens: metrics.outputTokens,
    cost_cents: metrics.costCents,
    detailed_timing_available: metrics.detailedTimingAvailable,
    ...(metrics.detailedTimingAvailable
      ? {
          turns: metrics.turns,
          model_time_ms: metrics.modelTimeMs,
          tool_time_ms: metrics.toolTimeMs,
          output_tokens_per_second: metrics.outputTokensPerSecond,
        }
      : {}),
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
        metrics.model ?? "unknown",
        observation.failureCode ?? "none",
        env.AVALON_REGION,
        env.APP_VERSION ?? "unknown",
        env.BUILD_SHA ?? "unknown",
      ],
      doubles: [
        fields.duration_ms,
        metrics.turns,
        fields.tool_calls,
        metrics.modelTimeMs,
        metrics.toolTimeMs,
        fields.input_tokens,
        fields.output_tokens,
        fields.cost_cents,
        fields.iterations,
        metrics.outputTokensPerSecond,
        metrics.detailedTimingAvailable ? 1 : 0,
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
