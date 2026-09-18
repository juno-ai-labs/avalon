import { describe, expect, it, vi } from "vitest";

import { createTerminalProviderRpcClient } from "../src/services/terminal/provider-rpc-client";
import { withTerminalProviderRpcAbort } from "../src/services/terminal/provider-rpc-cancellation";
import { isTerminalProviderNotFound } from "../src/services/terminal/provider-contract";
import {
  requireTerminalProviderRpcCallback,
  terminalProviderRpcCall,
} from "../src/services/terminal/provider-rpc-result";
import type {
  SupportedTerminalConfiguration,
  TerminalProviderRpcBinding,
  TerminalProviderRpcResult,
  TerminalProviderRpcSession,
} from "../src/services/terminal/provider-rpc-contract";
import { TerminalToolError } from "../src/services/terminal/tools";

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

function success<T>(value: T): TerminalProviderRpcResult<T> {
  return { ok: true, value };
}

function rpcBinding(overrides: Partial<TerminalProviderRpcSession> = {}): TerminalProviderRpcBinding {
  const session: TerminalProviderRpcSession = {
    createSandbox: vi.fn(async () => success(snapshot)),
    prepareSandbox: vi.fn(async () => success(snapshot)),
    getSandbox: vi.fn(async () => success(snapshot)),
    recoverSandbox: vi.fn(async () => success(undefined)),
    startSandbox: vi.fn(async () => success(undefined)),
    stopSandbox: vi.fn(async () => success(undefined)),
    archiveSandbox: vi.fn(async () => success(undefined)),
    deleteSandbox: vi.fn(async () => success(undefined)),
    updateNetworkPolicy: vi.fn(async () => success(undefined)),
    configureGitHubReadAccess: vi.fn(async () => success(undefined)),
    clearGitHubReadAccess: vi.fn(async () => success(undefined)),
    readFile: vi.fn(async () => success(new Uint8Array())),
    writeFile: vi.fn(async () => success(undefined)),
    runUtilityCommand: vi.fn(async () => success({ exitCode: 0, stdout: "", stderr: "" })),
    runCommand: vi.fn(async () => success({ exitCode: 0, stdout: "", stderr: "" })),
    cleanupCommand: vi.fn(async () => success(undefined)),
    ...overrides,
  };
  return { createSession: vi.fn(async () => session) };
}

describe("Terminal provider RPC client", () => {
  it("delegates typed provider arguments and instrumentation callbacks", async () => {
    const observe = vi.fn();
    const createSandbox = vi.fn<TerminalProviderRpcSession["createSandbox"]>(
      async (input) => {
        expect(input.stableName).toBe("terminal-1");
        return success(snapshot);
      },
    );
    const binding = rpcBinding({ createSandbox });
    const provider = createTerminalProviderRpcClient(
      binding,
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
    expect(binding.createSession).toHaveBeenCalledWith(configuration, { observe });
  });

  it("keeps one provider session for the client's whole harness run", async () => {
    const getSandbox = vi.fn<TerminalProviderRpcSession["getSandbox"]>(
      async () => success(snapshot),
    );
    const readFile = vi.fn<TerminalProviderRpcSession["readFile"]>(
      async () => success(new Uint8Array([1, 2, 3])),
    );
    const binding = rpcBinding({ getSandbox, readFile });
    const provider = createTerminalProviderRpcClient(binding, configuration);

    await expect(provider.getSandbox("sandbox-1")).resolves.toEqual(snapshot);
    await expect(provider.readFile("sandbox-1", "/workspace/result.txt"))
      .resolves.toEqual(new Uint8Array([1, 2, 3]));

    expect(binding.createSession).toHaveBeenCalledOnce();
    expect(getSandbox).toHaveBeenCalledOnce();
    expect(readFile).toHaveBeenCalledOnce();
  });

  it("carries submission fences and cancellation without serializing an AbortSignal", async () => {
    const controller = new AbortController();
    const assertSubmissionAuthority = vi.fn(async () => undefined);
    const onSubmitted = vi.fn(async () => undefined);
    const runCommand = vi.fn<TerminalProviderRpcSession["runCommand"]>(
      async (_idOrName, input, callbacks) => {
        expect(input).not.toHaveProperty("signal");
        await expect(callbacks?.assertSubmissionAuthority?.()).resolves.toEqual({ ok: true });
        await expect(callbacks?.onSubmitted?.("provider-task-1")).resolves.toEqual({ ok: true });
        const outcome = callbacks?.waitForAbort?.();
        controller.abort();
        await expect(outcome).resolves.toBe("aborted");
        await callbacks?.finishAbortWait?.();
        return success({ exitCode: 0, stdout: "done", stderr: "" });
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
    const writeFile = vi.fn<TerminalProviderRpcSession["writeFile"]>(
      async (_idOrName, _path, _bytes, callbacks) => {
        const outcome = callbacks?.waitForAbort?.();
        await callbacks?.finishAbortWait?.();
        await expect(outcome).resolves.toBe("finished");
        return success(undefined);
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
    const writeFile = vi.fn<TerminalProviderRpcSession["writeFile"]>(
      async (_idOrName, _path, _bytes, callbacks) => {
        expect(callbacks?.initiallyAborted).toBe(true);
        await expect(callbacks?.waitForAbort?.()).resolves.toBe("aborted");
        await callbacks?.finishAbortWait?.();
        return success(undefined);
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

  it("reconstructs provider not-found classification from a typed RPC failure", async () => {
    const transported = structuredClone(await terminalProviderRpcCall<Uint8Array>(
      async () => { throw Object.assign(new Error("sandbox missing"), { status: 404 }); },
    ));
    const provider = createTerminalProviderRpcClient(rpcBinding({
      readFile: vi.fn<TerminalProviderRpcSession["readFile"]>(async () => transported),
    }), configuration);

    const error = await provider.readFile("missing", "/workspace/file").catch((caught) => caught);
    expect(isTerminalProviderNotFound(error)).toBe(true);
  });

  it("preserves TerminalToolError identity from submission callbacks", async () => {
    const authorityError = new TerminalToolError(
      "command_recovery_unavailable",
      "submission authority expired",
    );
    const runCommand = vi.fn<TerminalProviderRpcSession["runCommand"]>(
      async (_idOrName, _input, callbacks) => {
        return terminalProviderRpcCall(async () => {
          await requireTerminalProviderRpcCallback(callbacks!.assertSubmissionAuthority!());
          return { exitCode: 0, stdout: "", stderr: "" };
        });
      },
    );
    const provider = createTerminalProviderRpcClient(rpcBinding({ runCommand }), configuration);

    const error = await provider.runCommand("sandbox-1", {
      taskName: "task-1",
      command: "true",
      cwd: "/workspace",
      timeoutMs: 1_000,
      assertSubmissionAuthority: async () => { throw authorityError; },
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(TerminalToolError);
    expect(error).toMatchObject({
      code: "command_recovery_unavailable",
      message: "submission authority expired",
    });
  });
});

describe("Terminal provider RPC cancellation", () => {
  it("aborts the provider-side signal before a pre-cancelled operation begins", async () => {
    let enteredWithAbortedSignal = false;

    await expect(withTerminalProviderRpcAbort({ initiallyAborted: true }, async (signal) => {
      enteredWithAbortedSignal = signal.aborted;
      throw signal.reason;
    })).rejects.toThrow("Terminal operation cancelled");

    expect(enteredWithAbortedSignal).toBe(true);
  });

  it("does not abort a completed operation when the remote callback settles late", async () => {
    let finishAbortWait: (() => void) | undefined;
    const waitForAbort = new Promise<"aborted">((resolve) => {
      finishAbortWait = () => resolve("aborted");
    });
    let operationSignal: AbortSignal | undefined;

    await expect(withTerminalProviderRpcAbort({
      waitForAbort: () => waitForAbort,
      finishAbortWait: async () => finishAbortWait?.(),
    }, async (signal) => {
      operationSignal = signal;
      return "completed";
    })).resolves.toBe("completed");

    expect(operationSignal?.aborted).toBe(false);
  });
});
