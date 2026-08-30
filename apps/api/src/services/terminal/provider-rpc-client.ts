import type {
  TerminalProviderInstrumentation,
  TerminalSandboxProvider,
} from "./provider-contract";
import { TerminalProviderNotFoundError } from "./provider-contract";
import type {
  SupportedTerminalConfiguration,
  TerminalProviderRpcBinding,
  TerminalProviderRpcCallbacks,
  TerminalProviderRpcCallbackResult,
  TerminalProviderRpcResult,
} from "./provider-rpc-contract";
import { TerminalToolError } from "./tools";

async function callbackResult(callback: () => Promise<void>): Promise<TerminalProviderRpcCallbackResult> {
  try {
    await callback();
    return { ok: true };
  } catch (error) {
    if (error instanceof TerminalToolError) {
      return {
        ok: false,
        error: {
          kind: "terminal_tool",
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "callback",
        message: error instanceof Error ? error.message : "Terminal callback failed",
      },
    };
  }
}

async function unwrap<T>(result: PromiseLike<TerminalProviderRpcResult<T>>): Promise<T> {
  const settled = await result;
  if (settled.ok) return settled.value;
  if (settled.error.kind === "not_found") {
    throw new TerminalProviderNotFoundError(settled.error.message);
  }
  if (settled.error.kind === "terminal_tool") {
    throw new TerminalToolError(
      settled.error.code,
      settled.error.message,
      settled.error.details,
    );
  }
  throw new Error(settled.error.message);
}

export function createTerminalProviderRpcClient(
  binding: TerminalProviderRpcBinding,
  configuration: SupportedTerminalConfiguration,
  instrumentation: TerminalProviderInstrumentation = {},
): TerminalSandboxProvider {
  const callbacks = (input?: {
    signal?: AbortSignal;
    assertSubmissionAuthority?: () => Promise<void>;
    onSubmitted?: (providerTaskId: string) => Promise<void>;
  }): TerminalProviderRpcCallbacks => {
    const signal = input?.signal;
    const assertSubmissionAuthority = input?.assertSubmissionAuthority;
    const onSubmitted = input?.onSubmitted;
    let finishAbortWait: (() => void) | undefined;
    const waitForAbort = signal
      ? () => new Promise<"aborted" | "finished">((resolve) => {
          if (signal.aborted) {
            resolve("aborted");
            return;
          }
          const onAbort = () => resolve("aborted");
          finishAbortWait = () => {
            signal.removeEventListener("abort", onAbort);
            resolve("finished");
          };
          signal.addEventListener("abort", onAbort, { once: true });
        })
      : undefined;
    return {
      ...(instrumentation.observe ? { observe: instrumentation.observe } : {}),
      ...(instrumentation.observeRequest ? { observeRequest: instrumentation.observeRequest } : {}),
      ...(assertSubmissionAuthority ? {
        assertSubmissionAuthority: () => callbackResult(assertSubmissionAuthority),
      } : {}),
      ...(onSubmitted ? {
        onSubmitted: (providerTaskId: string) => callbackResult(
          () => onSubmitted(providerTaskId),
        ),
      } : {}),
      ...(signal?.aborted ? { initiallyAborted: true } : {}),
      ...(waitForAbort ? { waitForAbort } : {}),
      ...(waitForAbort ? { finishAbortWait: async () => finishAbortWait?.() } : {}),
    };
  };

  return {
    createSandbox: (input) => unwrap(binding.createSandbox(configuration, input, callbacks())),
    prepareSandbox: (idOrName, allowList) => unwrap(binding.prepareSandbox(configuration, idOrName, allowList, callbacks())),
    getSandbox: (idOrName) => unwrap(binding.getSandbox(configuration, idOrName, callbacks())),
    startSandbox: (idOrName) => unwrap(binding.startSandbox(configuration, idOrName, callbacks())),
    stopSandbox: (idOrName) => unwrap(binding.stopSandbox(configuration, idOrName, callbacks())),
    archiveSandbox: (idOrName) => unwrap(binding.archiveSandbox(configuration, idOrName, callbacks())),
    deleteSandbox: (idOrName) => unwrap(binding.deleteSandbox(configuration, idOrName, callbacks())),
    updateNetworkPolicy: (idOrName, allowList) => unwrap(binding.updateNetworkPolicy(configuration, idOrName, allowList, callbacks())),
    configureGitHubReadAccess: (idOrName, input) => unwrap(binding.configureGitHubReadAccess(configuration, idOrName, input, callbacks())),
    clearGitHubReadAccess: (idOrName) => unwrap(binding.clearGitHubReadAccess(configuration, idOrName, callbacks())),
    readFile: (idOrName, path) => unwrap(binding.readFile(configuration, idOrName, path, callbacks())),
    writeFile: (idOrName, path, bytes, signal) => unwrap(binding.writeFile(configuration, idOrName, path, bytes, callbacks({ signal }))),
    runUtilityCommand: (idOrName, input) => {
      const { signal, ...rpcInput } = input;
      return unwrap(binding.runUtilityCommand(configuration, idOrName, rpcInput, callbacks({
        ...(signal ? { signal } : {}),
      })));
    },
    runCommand: (idOrName, input) => {
      const { signal, assertSubmissionAuthority, onSubmitted, ...rpcInput } = input;
      return unwrap(binding.runCommand(configuration, idOrName, rpcInput, callbacks({
        ...(signal ? { signal } : {}),
        ...(assertSubmissionAuthority ? { assertSubmissionAuthority } : {}),
        ...(onSubmitted ? { onSubmitted } : {}),
      })));
    },
    cleanupCommand: (idOrName, taskName) => unwrap(binding.cleanupCommand(configuration, idOrName, taskName, callbacks())),
  };
}
