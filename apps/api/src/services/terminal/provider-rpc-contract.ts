import type { TerminalRegionConfiguration } from "./contract";
import type {
  TerminalProviderInstrumentation,
  TerminalSandboxProvider,
  TerminalSandboxSnapshot,
  TerminalSandboxWaitOptions,
} from "./provider-contract";
import type { TerminalProviderRequestMeasurement } from "./tracing";

export type SupportedTerminalConfiguration = Extract<
  TerminalRegionConfiguration,
  { capability: "supported" }
>;

export type TerminalUtilityCommandRpcInput = Omit<
  Parameters<TerminalSandboxProvider["runUtilityCommand"]>[1],
  "signal"
>;

export type TerminalCommandRpcInput = Omit<
  Parameters<TerminalSandboxProvider["runCommand"]>[1],
  "signal" | "assertSubmissionAuthority" | "onSubmitted"
>;

export type TerminalProviderRpcCallbackResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | { kind: "terminal_tool"; code: string; message: string; details?: Record<string, unknown> }
        | { kind: "callback"; message: string };
    };

export type TerminalProviderRpcResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error:
        | { kind: "not_found"; message: string }
        | { kind: "terminal_tool"; code: string; message: string; details?: Record<string, unknown> }
        | { kind: "provider"; message: string };
    };

/**
 * Session-scoped instrumentation: one callback for the whole session, invoked
 * out of band. Only observations that need nothing but the environment belong
 * here. Per-request measurement is deliberately *not* one of them — see
 * `observeRequest` on `TerminalProviderRpcCallbacks`.
 */
export interface TerminalProviderRpcInstrumentation {
  observe?: (
    measurement: Parameters<NonNullable<TerminalProviderInstrumentation["observe"]>>[0],
  ) => void | Promise<void>;
}

export interface TerminalProviderRpcCallbacks {
  /**
   * Per-call rather than per-session, and awaited rather than deferred, for two
   * reasons the session-scoped form could not satisfy.
   *
   * A session callback is created once, outside any tool invocation, so the
   * caller cannot tell which of several concurrent tools a measurement belongs
   * to; a call-scoped one is created by the caller inside the invocation that
   * is about to issue the request, which is where the trace lives. And the
   * provider must await it: fired through `waitUntil`, the measurement raced
   * the RPC result and routinely lost, so the tool's own log row was written
   * before the last request it made had been counted.
   */
  observeRequest?: (measurement: TerminalProviderRequestMeasurement) => Promise<void>;
  assertSubmissionAuthority?: () => Promise<TerminalProviderRpcCallbackResult>;
  onSubmitted?: (providerTaskId: string) => Promise<TerminalProviderRpcCallbackResult>;
  initiallyAborted?: boolean;
  waitForAbort?: () => Promise<"aborted" | "finished">;
  finishAbortWait?: () => Promise<void>;
}

export interface TerminalProviderRpcSession {
  createSandbox(
    input: Parameters<TerminalSandboxProvider["createSandbox"]>[0],
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalProviderRpcResult<TerminalSandboxSnapshot>>;
  prepareSandbox(
    idOrName: string,
    expectedDomainAllowList: string[],
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalProviderRpcResult<TerminalSandboxSnapshot>>;
  getSandbox(
    idOrName: string,
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalProviderRpcResult<TerminalSandboxSnapshot>>;
  recoverSandbox(
    idOrName: string,
    options?: TerminalSandboxWaitOptions,
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalProviderRpcResult<void>>;
  startSandbox(
    idOrName: string,
    options?: TerminalSandboxWaitOptions,
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalProviderRpcResult<void>>;
  stopSandbox(idOrName: string, callbacks?: TerminalProviderRpcCallbacks): Promise<TerminalProviderRpcResult<void>>;
  archiveSandbox(idOrName: string, callbacks?: TerminalProviderRpcCallbacks): Promise<TerminalProviderRpcResult<void>>;
  deleteSandbox(idOrName: string, callbacks?: TerminalProviderRpcCallbacks): Promise<TerminalProviderRpcResult<void>>;
  updateNetworkPolicy(
    idOrName: string,
    domainAllowList: string[] | null,
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalProviderRpcResult<void>>;
  configureGitHubReadAccess(
    idOrName: string,
    input: Parameters<TerminalSandboxProvider["configureGitHubReadAccess"]>[1],
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalProviderRpcResult<void>>;
  clearGitHubReadAccess(idOrName: string, callbacks?: TerminalProviderRpcCallbacks): Promise<TerminalProviderRpcResult<void>>;
  readFile(idOrName: string, path: string, callbacks?: TerminalProviderRpcCallbacks): Promise<TerminalProviderRpcResult<Uint8Array>>;
  writeFile(
    idOrName: string,
    path: string,
    bytes: Uint8Array,
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalProviderRpcResult<void>>;
  runUtilityCommand(
    idOrName: string,
    input: TerminalUtilityCommandRpcInput,
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalProviderRpcResult<Awaited<ReturnType<TerminalSandboxProvider["runUtilityCommand"]>>>>;
  runCommand(
    idOrName: string,
    input: TerminalCommandRpcInput,
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalProviderRpcResult<Awaited<ReturnType<TerminalSandboxProvider["runCommand"]>>>>;
  cleanupCommand(
    idOrName: string,
    taskName: string,
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalProviderRpcResult<"deleted" | "missing" | void>>;
}

export interface TerminalProviderRpcBinding {
  createSession(
    configuration: SupportedTerminalConfiguration,
    instrumentation?: TerminalProviderRpcInstrumentation,
  ): Promise<TerminalProviderRpcSession>;
}
