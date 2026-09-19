import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

import {
  createDaytonaTerminalProvider,
  type DaytonaTerminalProvider,
} from "./services/terminal/daytona-provider";
import type {
  TerminalSandboxProvider,
  TerminalSandboxWaitOptions,
} from "./services/terminal/provider-contract";
import { withTerminalProviderRpcAbort } from "./services/terminal/provider-rpc-cancellation";
import {
  observeTerminalProviderRequest,
  requireTerminalProviderRpcCallback,
  terminalProviderRpcCall,
} from "./services/terminal/provider-rpc-result";
import type {
  SupportedTerminalConfiguration,
  TerminalCommandRpcInput,
  TerminalProviderRpcCallbacks,
  TerminalProviderRpcInstrumentation,
  TerminalProviderRpcSession,
  TerminalUtilityCommandRpcInput,
} from "./services/terminal/provider-rpc-contract";

function hasRpcDuplicate<T>(value: T): value is T & { dup(): T } {
  return typeof value === "function" && "dup" in value && typeof value.dup === "function";
}

function retainRpcCallback<T>(callback: T | undefined): T | undefined {
  return callback && hasRpcDuplicate(callback) ? callback.dup() : callback;
}

function disposeRpcCallback(callback: unknown): void {
  if (typeof callback !== "function" || !(Symbol.dispose in callback)) return;
  const dispose = callback[Symbol.dispose];
  if (typeof dispose === "function") dispose.call(callback);
}

/**
 * Exported for `terminal-provider-session-target.test.ts`, which drives every
 * method against an injected provider. Each one has to hand its own callbacks
 * to `terminalProviderRpcCall` for a measurement to reach the caller, and
 * omitting that on one method is both the likeliest slip here and invisible:
 * the method still works and only its instrumentation goes quiet.
 */
export class TerminalProviderSessionTarget extends RpcTarget implements TerminalProviderRpcSession {
  private readonly provider: DaytonaTerminalProvider;
  private readonly observe: TerminalProviderRpcInstrumentation["observe"];

  constructor(
    ctx: ExecutionContext,
    configuration: SupportedTerminalConfiguration,
    instrumentation?: TerminalProviderRpcInstrumentation,
    provider?: DaytonaTerminalProvider,
  ) {
    super();
    this.observe = retainRpcCallback(instrumentation?.observe);
    const observe = this.observe;
    this.provider = provider ?? createDaytonaTerminalProvider(configuration, undefined, {
      // A lifecycle observation needs nothing but the caller's environment, so
      // it can outlive the call that produced it.
      ...(observe ? {
        observe: (measurement) => ctx.waitUntil(
          Promise.resolve(observe(measurement)).catch(() => undefined),
        ),
      } : {}),
      // A request measurement belongs to one caller's one call, and is routed
      // to it by `terminalProviderRpcCall` rather than held on this session.
      observeRequest: (measurement) => observeTerminalProviderRequest(measurement),
    });
  }

  [Symbol.dispose](): void {
    disposeRpcCallback(this.observe);
  }

  createSandbox(
    input: Parameters<TerminalSandboxProvider["createSandbox"]>[0],
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    return terminalProviderRpcCall(() => this.provider.createSandbox(input), callbacks);
  }

  prepareSandbox(idOrName: string, allowList: string[], callbacks?: TerminalProviderRpcCallbacks) {
    return terminalProviderRpcCall(() => this.provider.prepareSandbox(idOrName, allowList), callbacks);
  }

  getSandbox(idOrName: string, callbacks?: TerminalProviderRpcCallbacks) {
    return terminalProviderRpcCall(() => this.provider.getSandbox(idOrName), callbacks);
  }

  recoverSandbox(
    idOrName: string,
    options?: TerminalSandboxWaitOptions,
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    return terminalProviderRpcCall(() => this.provider.recoverSandbox(idOrName, options), callbacks);
  }

  startSandbox(
    idOrName: string,
    options?: TerminalSandboxWaitOptions,
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    return terminalProviderRpcCall(() => this.provider.startSandbox(idOrName, options), callbacks);
  }

  stopSandbox(idOrName: string, callbacks?: TerminalProviderRpcCallbacks) {
    return terminalProviderRpcCall(() => this.provider.stopSandbox(idOrName), callbacks);
  }

  archiveSandbox(idOrName: string, callbacks?: TerminalProviderRpcCallbacks) {
    return terminalProviderRpcCall(() => this.provider.archiveSandbox(idOrName), callbacks);
  }

  deleteSandbox(idOrName: string, callbacks?: TerminalProviderRpcCallbacks) {
    return terminalProviderRpcCall(() => this.provider.deleteSandbox(idOrName), callbacks);
  }

  updateNetworkPolicy(
    idOrName: string,
    allowList: string[] | null,
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    return terminalProviderRpcCall(() => this.provider.updateNetworkPolicy(idOrName, allowList), callbacks);
  }

  configureGitHubReadAccess(
    idOrName: string,
    input: Parameters<TerminalSandboxProvider["configureGitHubReadAccess"]>[1],
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    return terminalProviderRpcCall(() => this.provider.configureGitHubReadAccess(idOrName, input), callbacks);
  }

  clearGitHubReadAccess(idOrName: string, callbacks?: TerminalProviderRpcCallbacks) {
    return terminalProviderRpcCall(() => this.provider.clearGitHubReadAccess(idOrName), callbacks);
  }

  readFile(idOrName: string, path: string, callbacks?: TerminalProviderRpcCallbacks) {
    return terminalProviderRpcCall(() => this.provider.readFile(idOrName, path), callbacks);
  }

  writeFile(
    idOrName: string,
    path: string,
    bytes: Uint8Array,
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    return terminalProviderRpcCall(() => withTerminalProviderRpcAbort(callbacks, (signal) =>
      this.provider.writeFile(idOrName, path, bytes, signal)), callbacks);
  }

  runUtilityCommand(
    idOrName: string,
    input: TerminalUtilityCommandRpcInput,
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    return terminalProviderRpcCall(() => withTerminalProviderRpcAbort(callbacks, (signal) =>
      this.provider.runUtilityCommand(idOrName, { ...input, signal })), callbacks);
  }

  runCommand(
    idOrName: string,
    input: TerminalCommandRpcInput,
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    const assertSubmissionAuthority = callbacks?.assertSubmissionAuthority;
    const onSubmitted = callbacks?.onSubmitted;
    return terminalProviderRpcCall(() => withTerminalProviderRpcAbort(callbacks, (signal) =>
      this.provider.runCommand(idOrName, {
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
      })), callbacks);
  }

  cleanupCommand(
    idOrName: string,
    taskName: string,
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    return terminalProviderRpcCall(() => this.provider.cleanupCommand(idOrName, taskName), callbacks);
  }
}

export default class TerminalProviderWorker extends WorkerEntrypoint {
  /** Cloudflare requires a named handler even when only RPC is reachable. */
  override fetch(): Response {
    return new Response(null, { status: 404 });
  }

  createSession(
    configuration: SupportedTerminalConfiguration,
    instrumentation?: TerminalProviderRpcInstrumentation,
  ): TerminalProviderSessionTarget {
    return new TerminalProviderSessionTarget(this.ctx, configuration, instrumentation);
  }
}
