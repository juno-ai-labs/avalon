import { describe, expect, it } from "vitest";

import { TerminalProviderSessionTarget } from "../src/terminal-provider-worker";
import type { DaytonaTerminalProvider } from "../src/services/terminal/daytona-provider";
import type { TerminalSandboxSnapshot } from "../src/services/terminal/provider-contract";
import { observeTerminalProviderRequest } from "../src/services/terminal/provider-rpc-result";
import type {
  SupportedTerminalConfiguration,
  TerminalProviderRpcCallbacks,
} from "../src/services/terminal/provider-rpc-contract";
import type { TerminalProviderRequestMeasurement } from "../src/services/terminal/tracing";

const CONFIGURATION: SupportedTerminalConfiguration = {
  capability: "supported",
  apiKey: "secret",
  apiUrl: "https://app.daytona.io/api",
  target: "us",
  snapshot: "snapshot",
  emergencyDisabled: false,
};

const SNAPSHOT: TerminalSandboxSnapshot = {
  id: "sandbox-1",
  name: "sandbox-1",
  state: "running",
  domainAllowList: [],
};
const COMMAND_RESULT = { exitCode: 0, stdout: "", stderr: "" };

/**
 * Every method reports one request the way the Daytona provider's
 * `measureRequest` does, so a method that failed to establish the per-call
 * observer scope delivers nothing.
 */
function reportingProvider(): DaytonaTerminalProvider {
  const report = async <T>(value: T): Promise<T> => {
    await observeTerminalProviderRequest({
      operation: "sandbox.get",
      detail: null,
      outcome: "completed",
      durationMs: 1,
      requestCount: 1,
      pollCount: 0,
      bytes: 0,
    });
    return value;
  };
  return {
    createSandbox: () => report(SNAPSHOT),
    prepareSandbox: () => report(SNAPSHOT),
    getSandbox: () => report(SNAPSHOT),
    recoverSandbox: () => report(undefined),
    startSandbox: () => report(undefined),
    stopSandbox: () => report(undefined),
    archiveSandbox: () => report(undefined),
    deleteSandbox: () => report(undefined),
    updateNetworkPolicy: () => report(undefined),
    configureGitHubReadAccess: () => report(undefined),
    clearGitHubReadAccess: () => report(undefined),
    readFile: () => report(new Uint8Array([1])),
    writeFile: () => report(undefined),
    runUtilityCommand: () => report(COMMAND_RESULT),
    runCommand: () => report(COMMAND_RESULT),
    cleanupCommand: () => report("deleted"),
  } satisfies DaytonaTerminalProvider;
}

describe("Terminal provider session target", () => {
  /**
   * The mechanical slip this guards is omitting `callbacks` on one of the
   * session's methods. The method keeps working and only its measurements go
   * missing, which is the same silent column of zeroes the per-call routing
   * exists to fix — so it is asserted for every method rather than a sample.
   */
  it("routes each method's measurements to that call's own observer", async () => {
    const target = new TerminalProviderSessionTarget(
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
      CONFIGURATION,
      undefined,
      reportingProvider(),
    );
    const delivered: string[] = [];
    const callbacks = (name: string): TerminalProviderRpcCallbacks => ({
      observeRequest: async (measurement: TerminalProviderRequestMeasurement) => {
        delivered.push(`${name}:${measurement.operation}`);
      },
    });
    const bytes = new Uint8Array([1]);
    const utility = {
      operation: "file.inspect" as const, command: ":", cwd: "/workspace", timeoutMs: 1_000,
    };
    const command = { taskName: "task", command: ":", cwd: "/workspace", timeoutMs: 1_000 };

    const calls: Array<[string, () => Promise<unknown>]> = [
      ["createSandbox", () => target.createSandbox({
        stableName: "s", workspaceId: "w", workstreamId: "ws",
        generation: 1, domainAllowList: [], environment: {},
      }, callbacks("createSandbox"))],
      ["prepareSandbox", () => target.prepareSandbox("s", [], callbacks("prepareSandbox"))],
      ["getSandbox", () => target.getSandbox("s", callbacks("getSandbox"))],
      // These two also carry a wait deadline, so the callbacks are third.
      ["recoverSandbox", () => target.recoverSandbox("s", undefined, callbacks("recoverSandbox"))],
      ["startSandbox", () => target.startSandbox("s", undefined, callbacks("startSandbox"))],
      ["stopSandbox", () => target.stopSandbox("s", callbacks("stopSandbox"))],
      ["archiveSandbox", () => target.archiveSandbox("s", callbacks("archiveSandbox"))],
      ["deleteSandbox", () => target.deleteSandbox("s", callbacks("deleteSandbox"))],
      ["updateNetworkPolicy", () => target.updateNetworkPolicy("s", null, callbacks("updateNetworkPolicy"))],
      ["configureGitHubReadAccess", () => target.configureGitHubReadAccess(
        "s",
        { gitBasicCredential: "basic", ghToken: "token" },
        callbacks("configureGitHubReadAccess"),
      )],
      ["clearGitHubReadAccess", () => target.clearGitHubReadAccess("s", callbacks("clearGitHubReadAccess"))],
      ["readFile", () => target.readFile("s", "/workspace/a", callbacks("readFile"))],
      ["writeFile", () => target.writeFile("s", "/workspace/a", bytes, callbacks("writeFile"))],
      ["runUtilityCommand", () => target.runUtilityCommand("s", utility, callbacks("runUtilityCommand"))],
      ["runCommand", () => target.runCommand("s", command, callbacks("runCommand"))],
      ["cleanupCommand", () => target.cleanupCommand("s", "task", callbacks("cleanupCommand"))],
    ];

    for (const [name, call] of calls) {
      await expect(call(), `${name} should succeed`).resolves.toMatchObject({ ok: true });
    }

    expect(delivered).toEqual(calls.map(([name]) => `${name}:sandbox.get`));
  });

  it("reports nothing when a call carries no observer", async () => {
    const target = new TerminalProviderSessionTarget(
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
      CONFIGURATION,
      undefined,
      reportingProvider(),
    );

    await expect(target.getSandbox("s")).resolves.toMatchObject({ ok: true });
  });
});
