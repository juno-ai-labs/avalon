import "../../../tests/isolated-region";
import { describe, expect, it, vi } from "vitest";

import { recordTerminalPlatformObservation } from "../src/observability/terminal-platform-observability";
import { createTestEnv } from "./helpers/cloudflare-test";

describe("Terminal platform observability", () => {
  it("writes a fixed aggregate-only Analytics Engine point", () => {
    const writeDataPoint = vi.fn();
    const env = createTestEnv({
      TERMINAL_ANALYTICS: { writeDataPoint },
      LOG_LEVEL: "error",
      AVALON_REGION: "global",
      APP_VERSION: "1.100.0",
      BUILD_SHA: "abc123",
    });

    recordTerminalPlatformObservation(env, {
      operation: "sandbox_bootstrap",
      outcome: "completed",
      snapshot: "daytona-small",
      sourceState: "running",
      failurePhase: "none",
      durationMs: 12_000,
      providerCreateMs: 0,
      policyReadbackMs: 500,
      installMs: 10_000,
      verifyMs: 1_500,
      installedCapabilities: ["sqlite3", "gh", "pnpm"],
    });

    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ["terminal:global"],
      blobs: [
        "terminal_platform_v1", "sandbox_bootstrap", "completed", "global",
        "daytona-small", "running", "none", "gh,pnpm,sqlite3", "1.100.0", "abc123",
      ],
      doubles: [12_000, 0, 500, 10_000, 1_500, 3],
    });
  });

  it("never lets an Analytics Engine write failure change sandbox behavior", () => {
    const env = createTestEnv({
      TERMINAL_ANALYTICS: { writeDataPoint: vi.fn(() => { throw new Error("unavailable"); }) },
      LOG_LEVEL: "error",
      AVALON_REGION: "enterprise",
    });

    expect(() => recordTerminalPlatformObservation(env, {
      operation: "sandbox_start", outcome: "failed", snapshot: "daytona-small",
      sourceState: "archived", failurePhase: "start", durationMs: 3_000,
      providerCreateMs: 0, policyReadbackMs: 0, installMs: 0, verifyMs: 0,
      installedCapabilities: [],
    })).not.toThrow();
  });
});
