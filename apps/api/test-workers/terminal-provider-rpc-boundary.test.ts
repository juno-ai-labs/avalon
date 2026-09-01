import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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

  it("retains session instrumentation callbacks after session creation returns", async () => {
    const session = await binding.createCallbackSession(async (value) => `observed:${value}`);
    try {
      await expect(session.call("sandbox.get")).resolves.toBe("observed:sandbox.get");
    } finally {
      session[Symbol.dispose]();
    }
  });
});
