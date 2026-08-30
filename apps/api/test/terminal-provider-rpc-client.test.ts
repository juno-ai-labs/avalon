import { describe, expect, it, vi } from "vitest";

import { createTerminalProviderRpcClient } from "../src/services/terminal/provider-rpc-client";
import type {
  SupportedTerminalConfiguration,
  TerminalProviderRpcBinding,
} from "../src/services/terminal/provider-rpc-contract";

const configuration: SupportedTerminalConfiguration = {
  capability: "supported",
  apiKey: "provider-secret",
  apiUrl: "https://app.daytona.io/api",
  target: "us",
  snapshot: "daytona-small",
  emergencyDisabled: false,
};

const snapshot = {
  id: "sandbox-1",
  name: "terminal-1",
  state: "running" as const,
  domainAllowList: ["github.com"],
};

function rpcBinding(overrides: Partial<TerminalProviderRpcBinding> = {}): TerminalProviderRpcBinding {
  return {
    createSandbox: vi.fn(async () => snapshot),
    prepareSandbox: vi.fn(async () => snapshot),
    getSandbox: vi.fn(async () => snapshot),
    startSandbox: vi.fn(async () => undefined),
    stopSandbox: vi.fn(async () => undefined),
    archiveSandbox: vi.fn(async () => undefined),
    deleteSandbox: vi.fn(async () => undefined),
    updateNetworkPolicy: vi.fn(async () => undefined),
    configureGitHubReadAccess: vi.fn(async () => undefined),
    clearGitHubReadAccess: vi.fn(async () => undefined),
    readFile: vi.fn(async () => new Uint8Array()),
    writeFile: vi.fn(async () => undefined),
    runUtilityCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    cleanupCommand: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("Terminal provider RPC client", () => {
  it("delegates typed provider arguments and instrumentation callbacks", async () => {
    const observe = vi.fn();
    const createSandbox = vi.fn<TerminalProviderRpcBinding["createSandbox"]>(
      async (receivedConfiguration, input, callbacks) => {
        expect(receivedConfiguration).toEqual(configuration);
        expect(input.stableName).toBe("terminal-1");
        expect(callbacks?.observe).toBe(observe);
        return snapshot;
      },
    );
    const provider = createTerminalProviderRpcClient(
      rpcBinding({ createSandbox }),
      configuration,
      { observe },
    );

    await expect(provider.createSandbox({
      stableName: "terminal-1",
      workspaceId: "workspace-1",
      workstreamId: "workstream-1",
      generation: 1,
      domainAllowList: ["github.com"],
      environment: {},
    })).resolves.toEqual(snapshot);
    expect(createSandbox).toHaveBeenCalledOnce();
  });

  it("carries submission fences and cancellation without serializing an AbortSignal", async () => {
    const controller = new AbortController();
    const assertSubmissionAuthority = vi.fn(async () => undefined);
    const onSubmitted = vi.fn(async () => undefined);
    const runCommand = vi.fn<TerminalProviderRpcBinding["runCommand"]>(
      async (_configuration, _idOrName, input, callbacks) => {
        expect(input).not.toHaveProperty("signal");
        await callbacks?.assertSubmissionAuthority?.();
        await callbacks?.onSubmitted?.("provider-task-1");
        const outcome = callbacks?.waitForAbort?.();
        controller.abort();
        await expect(outcome).resolves.toBe("aborted");
        await callbacks?.finishAbortWait?.();
        return { exitCode: 0, stdout: "done", stderr: "" };
      },
    );
    const provider = createTerminalProviderRpcClient(rpcBinding({ runCommand }), configuration);

    await expect(provider.runCommand("sandbox-1", {
      taskName: "task-1",
      command: "true",
      cwd: "/workspace",
      timeoutMs: 1_000,
      signal: controller.signal,
      assertSubmissionAuthority,
      onSubmitted,
    })).resolves.toEqual({ exitCode: 0, stdout: "done", stderr: "" });
    expect(assertSubmissionAuthority).toHaveBeenCalledOnce();
    expect(onSubmitted).toHaveBeenCalledWith("provider-task-1");
  });

  it("lets the provider close a pending cancellation callback after success", async () => {
    const writeFile = vi.fn<TerminalProviderRpcBinding["writeFile"]>(
      async (_configuration, _idOrName, _path, _bytes, callbacks) => {
        const outcome = callbacks?.waitForAbort?.();
        await callbacks?.finishAbortWait?.();
        await expect(outcome).resolves.toBe("finished");
      },
    );
    const provider = createTerminalProviderRpcClient(rpcBinding({ writeFile }), configuration);

    await expect(provider.writeFile(
      "sandbox-1",
      "/workspace/result.txt",
      new Uint8Array([1, 2, 3]),
      new AbortController().signal,
    )).resolves.toBeUndefined();
  });

  it("reports a signal that was already cancelled before the RPC begins", async () => {
    const controller = new AbortController();
    controller.abort();
    const writeFile = vi.fn<TerminalProviderRpcBinding["writeFile"]>(
      async (_configuration, _idOrName, _path, _bytes, callbacks) => {
        await expect(callbacks?.waitForAbort?.()).resolves.toBe("aborted");
        await callbacks?.finishAbortWait?.();
      },
    );
    const provider = createTerminalProviderRpcClient(rpcBinding({ writeFile }), configuration);

    await expect(provider.writeFile(
      "sandbox-1",
      "/workspace/result.txt",
      new Uint8Array(),
      controller.signal,
    )).resolves.toBeUndefined();
  });
});
