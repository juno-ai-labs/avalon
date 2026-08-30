import { WorkerEntrypoint } from "cloudflare:workers";

import {
  createDaytonaTerminalProvider,
  type DaytonaTerminalProvider,
} from "./services/terminal/daytona-provider";
import type { TerminalSandboxProvider } from "./services/terminal/provider-contract";
import { withTerminalProviderRpcAbort } from "./services/terminal/provider-rpc-cancellation";
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
    return createDaytonaTerminalProvider(configuration, undefined, {
      ...(callbacks?.observe ? {
        observe: (measurement) => this.ctx.waitUntil(
          Promise.resolve(callbacks.observe!(measurement)).catch(() => undefined),
        ),
      } : {}),
      ...(callbacks?.observeRequest ? {
        observeRequest: (measurement) => this.ctx.waitUntil(
          Promise.resolve(callbacks.observeRequest!(measurement)).catch(() => undefined),
        ),
      } : {}),
    });
  }

  createSandbox(configuration: SupportedTerminalConfiguration, input: Parameters<TerminalSandboxProvider["createSandbox"]>[0], callbacks?: TerminalProviderRpcCallbacks) {
    return this.provider(configuration, callbacks).createSandbox(input);
  }

  prepareSandbox(configuration: SupportedTerminalConfiguration, idOrName: string, allowList: string[], callbacks?: TerminalProviderRpcCallbacks) {
    return this.provider(configuration, callbacks).prepareSandbox(idOrName, allowList);
  }

  getSandbox(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks) {
    return this.provider(configuration, callbacks).getSandbox(idOrName);
  }

  startSandbox(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks) {
    return this.provider(configuration, callbacks).startSandbox(idOrName);
  }

  stopSandbox(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks) {
    return this.provider(configuration, callbacks).stopSandbox(idOrName);
  }

  archiveSandbox(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks) {
    return this.provider(configuration, callbacks).archiveSandbox(idOrName);
  }

  deleteSandbox(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks) {
    return this.provider(configuration, callbacks).deleteSandbox(idOrName);
  }

  updateNetworkPolicy(configuration: SupportedTerminalConfiguration, idOrName: string, allowList: string[] | null, callbacks?: TerminalProviderRpcCallbacks) {
    return this.provider(configuration, callbacks).updateNetworkPolicy(idOrName, allowList);
  }

  configureGitHubReadAccess(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    input: Parameters<TerminalSandboxProvider["configureGitHubReadAccess"]>[1],
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    return this.provider(configuration, callbacks).configureGitHubReadAccess(idOrName, input);
  }

  clearGitHubReadAccess(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks) {
    return this.provider(configuration, callbacks).clearGitHubReadAccess(idOrName);
  }

  readFile(configuration: SupportedTerminalConfiguration, idOrName: string, path: string, callbacks?: TerminalProviderRpcCallbacks) {
    return this.provider(configuration, callbacks).readFile(idOrName, path);
  }

  writeFile(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    path: string,
    bytes: Uint8Array,
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    return withTerminalProviderRpcAbort(callbacks, (signal) =>
      this.provider(configuration, callbacks).writeFile(idOrName, path, bytes, signal));
  }

  runUtilityCommand(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    input: TerminalUtilityCommandRpcInput,
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    return withTerminalProviderRpcAbort(callbacks, (signal) =>
      this.provider(configuration, callbacks).runUtilityCommand(idOrName, { ...input, signal }));
  }

  runCommand(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    input: TerminalCommandRpcInput,
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    return withTerminalProviderRpcAbort(callbacks, (signal) =>
      this.provider(configuration, callbacks).runCommand(idOrName, {
        ...input,
        signal,
        ...(callbacks?.assertSubmissionAuthority
          ? { assertSubmissionAuthority: callbacks.assertSubmissionAuthority }
          : {}),
        ...(callbacks?.onSubmitted ? { onSubmitted: callbacks.onSubmitted } : {}),
      }));
  }

  cleanupCommand(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    taskName: string,
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    return this.provider(configuration, callbacks).cleanupCommand(idOrName, taskName);
  }

}
