import type { HarnessOutcome } from "@rally/agent-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import {
  recordHarnessRunObservation,
  summarizeHarnessRun,
} from "../src/observability/harness-run-observability";
import { createTestEnv } from "./helpers/cloudflare-test";

const outcome: HarnessOutcome = {
  status: "completed",
  content: "not logged",
  model: "provider/model",
  iterations: 7,
  toolCalls: 5,
  usage: {
    input_tokens: 1_200,
    output_tokens: 340,
    cost_cents: 45.5,
  },
  stats: {
    turns: 4,
    toolCalls: 5,
    inputTokens: 1_200,
    outputTokens: 340,
    modelTimeMs: 12_000,
    toolTimeMs: 8_000,
    outputTokensPerSecond: 28.3,
    toolTimeBreakdownMs: { github_fetch: 8_000 },
  },
};

function observationEnv(writeDataPoint: AnalyticsEngineDataset["writeDataPoint"]): Env {
  return createTestEnv({
    RUN_ANALYTICS: { writeDataPoint },
    LOG_LEVEL: "info",
    AVALON_REGION: "eu",
    APP_VERSION: "1.2.3",
    BUILD_SHA: "abc123",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("harness run observability", () => {
  it("writes one terminal summary with a stable positional schema", () => {
    const writeDataPoint = vi.fn();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    recordHarnessRunObservation(observationEnv(writeDataPoint), {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      workstreamId: "00000000-0000-4000-8000-000000000002",
      harnessRunId: "00000000-0000-4000-8000-000000000003",
      source: "workstream",
      status: "completed",
      metrics: summarizeHarnessRun(outcome, 21_000),
    });

    expect(writeDataPoint).toHaveBeenCalledOnce();
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ["workstream:eu"],
      blobs: [
        "harness_run_v1",
        "workstream",
        "completed",
        "provider/model",
        "none",
        "eu",
        "1.2.3",
        "abc123",
      ],
      doubles: [21_000, 4, 5, 12_000, 8_000, 1_200, 340, 45.5, 7, 28.3, 1],
    });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "harness_run_finished",
      request_id: "00000000-0000-4000-8000-000000000003",
      source: "workstream",
      duration_ms: 21_000,
      tool_calls: 5,
      detailed_timing_available: true,
    }));
    expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain("not logged");
    expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain("github_fetch");
  });

  it("marks detailed timing unavailable on Bind failure paths", () => {
    const writeDataPoint = vi.fn();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const failedOutcome: HarnessOutcome = { ...outcome, status: "failed" };
    const metrics = summarizeHarnessRun(failedOutcome, 21_000);

    expect(metrics).toEqual(expect.objectContaining({
      durationMs: 21_000,
      iterations: 7,
      toolCalls: 5,
      inputTokens: 1_200,
      outputTokens: 340,
      costCents: 45.5,
      turns: 0,
      modelTimeMs: 0,
      toolTimeMs: 0,
      outputTokensPerSecond: 0,
      detailedTimingAvailable: false,
    }));

    recordHarnessRunObservation(observationEnv(writeDataPoint), {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      workstreamId: "00000000-0000-4000-8000-000000000002",
      harnessRunId: "00000000-0000-4000-8000-000000000003",
      source: "workstream",
      status: "failed",
      failureCode: "run_iteration_limit_exceeded",
      metrics,
    });

    expect(writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({
      doubles: [21_000, 0, 5, 0, 0, 1_200, 340, 45.5, 7, 0, 0],
    }));
    const logEntry = info.mock.calls[0]?.[0];
    expect(logEntry).toEqual(expect.objectContaining({
      event: "harness_run_finished",
      duration_ms: 21_000,
      tool_calls: 5,
      detailed_timing_available: false,
    }));
    expect(logEntry).not.toHaveProperty("turns");
    expect(logEntry).not.toHaveProperty("model_time_ms");
    expect(logEntry).not.toHaveProperty("tool_time_ms");
  });

  it("does not let an analytics binding failure change the run outcome", () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const writeDataPoint = vi.fn(() => {
      throw new Error("binding unavailable");
    });

    expect(() => recordHarnessRunObservation(observationEnv(writeDataPoint), {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      workstreamId: "00000000-0000-4000-8000-000000000002",
      harnessRunId: "00000000-0000-4000-8000-000000000003",
      source: "workstream",
      status: "failed",
      failureCode: "provider_error",
      metrics: summarizeHarnessRun({ ...outcome, status: "failed" }, Number.POSITIVE_INFINITY),
    })).not.toThrow();

    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "harness_run_analytics_failed",
      error_name: "Error",
    }));
  });
});
