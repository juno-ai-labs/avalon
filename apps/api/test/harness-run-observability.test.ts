import type { HarnessOutcome } from "@avalon/agent-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { recordHarnessRunObservation } from "../src/observability/harness-run-observability";

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

function observationEnv(writeDataPoint: ReturnType<typeof vi.fn>): Env {
  return {
    RUN_ANALYTICS: { writeDataPoint },
    LOG_LEVEL: "info",
    AVALON_REGION: "eu",
    APP_VERSION: "1.2.3",
    BUILD_SHA: "abc123",
  } as unknown as Env;
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
      source: "hypersight",
      status: "completed",
      durationMs: 21_000,
      outcome,
    });

    expect(writeDataPoint).toHaveBeenCalledOnce();
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ["hypersight:eu"],
      blobs: [
        "harness_run_v1",
        "hypersight",
        "completed",
        "provider/model",
        "none",
        "eu",
        "1.2.3",
        "abc123",
      ],
      doubles: [21_000, 4, 5, 12_000, 8_000, 1_200, 340, 45.5, 7, 28.3],
    });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "harness_run_finished",
      request_id: "00000000-0000-4000-8000-000000000003",
      source: "hypersight",
      duration_ms: 21_000,
      tool_calls: 5,
    }));
    expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain("not logged");
    expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain("github_fetch");
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
      durationMs: Number.POSITIVE_INFINITY,
      outcome: { ...outcome, status: "failed" },
    })).not.toThrow();

    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "harness_run_analytics_failed",
      error_name: "Error",
    }));
  });
});
