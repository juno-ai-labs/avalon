import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createTerminalProviderRpcClient } from "../src/services/terminal/provider-rpc-client";

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

  it("retains session instrumentation callbacks after session creation returns", async () => {
    const session = await binding.createCallbackSession(async (value) => `observed:${value}`);
    try {
      await expect(session.call("sandbox.get")).resolves.toBe("observed:sandbox.get");
    } finally {
      session[Symbol.dispose]();
    }
  });
});
