import type {
  TerminalProviderInstrumentation,
  TerminalSandboxProvider,
} from "./provider-contract";
import type {
  SupportedTerminalConfiguration,
  TerminalProviderRpcBinding,
  TerminalProviderRpcCallbacks,
} from "./provider-rpc-contract";

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
    let finishAbortWait: (() => void) | undefined;
    const waitForAbort = input?.signal
      ? () => new Promise<"aborted" | "finished">((resolve) => {
          if (input.signal!.aborted) {
            resolve("aborted");
            return;
          }
          const onAbort = () => resolve("aborted");
          finishAbortWait = () => {
            input.signal!.removeEventListener("abort", onAbort);
            resolve("finished");
          };
          input.signal!.addEventListener("abort", onAbort, { once: true });
        })
      : undefined;
    return {
      ...(instrumentation.observe ? { observe: instrumentation.observe } : {}),
      ...(instrumentation.observeRequest ? { observeRequest: instrumentation.observeRequest } : {}),
      ...(input?.assertSubmissionAuthority ? { assertSubmissionAuthority: input.assertSubmissionAuthority } : {}),
      ...(input?.onSubmitted ? { onSubmitted: input.onSubmitted } : {}),
      ...(waitForAbort ? { waitForAbort } : {}),
      ...(waitForAbort ? { finishAbortWait: async () => finishAbortWait?.() } : {}),
    };
  };

  return {
    createSandbox: (input) => binding.createSandbox(configuration, input, callbacks()),
    prepareSandbox: (idOrName, allowList) => binding.prepareSandbox(configuration, idOrName, allowList, callbacks()),
    getSandbox: (idOrName) => binding.getSandbox(configuration, idOrName, callbacks()),
    startSandbox: (idOrName) => binding.startSandbox(configuration, idOrName, callbacks()),
    stopSandbox: (idOrName) => binding.stopSandbox(configuration, idOrName, callbacks()),
    archiveSandbox: (idOrName) => binding.archiveSandbox(configuration, idOrName, callbacks()),
    deleteSandbox: (idOrName) => binding.deleteSandbox(configuration, idOrName, callbacks()),
    updateNetworkPolicy: (idOrName, allowList) => binding.updateNetworkPolicy(configuration, idOrName, allowList, callbacks()),
    configureGitHubReadAccess: (idOrName, input) => binding.configureGitHubReadAccess(configuration, idOrName, input, callbacks()),
    clearGitHubReadAccess: (idOrName) => binding.clearGitHubReadAccess(configuration, idOrName, callbacks()),
    readFile: (idOrName, path) => binding.readFile(configuration, idOrName, path, callbacks()),
    writeFile: (idOrName, path, bytes, signal) => binding.writeFile(configuration, idOrName, path, bytes, callbacks({ signal })),
    runUtilityCommand: (idOrName, input) => {
      const { signal, ...rpcInput } = input;
      return binding.runUtilityCommand(configuration, idOrName, rpcInput, callbacks({
        ...(signal ? { signal } : {}),
      }));
    },
    runCommand: (idOrName, input) => {
      const { signal, assertSubmissionAuthority, onSubmitted, ...rpcInput } = input;
      return binding.runCommand(configuration, idOrName, rpcInput, callbacks({
        ...(signal ? { signal } : {}),
        ...(assertSubmissionAuthority ? { assertSubmissionAuthority } : {}),
        ...(onSubmitted ? { onSubmitted } : {}),
      }));
    },
    cleanupCommand: (idOrName, taskName) => binding.cleanupCommand(configuration, idOrName, taskName, callbacks()),
  };
}
