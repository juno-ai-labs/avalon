import { codeShaped } from "@rally/contracts/zod-diagnostics";
import type {
  TerminalProviderRequestMeasurement,
  TerminalUtilityOperation,
} from "./tracing";

/** Existing provider request bound used by durable submission fencing. */
export const DAYTONA_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Daytona's sandbox states, reduced to what Rally decides between.
 *
 * `unknown` is the fallback, and it is a member rather than a collapse into
 * `failed` because the difference is destructive: acquisition replaces a lost
 * sandbox, and Daytona publishes twenty-two states to this union's seven. A
 * state nobody has mapped — a newer SDK's, or one of the transitional ones —
 * must be waited out, never read as a verdict that the workspace is gone.
 */
export type TerminalSandboxState =
  | "starting"
  | "running"
  | "stopped"
  | "archived"
  | "expired"
  | "failed"
  | "unknown";

export interface TerminalSandboxSnapshot {
  id: string;
  name: string;
  state: TerminalSandboxState;
  domainAllowList: string[];
  labels?: Record<string, string> | undefined;
  /** Undefined means the provider has not established recoverability. */
  recoverable?: boolean | undefined;
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
  /**
   * Manifest ids the verification probe could not satisfy, when `failurePhase`
   * is `verify`; empty otherwise. Drawn from the manifest's fixed id set, never
   * from provider or user text, so it is safe to log and index.
   */
  missingCapabilities?: readonly string[];
}

export interface TerminalProviderInstrumentation {
  now?: () => number;
  observe?: (measurement: TerminalProviderOperationMeasurement) => void;
  /**
   * Awaited by the provider before the request it describes is allowed to
   * complete. A caller that reports across a Worker boundary needs that
   * ordering: deferred delivery let a tool log its own totals before its last
   * request had been counted.
   */
  observeRequest?: (measurement: TerminalProviderRequestMeasurement) => void | Promise<void>;
  /**
   * Whether `observeRequest` has anyone to report to right now. A caller whose
   * `observeRequest` is a fixed routing function rather than a listener
   * supplies this so measurement work is skipped when nothing is listening.
   */
  requestObserved?: () => boolean;
}

export interface CreateTerminalSandboxInput {
  stableName: string;
  workspaceId: string;
  workstreamId: string;
  /**
   * The conversation whose `AgentLoopDO` owns this sandbox. Carried as a
   * provider label so a Daytona event can be routed back to that conversation;
   * a sandbox created before the label existed belongs to the main one.
   */
  substreamId: string;
  generation: number;
  domainAllowList: string[];
  environment: Record<string, string>;
  /**
   * Have the provider delete the sandbox this many minutes after it stops.
   * Absent, the provider never deletes on its own and Rally's lifecycle sweep
   * is the only thing that retires the sandbox; set for a sandbox no sweep
   * reaches, which today is any under an automation.
   */
  autoDeleteAfterStoppedMinutes?: number;
}

/**
 * How long a caller that is itself on a deadline will wait for a sandbox to
 * report running.
 *
 * Starting an archived sandbox is a filesystem restore, and the provider call
 * that asks for it also waits for it. The two are separable: the request is
 * what makes Daytona restore, and the wait is only how long this caller stays
 * to watch. A wait that runs out therefore never means the sandbox is lost —
 * `resumeProviderSandbox` re-reads provider state precisely because the
 * restore is still on its way — so the bound belongs to whoever holds the
 * deadline, not to the adapter.
 */
export interface TerminalSandboxWaitOptions {
  /**
   * The wall-clock instant, in epoch milliseconds, the wait must not outlive.
   *
   * An instant rather than a duration because this crosses the provider RPC
   * hop and then waits on the adapter's own sandbox lookup before it reaches
   * the SDK: a duration would already be stale by then, and the wait would
   * outrun the deadline by however long those took. Whoever spends it
   * subtracts `Date.now()` at the point of use.
   *
   * Omitted leaves the Daytona SDK's own default in place. Only the lifecycle
   * alarm does that now, and not because it lacks a deadline — it is simply
   * not a restore path: it never starts an archived sandbox, so it cannot
   * reach the restore measurement this deadline exists to keep readable. Every
   * caller that *can* start an archived sandbox passes one.
   */
  deadlineAtMs?: number;
}

export interface TerminalSandboxProvider {
  createSandbox(input: CreateTerminalSandboxInput): Promise<TerminalSandboxSnapshot>;
  prepareSandbox?(idOrName: string, expectedDomainAllowList: string[]): Promise<TerminalSandboxSnapshot>;
  getSandbox(idOrName: string): Promise<TerminalSandboxSnapshot>;
  startSandbox(idOrName: string, options?: TerminalSandboxWaitOptions): Promise<void>;
  recoverSandbox(idOrName: string, options?: TerminalSandboxWaitOptions): Promise<void>;
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

/**
 * A provider failure after the RPC hop. `code` is what `terminalProviderErrorCode`
 * read from the original error; the message is the provider's own text.
 */
export class TerminalProviderError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "TerminalProviderError";
  }
}

/**
 * A provider failure as a code: the error's class, the HTTP status and the
 * provider's machine-readable code where it gave one. Never the message, which
 * is the provider's text and may carry identifiers.
 */
export function terminalProviderErrorCode(error: unknown): string {
  if (error instanceof TerminalProviderError) return error.code;
  if (!(error instanceof Error)) return "non_error_thrown";
  const value = error as { statusCode?: unknown; code?: unknown };
  const parts = [error.name];
  if (typeof value.statusCode === "number") parts.push(String(value.statusCode));
  if (typeof value.code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value.code)) parts.push(value.code);
  return codeShaped(parts.join(":"));
}

export function isTerminalProviderNotFound(error: unknown): boolean {
  if (error instanceof TerminalProviderNotFoundError) return true;
  if (typeof error !== "object" || error === null) return false;
  const value = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  return value.status === 404 || value.statusCode === 404 || value.response?.status === 404;
}

/** Only a metadata lookup can establish absence; a toolbox 404 cannot. */
export async function observeTerminalSandbox(
  provider: Pick<TerminalSandboxProvider, "getSandbox">,
  id: string,
): Promise<TerminalSandboxSnapshot | null> {
  try {
    return await provider.getSandbox(id);
  } catch (error) {
    if (isTerminalProviderNotFound(error)) return null;
    throw error;
  }
}

/** Missing recovery metadata is uncertainty, never permission to discard files. */
export function isTerminalSandboxLost(snapshot: TerminalSandboxSnapshot | null): boolean {
  return snapshot !== null && (snapshot.state === "expired"
    || (snapshot.state === "failed" && snapshot.recoverable === false));
}

/** A failed operation is reconciled through metadata, never its HTTP status. */
export async function deleteTerminalSandbox(provider: TerminalSandboxProvider, id: string): Promise<void> {
  try {
    await provider.deleteSandbox(id);
  } catch (error) {
    const observed = await observeTerminalSandbox(provider, id);
    if (observed && observed.state !== "expired") throw error;
  }
}

export async function stopTerminalSandbox(
  provider: TerminalSandboxProvider,
  id: string,
): Promise<"stopped" | "absent"> {
  try {
    await provider.stopSandbox(id);
    return "stopped";
  } catch (error) {
    const observed = await observeTerminalSandbox(provider, id);
    if (observed?.state === "expired") return "absent";
    if (observed?.state === "stopped" || observed?.state === "archived") return "stopped";
    throw error;
  }
}

/** A lifecycle state is not proof that either toolbox surface is serving requests. */
export async function assertTerminalSandboxReady(
  provider: Pick<TerminalSandboxProvider, "runUtilityCommand" | "readFile">,
  id: string,
): Promise<void> {
  // Read-only probes, using the existing provider request budget. Never replay
  // user work to establish readiness, and never infer deletion from this failure.
  const command = await provider.runUtilityCommand(id, {
    operation: "sandbox.readiness", command: ":", cwd: "/",
    timeoutMs: DAYTONA_REQUEST_TIMEOUT_MS,
  });
  if (command.exitCode !== 0 || command.timedOut) throw new Error("terminal_runner_not_ready");
  await provider.readFile(id, "/etc/hostname");
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
