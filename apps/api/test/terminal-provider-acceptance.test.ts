import { describe, expect, it, vi } from "vitest";

import { verifyTerminalRestartAndRestore } from "../scripts/terminal-provider-lifecycle";

describe("Terminal provider acceptance lifecycle", () => {
  it("stops the running sandbox before archive, then restores it", async () => {
    const events: string[] = [];
    const provider = {
      stopSandbox: vi.fn(async () => { events.push("stop"); }),
      recoverSandbox: vi.fn(async () => undefined),
    startSandbox: vi.fn(async () => { events.push("start"); }),
      archiveSandbox: vi.fn(async () => { events.push("archive"); }),
    };
    const verifyWorkspace = vi.fn(async (phase: "restart" | "restore") => {
      events.push(`verify:${phase}`);
    });

    await verifyTerminalRestartAndRestore(provider, "sandbox-1", verifyWorkspace);

    expect(events).toEqual([
      "stop",
      "start",
      "verify:restart",
      "stop",
      "archive",
      "start",
      "verify:restore",
    ]);
  });
});
