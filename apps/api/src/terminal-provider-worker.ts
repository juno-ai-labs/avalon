import { WorkerEntrypoint } from "cloudflare:workers";

import {
  createDaytonaTerminalProvider,
  type DaytonaTerminalProvider,
} from "./services/terminal/daytona-provider";
import type { TerminalSandboxProvider } from "./services/terminal/provider-contract";
import { withTerminalProviderRpcAbort } from "./services/terminal/provider-rpc-cancellation";
import {
  requireTerminalProviderRpcCallback,
  terminalProviderRpcCall,
} from "./services/terminal/provider-rpc-result";
import type {
  SupportedTerminalConfiguration,
  TerminalCommandRpcInput,
  TerminalProviderRpcBinding,
  TerminalProviderRpcCallbacks,
  TerminalUtilityCommandRpcInput,
} from "./services/terminal/provider-rpc-contract";

export default class TerminalProviderWorker
  extends WorkerEntrypoint
  implements TerminalProviderRpcBinding {
  private provider(
    configuration: SupportedTerminalConfiguration,
    callbacks?: TerminalProviderRpcCallbacks,
  ): DaytonaTerminalProvider {
    const observe = callbacks?.observe;
    const observeRequest = callbacks?.observeRequest;
    return createDaytonaTerminalProvider(configuration, undefined, {
      ...(observe ? {
        observe: (measurement) => this.ctx.waitUntil(
          Promise.resolve(observe(measurement)).catch(() => undefined),
        ),
      } : {}),
      ...(observeRequest ? {
        observeRequest: (measurement) => this.ctx.waitUntil(
          Promise.resolve(observeRequest(measurement)).catch(() => undefined),
        ),
      } : {}),
    });
  }

  createSandbox(configuration: SupportedTerminalConfiguration, input: Parameters<TerminalSandboxProvider["createSandbox"]>[0], callbacks?: TerminalProviderRpcCallbacks) {
    return terminalProviderRpcCall(() => this.provider(configuration, callbacks).createSandbox(input));
  }

  prepareSandbox(configuration: SupportedTerminalConfiguration, idOrName: string, allowList: string[], callbacks?: TerminalProviderRpcCallbacks) {
    return terminalProviderRpcCall(() => this.provider(configuration, callbacks).prepareSandbox(idOrName, allowList));
  }

  getSandbox(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks) {
    return terminalProviderRpcCall(() => this.provider(configuration, callbacks).getSandbox(idOrName));
  }

  startSandbox(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks) {
    return terminalProviderRpcCall(() => this.provider(configuration, callbacks).startSandbox(idOrName));
  }

  stopSandbox(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks) {
    return terminalProviderRpcCall(() => this.provider(configuration, callbacks).stopSandbox(idOrName));
  }

  archiveSandbox(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks) {
    return terminalProviderRpcCall(() => this.provider(configuration, callbacks).archiveSandbox(idOrName));
  }

  deleteSandbox(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks) {
    return terminalProviderRpcCall(() => this.provider(configuration, callbacks).deleteSandbox(idOrName));
  }

  updateNetworkPolicy(configuration: SupportedTerminalConfiguration, idOrName: string, allowList: string[] | null, callbacks?: TerminalProviderRpcCallbacks) {
    return terminalProviderRpcCall(() => this.provider(configuration, callbacks).updateNetworkPolicy(idOrName, allowList));
  }

  configureGitHubReadAccess(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    input: Parameters<TerminalSandboxProvider["configureGitHubReadAccess"]>[1],
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    return terminalProviderRpcCall(() => this.provider(configuration, callbacks).configureGitHubReadAccess(idOrName, input));
  }

  clearGitHubReadAccess(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks) {
    return terminalProviderRpcCall(() => this.provider(configuration, callbacks).clearGitHubReadAccess(idOrName));
  }

  readFile(configuration: SupportedTerminalConfiguration, idOrName: string, path: string, callbacks?: TerminalProviderRpcCallbacks) {
    return terminalProviderRpcCall(() => this.provider(configuration, callbacks).readFile(idOrName, path));
  }

  writeFile(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    path: string,
    bytes: Uint8Array,
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    return terminalProviderRpcCall(() => withTerminalProviderRpcAbort(callbacks, (signal) =>
      this.provider(configuration, callbacks).writeFile(idOrName, path, bytes, signal)));
  }

  runUtilityCommand(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    input: TerminalUtilityCommandRpcInput,
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    return terminalProviderRpcCall(() => withTerminalProviderRpcAbort(callbacks, (signal) =>
      this.provider(configuration, callbacks).runUtilityCommand(idOrName, { ...input, signal })));
  }

  runCommand(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    input: TerminalCommandRpcInput,
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    const assertSubmissionAuthority = callbacks?.assertSubmissionAuthority;
    const onSubmitted = callbacks?.onSubmitted;
    return terminalProviderRpcCall(() => withTerminalProviderRpcAbort(callbacks, (signal) =>
      this.provider(configuration, callbacks).runCommand(idOrName, {
        ...input,
        signal,
        ...(assertSubmissionAuthority
          ? {
              assertSubmissionAuthority: () => requireTerminalProviderRpcCallback(
                assertSubmissionAuthority(),
              ),
            }
          : {}),
        ...(onSubmitted ? {
          onSubmitted: (providerTaskId: string) => requireTerminalProviderRpcCallback(
            onSubmitted(providerTaskId),
          ),
        } : {}),
      })));
  }

  cleanupCommand(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    taskName: string,
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    return terminalProviderRpcCall(() => this.provider(configuration, callbacks).cleanupCommand(idOrName, taskName));
  }
}
