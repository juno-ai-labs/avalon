import { describe, expect, it } from "vitest";

import {
  createTerminalToolTrace,
  currentTerminalToolTrace,
  recordTerminalAcquisition,
  recordTerminalProviderRequest,
  withTerminalToolTrace,
} from "../src/services/terminal/tracing";

describe("Terminal tool tracing", () => {
  it("aggregates request, poll, byte, and acquisition measurements in async tool scope", async () => {
    const trace = createTerminalToolTrace({
      toolName: "run_command",
      toolCallId: "call-1",
      toolInvocationId: "receipt-1",
    });

    await withTerminalToolTrace(trace, async () => {
      await Promise.resolve();
      expect(currentTerminalToolTrace()).toBe(trace);
      recordTerminalAcquisition({ durationMs: 17, cacheHit: false });
      recordTerminalProviderRequest({
        operation: "process.session_poll",
        detail: null,
        outcome: "completed",
        durationMs: 23,
        requestCount: 1,
        pollCount: 1,
        bytes: 0,
      });
      recordTerminalProviderRequest({
        operation: "file.upload",
        detail: null,
        outcome: "completed",
        durationMs: 31,
        requestCount: 1,
        pollCount: 0,
        bytes: 4096,
      });
    });

    expect(trace).toEqual({
      toolName: "run_command",
      toolCallId: "call-1",
      toolInvocationId: "receipt-1",
      providerDurationMs: 54,
      providerRequestCount: 2,
      providerPollCount: 1,
      providerBytes: 4096,
      providerOperationCount: 2,
      acquisitionDurationMs: 17,
      acquisitionCacheHit: false,
    });
    expect(currentTerminalToolTrace()).toBeUndefined();
  });
});
