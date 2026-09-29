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
  TerminalProviderRpcInstrumentation,
  TerminalProviderRpcResult,
  TerminalProviderRpcSession,
} from "./provider-rpc-contract";
import { TerminalToolError } from "./tools";
import { bindToTerminalToolTrace } from "./tracing";

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

function disposeRpcStub(stub: unknown): void {
  // A workerd stub is a callable proxy, so `typeof` reads "function".
  if ((typeof stub !== "object" && typeof stub !== "function") || stub === null) return;
  if (!(Symbol.dispose in stub)) return;
  const dispose = (stub as Partial<Disposable>)[Symbol.dispose];
  if (typeof dispose === "function") dispose.call(stub);
}

/**
 * A provider backed by one RPC session in the provider Worker, opened on first
 * use and shared by every call after it, so the session's loaded sandboxes
 * are reused across a run's tools.
 *
 * The session holds an open invocation in the provider Worker until its stub
 * is disposed, and a caller living in a Durable Object never ends the context
 * that would dispose it for us. So the owner disposes this client when it is
 * done with it. Disposal waits for calls in flight, and a call made after it
 * gets a session of its own that is released as soon as it goes idle.
 */
export function createTerminalProviderRpcClient(
  binding: TerminalProviderRpcBinding,
  configuration: SupportedTerminalConfiguration,
  instrumentation: TerminalProviderInstrumentation = {},
): TerminalSandboxProvider & Disposable {
  let sessionPromise: Promise<TerminalProviderRpcSession> | undefined;
  let inFlight = 0;
  let disposed = false;
  const session = (): Promise<TerminalProviderRpcSession> => {
    // Only the session-scoped part of the instrumentation crosses here. A
    // callback sent this way becomes a stub the provider Worker holds for the
    // life of the session, so anything that belongs to a single call — every
    // per-request measurement — is sent with that call instead.
    sessionPromise ??= binding.createSession(configuration, {
      ...(instrumentation.observe ? { observe: instrumentation.observe } : {}),
    } satisfies TerminalProviderRpcInstrumentation);
    return sessionPromise;
  };
  const release = (): void => {
    const opened = sessionPromise;
    sessionPromise = undefined;
    void opened?.then(disposeRpcStub, () => undefined);
  };
  const call = async <T>(
    request: (rpcSession: TerminalProviderRpcSession) => PromiseLike<TerminalProviderRpcResult<T>>,
  ): Promise<T> => {
    inFlight += 1;
    try {
      return await unwrap(request(await session()));
    } finally {
      inFlight -= 1;
      if (disposed && inFlight === 0) release();
    }
  };
  const callbacks = (input?: {
    signal?: AbortSignal;
    assertSubmissionAuthority?: () => Promise<void>;
    onSubmitted?: (providerTaskId: string) => Promise<void>;
  }): TerminalProviderRpcCallbacks => {
    // Built inside the tool invocation about to issue the request, which is
    // where the trace still is; see `bindToTerminalToolTrace`.
    const observeRequest = instrumentation.observeRequest;
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
      ...(observeRequest ? {
        // Awaited, not fired: the contract lets a caller report asynchronously,
        // and dropping its promise here would resolve the RPC callback early
        // and reintroduce the very race this per-call delivery exists to close
        // — with any rejection becoming an unhandled one on the way.
        observeRequest: bindToTerminalToolTrace(async (measurement) => {
          await observeRequest(measurement);
        }),
      } : {}),
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
    createSandbox: (input) => call((rpc) => rpc.createSandbox(input, callbacks())),
    prepareSandbox: (idOrName, allowList) => call((rpc) => rpc.prepareSandbox(idOrName, allowList, callbacks())),
    getSandbox: (idOrName) => call((rpc) => rpc.getSandbox(idOrName, callbacks())),
    recoverSandbox: (idOrName, options) => call((rpc) => rpc.recoverSandbox(idOrName, options, callbacks())),
    startSandbox: (idOrName, options) => call((rpc) => rpc.startSandbox(idOrName, options, callbacks())),
    stopSandbox: (idOrName) => call((rpc) => rpc.stopSandbox(idOrName, callbacks())),
    archiveSandbox: (idOrName) => call((rpc) => rpc.archiveSandbox(idOrName, callbacks())),
    deleteSandbox: (idOrName) => call((rpc) => rpc.deleteSandbox(idOrName, callbacks())),
    updateNetworkPolicy: (idOrName, allowList) => call((rpc) => rpc.updateNetworkPolicy(idOrName, allowList, callbacks())),
    configureGitHubReadAccess: (idOrName, input) => call((rpc) => rpc.configureGitHubReadAccess(idOrName, input, callbacks())),
    clearGitHubReadAccess: (idOrName) => call((rpc) => rpc.clearGitHubReadAccess(idOrName, callbacks())),
    readFile: (idOrName, path) => call((rpc) => rpc.readFile(idOrName, path, callbacks())),
    writeFile: (idOrName, path, bytes, signal) => call((rpc) => rpc.writeFile(idOrName, path, bytes, callbacks({ signal }))),
    runUtilityCommand: (idOrName, input) => {
      const { signal, ...rpcInput } = input;
      return call((rpc) => rpc.runUtilityCommand(idOrName, rpcInput, callbacks({
        ...(signal ? { signal } : {}),
      })));
    },
    runCommand: (idOrName, input) => {
      const { signal, assertSubmissionAuthority, onSubmitted, ...rpcInput } = input;
      return call((rpc) => rpc.runCommand(idOrName, rpcInput, callbacks({
        ...(signal ? { signal } : {}),
        ...(assertSubmissionAuthority ? { assertSubmissionAuthority } : {}),
        ...(onSubmitted ? { onSubmitted } : {}),
      })));
    },
    cleanupCommand: (idOrName, taskName) => call((rpc) => rpc.cleanupCommand(idOrName, taskName, callbacks())),
    [Symbol.dispose]: () => {
      disposed = true;
      if (inFlight === 0) release();
    },
  };
}
