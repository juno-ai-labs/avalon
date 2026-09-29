import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { createTerminalProviderRpcClient } from "../src/services/terminal/provider-rpc-client";
import type { SupportedTerminalConfiguration } from "../src/services/terminal/provider-rpc-contract";
import {
  createTerminalToolTrace,
  currentTerminalToolTrace,
  recordTerminalProviderRequest,
  withTerminalToolTrace,
  type TerminalProviderRequestMeasurement,
} from "../src/services/terminal/tracing";

const CONFIGURATION: SupportedTerminalConfiguration = {
  capability: "supported",
  apiKey: "secret",
  apiUrl: "https://app.daytona.io/api",
  target: "us",
  snapshot: "snapshot",
  emergencyDisabled: false,
};

describe("Terminal provider Service Binding RPC protocol", () => {
  const binding = env.TERMINAL_RPC_TEST;
  if (!binding) throw new Error("TERMINAL_RPC_TEST binding is unavailable");

  it("does not depend on custom Error properties crossing the Worker boundary", async () => {
    const error = await binding.throwNotFound().catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "sandbox missing" });
    expect(Object.hasOwn(error, "status")).toBe(false);

    await expect(binding.returnNotFound()).resolves.toEqual({
      ok: false,
      error: { kind: "not_found", message: "sandbox missing" },
    });
  });

  it("carries a typed Terminal callback refusal by value", async () => {
    await expect(binding.invokeCallback(async () => ({
      ok: false,
      error: {
        kind: "terminal_tool",
        code: "command_recovery_unavailable",
        message: "submission authority expired",
      },
    }))).resolves.toEqual({
      ok: false,
      error: {
        kind: "terminal_tool",
        code: "command_recovery_unavailable",
        message: "submission authority expired",
      },
    });
  });

  it("retains one RpcTarget session across multiple provider calls", async () => {
    const session = await binding.createCounterSession();
    try {
      await expect(session.next()).resolves.toBe(1);
      await expect(session.next()).resolves.toBe(2);
    } finally {
      session[Symbol.dispose]();
    }
  });

  /**
   * An undisposed session keeps its invocation open in the provider Worker,
   * and a caller in a Durable Object never ends the context that would dispose
   * it; that is what ran the provider Worker out of memory. Local workerd does
   * not run the target's own disposer in this harness, so this pins the half
   * that is ours: the real stub the client was handed is disposed.
   */
  it("disposes the real session stub when the client is disposed", async () => {
    let session: Awaited<ReturnType<typeof binding.createSession>> | undefined;
    const provider = createTerminalProviderRpcClient({
      createSession: async (configuration, instrumentation) => {
        session = await binding.createSession(configuration, instrumentation);
        return session;
      },
    }, CONFIGURATION);

    await provider.getSandbox("sandbox-a");
    await provider.getSandbox("sandbox-b");
    await expect(session?.sessionObservations()).resolves.toMatchObject({ installed: false });

    provider[Symbol.dispose]();
    // Disposal runs once the last call settles, inside this isolate. Five
    // seconds leaves room on a loaded runner and stays under the test's 30.
    await vi.waitFor(async () => {
      const refused = await Promise.resolve()
        .then(() => session?.sessionObservations())
        .then(() => null, (error: unknown) => error);
      expect(refused).toMatchObject({ message: expect.stringMatching(/disposed/) });
    }, { timeout: 5_000 });
  });

  it("carries a start deadline across the Worker boundary in the position the session reads", async () => {
    // Every other test of this doubles the RPC client in-process, which cannot
    // see an argument-position skew: a deadline landing in the wrong slot comes
    // back `undefined`, the adapter falls to the SDK's own default, and nothing
    // in the repository fails. That is precisely the censored-restore bug this
    // change exists to remove, so it is proved here against real workerd.
    const echoed: unknown[] = [];
    const provider = createTerminalProviderRpcClient(
      {
        createSession: async () => {
          const session = await binding.createSession();
          return {
            startSandbox: async (idOrName: string, options?: unknown, callbacks?: unknown) => {
              const value = await session.startSandbox(idOrName, options, callbacks);
              echoed.push(value);
              return value;
            },
            recoverSandbox: async (idOrName: string, options?: unknown, callbacks?: unknown) => {
              const value = await session.recoverSandbox(idOrName, options, callbacks);
              echoed.push(value);
              return value;
            },
          } as never;
        },
      } as never,
      {
        capability: "supported",
        apiKey: "secret",
        apiUrl: "https://app.daytona.io/api",
        target: "us",
        snapshot: "snapshot",
        emergencyDisabled: false,
      },
    );

    await provider.startSandbox("sandbox-1", { deadlineAtMs: 1_700_000_120_000 });
    await provider.recoverSandbox("sandbox-1", { deadlineAtMs: 1_700_000_180_000 });

    expect(echoed).toEqual([
      { ok: true, value: { idOrName: "sandbox-1", options: { deadlineAtMs: 1_700_000_120_000 } } },
      { ok: true, value: { idOrName: "sandbox-1", options: { deadlineAtMs: 1_700_000_180_000 } } },
    ]);
  });

  /**
   * The platform fact that zeroed `provider_duration_ms` on every
   * `terminal_tool_finished` row. `AsyncLocalStorage` follows an async chain
   * inside one Worker; a callback the provider Worker invokes arrives here as
   * a fresh entry point instead, so the tool trace the caller was standing in
   * is simply not there. The locally recorded `acquisition_duration_ms` beside
   * it was right the whole time, which is what made the fault look like a
   * measurement bug rather than a boundary one.
   */
  it("loses the caller's async context when the provider Worker calls back", async () => {
    const seen: (string | undefined)[] = [];
    const trace = createTerminalToolTrace({
      toolName: "read_file",
      toolCallId: "call-unbound",
      toolInvocationId: null,
    });

    await withTerminalToolTrace(trace, async () => {
      const session = await binding.createSession(CONFIGURATION);
      try {
        await session.getSandbox("sandbox-unbound", {
          observeRequest: async (measurement) => {
            seen.push(currentTerminalToolTrace()?.toolCallId);
            recordTerminalProviderRequest(measurement);
          },
        });
      } finally {
        (session as unknown as Disposable)[Symbol.dispose]();
      }
    });

    expect(seen).toEqual([undefined, undefined]);
    expect(trace.providerDurationMs).toBe(0);
    expect(trace.providerOperationCount).toBe(0);
  });

  it("carries the tool trace across the boundary and settles it before the call returns", async () => {
    const seen: (string | undefined)[] = [];
    const trace = createTerminalToolTrace({
      toolName: "read_file",
      toolCallId: "call-bound",
      toolInvocationId: "receipt-1",
    });
    const provider = createTerminalProviderRpcClient(binding, CONFIGURATION, {
      // The shape `createAvalonTerminalPlugin` installs: it resolves the trace
      // from the ambient store at the moment it is called, which is the whole
      // reason the client has to bind that store to the callback.
      observeRequest: (measurement: TerminalProviderRequestMeasurement) => {
        seen.push(currentTerminalToolTrace()?.toolCallId);
        recordTerminalProviderRequest(measurement);
      },
    });

    await withTerminalToolTrace(trace, async () => {
      await expect(provider.getSandbox("sandbox-bound")).resolves.toMatchObject({
        id: "sandbox-bound",
      });
      // Read inside the tool scope, where the tool logs its own row: every
      // request the call made is already counted by the time it returns.
      expect(currentTerminalToolTrace()?.providerOperationCount).toBe(2);
    });

    expect(seen).toEqual(["call-bound", "call-bound"]);
    expect(trace.providerDurationMs).toBe(24);
    expect(trace.providerRequestCount).toBe(2);
  });

  /**
   * A caller may report asynchronously — the contract is
   * `void | Promise<void>` — and dropping that promise resolves the RPC
   * callback early, which puts the measurement back in a race with the result
   * of its own call.
   */
  it("waits for an asynchronous observer before the provider call returns", async () => {
    const trace = createTerminalToolTrace({
      toolName: "run_command",
      toolCallId: "call-async",
      toolInvocationId: null,
    });
    const provider = createTerminalProviderRpcClient(binding, CONFIGURATION, {
      observeRequest: async (measurement: TerminalProviderRequestMeasurement) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        recordTerminalProviderRequest(measurement);
      },
    });

    await withTerminalToolTrace(trace, async () => {
      await provider.getSandbox("sandbox-async");
      expect(currentTerminalToolTrace()?.providerOperationCount).toBe(2);
    });

    expect(trace.providerDurationMs).toBe(24);
  });

  /**
   * The regression this change is against would look like working code: a
   * caller that puts request measurement back on the session instrumentation
   * still compiles, still delivers, and silently loses both the trace and the
   * attribution. Pin that the client sends nothing there.
   */
  it("sends no request observer on the session instrumentation", async () => {
    let session: Awaited<ReturnType<typeof binding.createSession>> | undefined;
    const provider = createTerminalProviderRpcClient({
      createSession: async (configuration, instrumentation) => {
        session = await binding.createSession(configuration, instrumentation);
        return session;
      },
    }, CONFIGURATION, {
      observe: () => undefined,
      observeRequest: recordTerminalProviderRequest,
    });
    const trace = createTerminalToolTrace({
      toolName: "read_file",
      toolCallId: "call-session-scope",
      toolInvocationId: null,
    });

    await withTerminalToolTrace(trace, () => provider.getSandbox("sandbox-session-scope"));

    await expect(session?.sessionObservations()).resolves.toEqual({
      installed: false,
      delivered: 0,
    });
    // The measurements still arrived — by the per-call route.
    expect(trace.providerOperationCount).toBe(2);
  });

  it("attributes a request to the concurrent tool call that issued it", async () => {
    const provider = createTerminalProviderRpcClient(binding, CONFIGURATION, {
      observeRequest: recordTerminalProviderRequest,
    });
    const traces = ["call-a", "call-b", "call-c"].map((toolCallId) => createTerminalToolTrace({
      toolName: "run_command",
      toolCallId,
      toolInvocationId: null,
    }));

    await Promise.all(traces.map((trace, index) => withTerminalToolTrace(
      trace,
      () => provider.getSandbox(`sandbox-${index}`),
    )));

    // A session-scoped callback cannot tell these apart: one session serves
    // every concurrent tool on the run.
    expect(traces.map((trace) => trace.providerOperationCount)).toEqual([2, 2, 2]);
    expect(traces.map((trace) => trace.providerDurationMs)).toEqual([24, 24, 24]);
  });

  it("retains session instrumentation callbacks after session creation returns", async () => {
    const session = await binding.createCallbackSession(async (value) => `observed:${value}`);
    try {
      await expect(session.call("sandbox.get")).resolves.toBe("observed:sandbox.get");
    } finally {
      session[Symbol.dispose]();
    }
  });
});
