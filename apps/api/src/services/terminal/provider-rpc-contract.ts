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

export interface TerminalProviderRpcCallbacks {
  observe?: (
    measurement: Parameters<NonNullable<TerminalProviderInstrumentation["observe"]>>[0],
  ) => void | Promise<void>;
  observeRequest?: (
    measurement: Parameters<NonNullable<TerminalProviderInstrumentation["observeRequest"]>>[0],
  ) => void | Promise<void>;
  assertSubmissionAuthority?: () => Promise<void>;
  onSubmitted?: (providerTaskId: string) => Promise<void>;
  waitForAbort?: () => Promise<"aborted" | "finished">;
  finishAbortWait?: () => Promise<void>;
}

export interface TerminalProviderRpcBinding {
  createSandbox(
    configuration: SupportedTerminalConfiguration,
    input: Parameters<TerminalSandboxProvider["createSandbox"]>[0],
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalSandboxSnapshot>;
  prepareSandbox(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    expectedDomainAllowList: string[],
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalSandboxSnapshot>;
  getSandbox(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<TerminalSandboxSnapshot>;
  startSandbox(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks): Promise<void>;
  stopSandbox(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks): Promise<void>;
  archiveSandbox(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks): Promise<void>;
  deleteSandbox(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks): Promise<void>;
  updateNetworkPolicy(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    domainAllowList: string[] | null,
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<void>;
  configureGitHubReadAccess(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    input: Parameters<TerminalSandboxProvider["configureGitHubReadAccess"]>[1],
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<void>;
  clearGitHubReadAccess(configuration: SupportedTerminalConfiguration, idOrName: string, callbacks?: TerminalProviderRpcCallbacks): Promise<void>;
  readFile(configuration: SupportedTerminalConfiguration, idOrName: string, path: string, callbacks?: TerminalProviderRpcCallbacks): Promise<Uint8Array>;
  writeFile(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    path: string,
    bytes: Uint8Array,
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<void>;
  runUtilityCommand(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    input: TerminalUtilityCommandRpcInput,
    callbacks?: TerminalProviderRpcCallbacks,
  ): ReturnType<TerminalSandboxProvider["runUtilityCommand"]>;
  runCommand(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    input: TerminalCommandRpcInput,
    callbacks?: TerminalProviderRpcCallbacks,
  ): ReturnType<TerminalSandboxProvider["runCommand"]>;
  cleanupCommand(
    configuration: SupportedTerminalConfiguration,
    idOrName: string,
    taskName: string,
    callbacks?: TerminalProviderRpcCallbacks,
  ): Promise<"deleted" | "missing" | void>;
}
