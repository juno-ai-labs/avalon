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

export interface TerminalProviderRpcCallbacks {
  observe?: (
    measurement: Parameters<NonNullable<TerminalProviderInstrumentation["observe"]>>[0],
  ) => void | Promise<void>;
  observeRequest?: (
    measurement: Parameters<NonNullable<TerminalProviderInstrumentation["observeRequest"]>>[0],
  ) => void | Promise<void>;
  assertSubmissionAuthority?: () => Promise<TerminalProviderRpcCallbackResult>;
  onSubmitted?: (providerTaskId: string) => Promise<TerminalProviderRpcCallbackResult>;
  initiallyAborted?: boolean;
  waitForAbort?: () => Promise<"aborted" | "finished">;
  finishAbortWait?: () => Promise<void>;
}

export interface TerminalProviderRpcBinding {
  createSandbox(
    configuration: SupportedTerminalConfiguration,
    input: Parameters<TerminalSandboxProvider["createSandbox"]>[0],
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalProviderRpcResult<TerminalSandboxSnapshot>>;
  prepareSandbox(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    expectedDomainAllowList: string[],
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalProviderRpcResult<TerminalSandboxSnapshot>>;
  getSandbox(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalProviderRpcResult<TerminalSandboxSnapshot>>;
  startSandbox(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks): Promise<TerminalProviderRpcResult<void>>;
  stopSandbox(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks): Promise<TerminalProviderRpcResult<void>>;
  archiveSandbox(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks): Promise<TerminalProviderRpcResult<void>>;
  deleteSandbox(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks): Promise<TerminalProviderRpcResult<void>>;
  updateNetworkPolicy(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    domainAllowList: string[] | null,
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalProviderRpcResult<void>>;
  configureGitHubReadAccess(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    input: Parameters<TerminalSandboxProvider["configureGitHubReadAccess"]>[1],
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalProviderRpcResult<void>>;
  clearGitHubReadAccess(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks): Promise<TerminalProviderRpcResult<void>>;
  readFile(configuration: SupportedTerminalConfiguration, idOrName: string, path: string, callbacks?: TerminalProviderRpcCallbacks): Promise<TerminalProviderRpcResult<Uint8Array>>;
  writeFile(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    path: string,
    bytes: Uint8Array,
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalProviderRpcResult<void>>;
  runUtilityCommand(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    input: TerminalUtilityCommandRpcInput,
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalProviderRpcResult<Awaited<ReturnType<TerminalSandboxProvider["runUtilityCommand"]>>>>;
  runCommand(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    input: TerminalCommandRpcInput,
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalProviderRpcResult<Awaited<ReturnType<TerminalSandboxProvider["runCommand"]>>>>;
  cleanupCommand(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    taskName: string,
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalProviderRpcResult<"deleted" | "missing" | void>>;
}
