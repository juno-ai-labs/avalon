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
  TerminalProviderRpcSession,
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
  let sessionPromise: Promise<TerminalProviderRpcSession> | undefined;
  const session = (): Promise<TerminalProviderRpcSession> => {
    sessionPromise ??= binding.createSession(configuration, instrumentation);
    return sessionPromise;
  };
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
    createSandbox: async (input) => unwrap((await session()).createSandbox(input, callbacks())),
    prepareSandbox: async (idOrName, allowList) => unwrap((await session()).prepareSandbox(idOrName, allowList, callbacks())),
    getSandbox: async (idOrName) => unwrap((await session()).getSandbox(idOrName, callbacks())),
    recoverSandbox: async (idOrName) => unwrap((await session()).recoverSandbox(idOrName, callbacks())),
    startSandbox: async (idOrName) => unwrap((await session()).startSandbox(idOrName, callbacks())),
    stopSandbox: async (idOrName) => unwrap((await session()).stopSandbox(idOrName, callbacks())),
    archiveSandbox: async (idOrName) => unwrap((await session()).archiveSandbox(idOrName, callbacks())),
    deleteSandbox: async (idOrName) => unwrap((await session()).deleteSandbox(idOrName, callbacks())),
    updateNetworkPolicy: async (idOrName, allowList) => unwrap((await session()).updateNetworkPolicy(idOrName, allowList, callbacks())),
    configureGitHubReadAccess: async (idOrName, input) => unwrap((await session()).configureGitHubReadAccess(idOrName, input, callbacks())),
    clearGitHubReadAccess: async (idOrName) => unwrap((await session()).clearGitHubReadAccess(idOrName, callbacks())),
    readFile: async (idOrName, path) => unwrap((await session()).readFile(idOrName, path, callbacks())),
    writeFile: async (idOrName, path, bytes, signal) => unwrap((await session()).writeFile(idOrName, path, bytes, callbacks({ signal }))),
    runUtilityCommand: (idOrName, input) => {
      const { signal, ...rpcInput } = input;
      return session().then((rpcSession) => unwrap(rpcSession.runUtilityCommand(idOrName, rpcInput, callbacks({
        ...(signal ? { signal } : {}),
      }))));
    },
    runCommand: (idOrName, input) => {
      const { signal, assertSubmissionAuthority, onSubmitted, ...rpcInput } = input;
      return session().then((rpcSession) => unwrap(rpcSession.runCommand(idOrName, rpcInput, callbacks({
        ...(signal ? { signal } : {}),
        ...(assertSubmissionAuthority ? { assertSubmissionAuthority } : {}),
        ...(onSubmitted ? { onSubmitted } : {}),
      }))));
    },
    cleanupCommand: async (idOrName, taskName) => unwrap((await session()).cleanupCommand(idOrName, taskName, callbacks())),
  };
}
