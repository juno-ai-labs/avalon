import type {
  TerminalProviderRequestMeasurement,
  TerminalUtilityOperation,
} from "./tracing";

/** Existing provider request bound used by durable submission fencing. */
export const DAYTONA_REQUEST_TIMEOUT_MS = 120_000;

export type TerminalSandboxState =
  | "starting"
  | "running"
  | "stopped"
  | "archived"
  | "expired"
  | "failed";

export interface TerminalSandboxSnapshot {
  id: string;
  name: string;
  state: TerminalSandboxState;
  domainAllowList: string[];
}

export type TerminalManagedBootstrapCapability = "sqlite3" | "gh" | "pnpm" | "tsx";

export interface TerminalProviderOperationMeasurement {
  operation: "sandbox_create" | "sandbox_bootstrap" | "sandbox_start";
  outcome: "completed" | "failed" | "policy_mismatch";
  snapshot: string;
  sourceState: TerminalSandboxState | "absent";
  failurePhase: "none" | "provider_create" | "policy_readback" | "install" | "verify" | "start";
  durationMs: number;
  providerCreateMs: number;
  policyReadbackMs: number;
  installMs: number;
  verifyMs: number;
  installedCapabilities: TerminalManagedBootstrapCapability[];
}

export interface TerminalProviderInstrumentation {
  now?: () => number;
  observe?: (measurement: TerminalProviderOperationMeasurement) => void;
  observeRequest?: (measurement: TerminalProviderRequestMeasurement) => void;
}

export interface CreateTerminalSandboxInput {
  stableName: string;
  workspaceId: string;
  workstreamId: string;
  generation: number;
  domainAllowList: string[];
  environment: Record<string, string>;
}

export interface TerminalSandboxProvider {
  createSandbox(input: CreateTerminalSandboxInput): Promise<TerminalSandboxSnapshot>;
  prepareSandbox?(idOrName: string, expectedDomainAllowList: string[]): Promise<TerminalSandboxSnapshot>;
  getSandbox(idOrName: string): Promise<TerminalSandboxSnapshot>;
  startSandbox(idOrName: string): Promise<void>;
  stopSandbox(idOrName: string): Promise<void>;
  archiveSandbox(idOrName: string): Promise<void>;
  deleteSandbox(idOrName: string): Promise<void>;
  updateNetworkPolicy(idOrName: string, domainAllowList: string[] | null): Promise<void>;
  configureGitHubReadAccess(idOrName: string, input: {
    gitBasicCredential: string;
    ghToken: string;
  }): Promise<void>;
  clearGitHubReadAccess(idOrName: string): Promise<void>;
  readFile(idOrName: string, path: string): Promise<Uint8Array>;
  writeFile(idOrName: string, path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  runUtilityCommand(idOrName: string, input: {
    operation: TerminalUtilityOperation;
    command: string;
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>;
  runCommand(idOrName: string, input: {
    taskName: string;
    command: string;
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    retainSessionForRecovery?: boolean;
    assertSubmissionAuthority?: () => Promise<void>;
    onSubmitted?: (providerTaskId: string) => Promise<void>;
  }): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>;
  cleanupCommand?(idOrName: string, taskName: string): Promise<"deleted" | "missing" | void>;
}

export class TerminalProviderNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalProviderNotFoundError";
  }
}

export function isTerminalProviderNotFound(error: unknown): boolean {
  if (error instanceof TerminalProviderNotFoundError) return true;
  if (typeof error !== "object" || error === null) return false;
  const value = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  return value.status === 404 || value.statusCode === 404 || value.response?.status === 404;
}

export function terminalShellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

export function terminalGitCaSetupCommands(input: {
  required: boolean;
  sessionEnvPath?: string;
}): string[] {
  const setup = [
    "if [ ! -f \"$CURL_CA_BUNDLE\" ] || [ ! -s \"$CURL_CA_BUNDLE\" ] || [ ! -r \"$CURL_CA_BUNDLE\" ]; then",
    "  printf '%s\\n' 'Daytona advertised a missing, empty, or unreadable Git CA bundle.' >&2",
    "  exit 1",
    "fi",
    "export GIT_SSL_CAINFO=\"$CURL_CA_BUNDLE\"",
    ...(input.sessionEnvPath
      ? [`printf 'export GIT_SSL_CAINFO=%q\\n' "$GIT_SSL_CAINFO" >> ${terminalShellQuote(input.sessionEnvPath)}`]
      : []),
  ];
  return input.required
    ? [
        "if [ -z \"${CURL_CA_BUNDLE:-}\" ]; then",
        "  printf '%s\\n' 'Daytona did not advertise the Git CA bundle required for publication.' >&2",
        "  exit 1",
        "fi",
        ...setup,
      ]
    : ["if [ -n \"${CURL_CA_BUNDLE:-}\" ]; then", ...setup.map((command) => `  ${command}`), "fi"];
}
