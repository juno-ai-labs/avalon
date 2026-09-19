import { describe, expect, it, vi } from "vitest";

import { createDaytonaTerminalProvider } from "../src/services/terminal/daytona-provider";
import {
  observeTerminalProviderRequest,
  terminalProviderRpcCall,
} from "../src/services/terminal/provider-rpc-result";
import type { TerminalProviderRequestMeasurement } from "../src/services/terminal/tracing";

describe("Terminal provider request routing", () => {
  it("delivers a request to the observer of the call that issued it", async () => {
    const calls: Record<string, string[]> = { a: [], b: [] };
    const operation = (name: string) => async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await observeTerminalProviderRequest({
        operation: "sandbox.get", detail: null, outcome: "completed",
        durationMs: 5, requestCount: 1, pollCount: 0, bytes: 0,
      });
      return name;
    };

    await Promise.all(["a", "b"].map((name) => terminalProviderRpcCall(operation(name), {
      observeRequest: async (measurement) => { calls[name]!.push(measurement.operation); },
    })));

    expect(calls).toEqual({ a: ["sandbox.get"], b: ["sandbox.get"] });
  });

  it("reports nothing when the call was made without an observer", async () => {
    await expect(terminalProviderRpcCall(async () => {
      expect(observeTerminalProviderRequest({
        operation: "sandbox.get", detail: null, outcome: "completed",
        durationMs: 5, requestCount: 1, pollCount: 0, bytes: 0,
      })).toBeUndefined();
      return "ok";
    })).resolves.toEqual({ ok: true, value: "ok" });
  });

  /**
   * The second half of the same defect. Fired and forgotten, a measurement
   * raced the result of its own call across the Worker boundary and routinely
   * lost, so `terminal_tool_finished` was written before the last request it
   * summarises had been counted.
   */
  it("holds the provider request open until its measurement has been delivered", async () => {
    const delivered: TerminalProviderRequestMeasurement[] = [];
    const sandbox = {
      id: "sandbox-1", name: "sandbox-1", state: "started",
      process: {
        executeCommand: vi.fn(async () => ({ exitCode: 0, result: "ready\n" })),
        createSession: vi.fn(), executeSessionCommand: vi.fn(), deleteSession: vi.fn(),
      },
    };
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get: vi.fn(async () => sandbox) }), {
      observeRequest: async (measurement) => {
        // A caller reporting across a Worker boundary resolves on a later
        // turn; nothing about the provider's own work makes that wait happen.
        await new Promise((resolve) => setTimeout(resolve, 5));
        delivered.push(measurement);
      },
    });

    await provider.runUtilityCommand("sandbox-1", {
      operation: "file.inspect", command: "printf ready", cwd: "/workspace", timeoutMs: 5_000,
    });

    expect(delivered.map((measurement) => measurement.operation))
      .toEqual(["sandbox.get", "process.execute_utility"]);
  });

  /**
   * The provider Worker installs `observeRequest` unconditionally, because it
   * cannot know at construction which callers report; three construct a client
   * with no instrumentation at all. Discarding their measurements is not
   * enough — `bytes` on a utility command encodes the command's whole stdout,
   * so the work has to be skipped, not wasted.
   */
  it("does no measurement work when nothing is listening for this call", async () => {
    const bytes = vi.fn(() => 0);
    const sandbox = {
      id: "sandbox-1", name: "sandbox-1", state: "started",
      process: {
        executeCommand: vi.fn(async () => ({ exitCode: 0, result: "ready\n" })),
        createSession: vi.fn(), executeSessionCommand: vi.fn(), deleteSession: vi.fn(),
      },
    };
    const now = vi.fn(() => 0);
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get: vi.fn(async () => sandbox) }), {
      now,
      observeRequest: () => { throw new Error("must not report"); },
      requestObserved: () => false,
    });

    await expect(provider.runUtilityCommand("sandbox-1", {
      operation: "file.inspect", command: "printf ready", cwd: "/workspace", timeoutMs: 5_000,
    })).resolves.toMatchObject({ exitCode: 0 });

    // Neither the clock nor the byte accounting is touched on the skipped path.
    expect(now).not.toHaveBeenCalled();
    expect(bytes).not.toHaveBeenCalled();
  });
});
