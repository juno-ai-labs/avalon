import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

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

class TerminalProviderSessionTarget extends RpcTarget implements TerminalProviderRpcSession {
  private readonly provider: DaytonaTerminalProvider;
  private readonly observe: TerminalProviderRpcInstrumentation["observe"];
  private readonly observeRequest: TerminalProviderRpcInstrumentation["observeRequest"];

  constructor(
    ctx: ExecutionContext,
    configuration: SupportedTerminalConfiguration,
    instrumentation?: TerminalProviderRpcInstrumentation,
  ) {
    super();
    this.observe = retainRpcCallback(instrumentation?.observe);
    this.observeRequest = retainRpcCallback(instrumentation?.observeRequest);
    const observe = this.observe;
    const observeRequest = this.observeRequest;
    this.provider = createDaytonaTerminalProvider(configuration, undefined, {
      ...(observe ? {
        observe: (measurement) => ctx.waitUntil(
          Promise.resolve(observe(measurement)).catch(() => undefined),
        ),
      } : {}),
      ...(observeRequest ? {
        observeRequest: (measurement) => ctx.waitUntil(
          Promise.resolve(observeRequest(measurement)).catch(() => undefined),
        ),
      } : {}),
    });
  }

  [Symbol.dispose](): void {
    disposeRpcCallback(this.observe);
    disposeRpcCallback(this.observeRequest);
  }

  createSandbox(input: Parameters<TerminalSandboxProvider["createSandbox"]>[0]) {
    return terminalProviderRpcCall(() => this.provider.createSandbox(input));
  }

  prepareSandbox(idOrName: string, allowList: string[]) {
    return terminalProviderRpcCall(() => this.provider.prepareSandbox(idOrName, allowList));
  }

  getSandbox(idOrName: string) {
    return terminalProviderRpcCall(() => this.provider.getSandbox(idOrName));
  }

  startSandbox(idOrName: string) {
    return terminalProviderRpcCall(() => this.provider.startSandbox(idOrName));
  }

  stopSandbox(idOrName: string) {
    return terminalProviderRpcCall(() => this.provider.stopSandbox(idOrName));
  }

  archiveSandbox(idOrName: string) {
    return terminalProviderRpcCall(() => this.provider.archiveSandbox(idOrName));
  }

  deleteSandbox(idOrName: string) {
    return terminalProviderRpcCall(() => this.provider.deleteSandbox(idOrName));
  }

  updateNetworkPolicy(idOrName: string, allowList: string[] | null) {
    return terminalProviderRpcCall(() => this.provider.updateNetworkPolicy(idOrName, allowList));
  }

  configureGitHubReadAccess(
    idOrName: string,
    input: Parameters<TerminalSandboxProvider["configureGitHubReadAccess"]>[1],
  ) {
    return terminalProviderRpcCall(() => this.provider.configureGitHubReadAccess(idOrName, input));
  }

  clearGitHubReadAccess(idOrName: string) {
    return terminalProviderRpcCall(() => this.provider.clearGitHubReadAccess(idOrName));
  }

  readFile(idOrName: string, path: string) {
    return terminalProviderRpcCall(() => this.provider.readFile(idOrName, path));
  }

  writeFile(
    idOrName: string,
    path: string,
    bytes: Uint8Array,
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    return terminalProviderRpcCall(() => withTerminalProviderRpcAbort(callbacks, (signal) =>
      this.provider.writeFile(idOrName, path, bytes, signal)));
  }

  runUtilityCommand(
    idOrName: string,
    input: TerminalUtilityCommandRpcInput,
    callbacks?: TerminalProviderRpcCallbacks,
  ) {
    return terminalProviderRpcCall(() => withTerminalProviderRpcAbort(callbacks, (signal) =>
      this.provider.runUtilityCommand(idOrName, { ...input, signal })));
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
      })));
  }

  cleanupCommand(
    idOrName: string,
    taskName: string,
  ) {
    return terminalProviderRpcCall(() => this.provider.cleanupCommand(idOrName, taskName));
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
