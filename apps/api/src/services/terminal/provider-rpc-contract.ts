import type { TerminalRegionConfiguration } from "./contract";
import type {
  TerminalProviderInstrumentation,
  TerminalSandboxProvider,
  TerminalSandboxSnapshot,
} from "./provider-contract";

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

export interface TerminalProviderRpcInstrumentation {
  observe?: (
    measurement: Parameters<NonNullable<TerminalProviderInstrumentation["observe"]>>[0],
  ) => void | Promise<void>;
  observeRequest?: (
    measurement: Parameters<NonNullable<TerminalProviderInstrumentation["observeRequest"]>>[0],
  ) => void | Promise<void>;
}

export interface TerminalProviderRpcCallbacks {
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
  startSandbox(idOrName: string, callbacks?: TerminalProviderRpcCallbacks): Promise<TerminalProviderRpcResult<void>>;
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
