import { Daytona } from "@daytona/sdk";
import { Buffer } from "node:buffer";

import type { TerminalRegionConfiguration } from "./contract";
import {
  terminalManagedSnapshotBootstrapCommand,
  terminalSnapshotProbeCommand,
} from "./snapshot-manifest";

type SupportedTerminalConfiguration = Extract<TerminalRegionConfiguration, { capability: "supported" }>;

/** Existing Daytona client request bound used by durable submission fencing. */
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

interface TerminalProviderInstrumentation {
  now?: () => number;
  observe?: (measurement: TerminalProviderOperationMeasurement) => void;
}

export interface CreateTerminalSandboxInput {
  stableName: string;
  workspaceId: string;
  workstreamId: string;
  generation: number;
  domainAllowList: string[];
  environment: Record<string, string>;
}

interface DaytonaSandboxLike {
  id: string;
  name: string;
  state?: string;
  domainAllowList?: string;
  refreshData?: () => Promise<void>;
  start?: (timeout?: number) => Promise<void>;
  stop?: (timeout?: number, force?: boolean) => Promise<void>;
  archive?: () => Promise<void>;
  delete?: (timeout?: number, wait?: boolean) => Promise<void>;
  updateNetworkSettings?: (settings: { domainAllowList?: string; networkBlockAll?: boolean }) => Promise<void>;
  updateSecrets?: (secrets: Record<string, string>) => Promise<void>;
  fs?: {
    downloadFile(path: string, timeout?: number): Promise<Uint8Array>;
    uploadFile(source: Uint8Array, path: string, timeout?: number): Promise<void>;
  };
  process?: {
    executeCommand?(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<{
      exitCode: number;
      result?: string;
      artifacts?: { stdout: string };
    }>;
    createSession(sessionId: string): Promise<void>;
    getSession?(sessionId: string): Promise<{
      sessionId: string;
      commands: Array<{ id: string; command: string; exitCode?: number | null }>;
    }>;
    getSessionCommand?(sessionId: string, commandId: string): Promise<{
      id: string;
      command: string;
      exitCode?: number | null;
    }>;
    getSessionCommandLogs?(
      sessionId: string,
      commandId: string,
      onStdout?: (chunk: string) => void,
      onStderr?: (chunk: string) => void,
    ): Promise<{ stdout?: string; stderr?: string } | void>;
    executeSessionCommand(sessionId: string, request: {
      command: string;
      runAsync: boolean;
      suppressInputEcho: boolean;
    }, timeout?: number): Promise<{ cmdId?: string; exitCode?: number | null; stdout?: string; stderr?: string }>;
    deleteSession(sessionId: string): Promise<void>;
  };
}

interface DaytonaClientLike {
  create(params: Record<string, unknown>, options?: { timeout?: number }): Promise<DaytonaSandboxLike>;
  get(sandboxIdOrName: string): Promise<DaytonaSandboxLike>;
  secret?: {
    list(query?: { name?: string; limit?: number }): Promise<{ items: Array<{ id: string; name: string }>; total: number; nextCursor: string | null }>;
    create(input: { name: string; value: string; description?: string; hosts?: string[] }): Promise<{ id: string; name: string }>;
    update(id: string, input: { value?: string; description?: string; hosts?: string[] }): Promise<{ id: string; name: string }>;
    delete(id: string): Promise<void>;
  };
}

type DaytonaClientFactory = (config: {
  apiKey: string;
  apiUrl: string;
  target: string;
  requestTimeoutMs: number;
}) => DaytonaClientLike;

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
  runCommand(idOrName: string, input: {
    taskName: string;
    command: string;
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    retainSessionForRecovery?: boolean;
    /**
     * Re-check durable submission authority immediately before each provider
     * mutation that could create or execute the named command session.
     */
    assertSubmissionAuthority?: () => Promise<void>;
    onSubmitted?: (providerTaskId: string) => Promise<void>;
  }): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>;
  /**
   * Delete one named command session. Success confirms that session is
   * quiescent; failure leaves whole-sandbox stop/reconciliation to the caller
   * that owns the durable cleanup claim.
   */
  cleanupCommand?(idOrName: string, taskName: string): Promise<"deleted" | "missing" | void>;
  publishGitBundle(input: {
    operationId: string;
    bundle: Uint8Array;
    repositoryFullName: string;
    baseSha: string;
    headSha: string;
    headRef: string;
    expectedOldSha: string | null;
    githubBasicCredential: string;
  }): Promise<{ publishedSha: string }>;
}

export function isTerminalProviderNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  return value.status === 404 || value.statusCode === 404 || value.response?.status === 404;
}

class TerminalSandboxInitializationError extends Error {
  constructor() {
    super("Daytona could not initialize the private Rally workspace");
    this.name = "TerminalSandboxInitializationError";
  }
}

function sandboxState(value: string | undefined): TerminalSandboxState {
  switch (value) {
    case "started":
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    case "archived":
      return "archived";
    case "destroyed":
    case "deleted":
      return "expired";
    case "creating":
    case "starting":
    case "restoring":
      return "starting";
    default:
      return "failed";
  }
}

function throwIfFileTransferCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Terminal file transfer cancelled");
  error.name = "AbortError";
  throw error;
}

function domainList(value: string | undefined): string[] {
  return value?.split(",").map((domain) => domain.trim()).filter(Boolean) ?? [];
}

function snapshot(sandbox: DaytonaSandboxLike): TerminalSandboxSnapshot {
  return {
    id: sandbox.id,
    name: sandbox.name,
    state: sandboxState(sandbox.state),
    domainAllowList: domainList(sandbox.domainAllowList),
  };
}

const defaultClientFactory: DaytonaClientFactory = (config) => new Daytona(config);
const MAX_STREAMED_COMMAND_LOG_BYTES = 5_000_000;

function shellQuote(value: string): string {
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
      ? [`printf 'export GIT_SSL_CAINFO=%q\\n' "$GIT_SSL_CAINFO" >> ${shellQuote(input.sessionEnvPath)}`]
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

const MANAGED_BOOTSTRAP_CAPABILITIES = ["sqlite3", "gh", "pnpm", "tsx"] as const;

function parseInstalledCapabilities(output: string): TerminalManagedBootstrapCapability[] {
  const match = /^AVALON_BOOTSTRAP_INSTALLED=([^\r\n]*)$/mu.exec(output);
  if (!match) return [];
  const allowed = new Set<string>(MANAGED_BOOTSTRAP_CAPABILITIES);
  return [...new Set(match[1]!.split(",").filter((value) => allowed.has(value)))]
    .map((value) => value as TerminalManagedBootstrapCapability);
}

function assertTrustedGitInput(input: {
  repositoryFullName: string;
  baseSha: string;
  headSha: string;
  headRef: string;
  expectedOldSha: string | null;
}): void {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(input.repositoryFullName)) {
    throw new Error("The trusted publisher received an invalid repository name");
  }
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,200}$/u.test(input.headRef)
    || input.headRef.includes("..")
    || input.headRef.includes("//")
    || input.headRef.endsWith("/")
    || input.headRef.endsWith(".lock")
  ) throw new Error("The trusted publisher received an invalid head ref");
  for (const sha of [input.baseSha, input.headSha, ...(input.expectedOldSha ? [input.expectedOldSha] : [])]) {
    if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error("The trusted publisher received an invalid Git SHA");
  }
}

export function createDaytonaTerminalProvider(
  configuration: SupportedTerminalConfiguration,
  clientFactory: DaytonaClientFactory = defaultClientFactory,
  instrumentation: TerminalProviderInstrumentation = {},
): TerminalSandboxProvider {
  const client = clientFactory({
    apiKey: configuration.apiKey,
    apiUrl: configuration.apiUrl,
    target: configuration.target,
    requestTimeoutMs: DAYTONA_REQUEST_TIMEOUT_MS,
  });

  const load = async (idOrName: string): Promise<DaytonaSandboxLike> => client.get(idOrName);
  const now = instrumentation.now ?? Date.now;
  const observe = (measurement: TerminalProviderOperationMeasurement): void => {
    try {
      instrumentation.observe?.(measurement);
    } catch {
      // Measurement must never change provider behavior or sandbox durability.
    }
  };
  const elapsed = (start: number, end: number): number => Math.max(0, end - start);
  const emptyDurations = {
    providerCreateMs: 0,
    policyReadbackMs: 0,
    installMs: 0,
    verifyMs: 0,
  } as const;

  const secretPrefix = (idOrName: string) => `AVALON_READ_${idOrName.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 60)}_`;
  const clearReadSecrets = async (idOrName: string): Promise<void> => {
    if (!client.secret) return;
    const prefix = secretPrefix(idOrName);
    const page = await client.secret.list({ name: prefix, limit: 20 });
    await Promise.all(page.items
      .filter((secret) => secret.name.startsWith(prefix))
      .map((secret) => client.secret!.delete(secret.id).catch(() => undefined)));
  };

  return {
    async createSandbox(input) {
      const startedAt = now();
      let createFinishedAt = startedAt;
      let phase: TerminalProviderOperationMeasurement["failurePhase"] = "provider_create";
      try {
        const domains = input.domainAllowList.join(",");
        const sandbox = await client.create({
          name: input.stableName,
          language: "typescript",
          snapshot: configuration.snapshot,
          public: false,
          autoStopInterval: 15,
          autoArchiveInterval: 60,
          autoDeleteInterval: -1,
          ttlMinutes: 0,
          domainAllowList: domains,
          envVars: input.environment,
          labels: {
            "rally.workspace": input.workspaceId,
            "rally.workstream": input.workstreamId,
            "rally.generation": String(input.generation),
          },
        }, { timeout: 60 });
        createFinishedAt = now();
        phase = "policy_readback";
        // A successful create response only proves that Daytona accepted the
        // request. Read the provider-owned state back before the coordinator is
        // allowed to treat the egress policy as verified.
        const observed = await load(sandbox.id);
        await observed.refreshData?.();
        const finishedAt = now();
        observe({
          operation: "sandbox_create",
          outcome: "completed",
          snapshot: configuration.snapshot,
          sourceState: "absent",
          failurePhase: "none",
          durationMs: elapsed(startedAt, finishedAt),
          ...emptyDurations,
          providerCreateMs: elapsed(startedAt, createFinishedAt),
          policyReadbackMs: elapsed(createFinishedAt, finishedAt),
          installedCapabilities: [],
        });
        return snapshot(observed);
      } catch (error) {
        const finishedAt = now();
        observe({
          operation: "sandbox_create",
          outcome: "failed",
          snapshot: configuration.snapshot,
          sourceState: "absent",
          failurePhase: phase,
          durationMs: elapsed(startedAt, finishedAt),
          ...emptyDurations,
          providerCreateMs: phase === "provider_create"
            ? elapsed(startedAt, finishedAt)
            : elapsed(startedAt, createFinishedAt),
          policyReadbackMs: phase === "policy_readback" ? elapsed(createFinishedAt, finishedAt) : 0,
          installedCapabilities: [],
        });
        throw error;
      }
    },
    async prepareSandbox(idOrName, expectedDomainAllowList) {
      const startedAt = now();
      let readbackFinishedAt = startedAt;
      let installFinishedAt = startedAt;
      let phase: TerminalProviderOperationMeasurement["failurePhase"] = "policy_readback";
      let sourceState: TerminalSandboxState = "failed";
      let installedCapabilities: TerminalManagedBootstrapCapability[] = [];
      let observed: DaytonaSandboxLike | null = null;
      try {
        observed = await load(idOrName);
        await observed.refreshData?.();
        const observedSnapshot = snapshot(observed);
        sourceState = observedSnapshot.state;
        readbackFinishedAt = now();
        if (
          observedSnapshot.domainAllowList.slice().sort().join("\n")
          !== expectedDomainAllowList.slice().sort().join("\n")
        ) {
          observe({
            operation: "sandbox_bootstrap",
            outcome: "policy_mismatch",
            snapshot: configuration.snapshot,
            sourceState,
            failurePhase: "policy_readback",
            durationMs: elapsed(startedAt, readbackFinishedAt),
            ...emptyDurations,
            policyReadbackMs: elapsed(startedAt, readbackFinishedAt),
            installedCapabilities: [],
          });
          return observedSnapshot;
        }
        if (!observed.process?.executeCommand) throw new Error("Daytona process execution is unavailable");
        phase = "install";
        const initialized = await observed.process.executeCommand(
          `bash -lc ${shellQuote(terminalManagedSnapshotBootstrapCommand())}`,
          undefined,
          undefined,
          120,
        );
        if (initialized.exitCode !== 0) throw new Error("Rally workspace initialization failed");
        installFinishedAt = now();
        installedCapabilities = parseInstalledCapabilities(
          initialized.result ?? initialized.artifacts?.stdout ?? "",
        );
        phase = "verify";
        const verified = await observed.process.executeCommand(
          `bash -lc ${shellQuote(terminalSnapshotProbeCommand())}`,
          undefined,
          undefined,
          120,
        );
        if (verified.exitCode !== 0) throw new Error("Rally workspace verification failed");
        const finishedAt = now();
        observe({
          operation: "sandbox_bootstrap",
          outcome: "completed",
          snapshot: configuration.snapshot,
          sourceState,
          failurePhase: "none",
          durationMs: elapsed(startedAt, finishedAt),
          ...emptyDurations,
          policyReadbackMs: elapsed(startedAt, readbackFinishedAt),
          installMs: elapsed(readbackFinishedAt, installFinishedAt),
          verifyMs: elapsed(installFinishedAt, finishedAt),
          installedCapabilities,
        });
        return observedSnapshot;
      } catch {
        const finishedAt = now();
        observe({
          operation: "sandbox_bootstrap",
          outcome: "failed",
          snapshot: configuration.snapshot,
          sourceState,
          failurePhase: phase,
          durationMs: elapsed(startedAt, finishedAt),
          ...emptyDurations,
          policyReadbackMs: phase === "policy_readback"
            ? elapsed(startedAt, finishedAt)
            : elapsed(startedAt, readbackFinishedAt),
          installMs: phase === "install"
            ? elapsed(readbackFinishedAt, finishedAt)
            : elapsed(readbackFinishedAt, installFinishedAt),
          verifyMs: phase === "verify" ? elapsed(installFinishedAt, finishedAt) : 0,
          installedCapabilities,
        });
        await observed?.delete?.(60, true).catch(() => undefined);
        throw new TerminalSandboxInitializationError();
      }
    },
    async getSandbox(idOrName) {
      const sandbox = await load(idOrName);
      await sandbox.refreshData?.();
      return snapshot(sandbox);
    },
    async startSandbox(idOrName) {
      const startedAt = now();
      let sourceState: TerminalSandboxState = "failed";
      try {
        const sandbox = await load(idOrName);
        sourceState = sandboxState(sandbox.state);
        if (!sandbox.start) throw new Error("Daytona sandbox does not support start");
        await sandbox.start(60);
        const finishedAt = now();
        observe({
          operation: "sandbox_start", outcome: "completed", snapshot: configuration.snapshot,
          sourceState, failurePhase: "none", durationMs: elapsed(startedAt, finishedAt),
          ...emptyDurations, installedCapabilities: [],
        });
      } catch (error) {
        const finishedAt = now();
        observe({
          operation: "sandbox_start", outcome: "failed", snapshot: configuration.snapshot,
          sourceState, failurePhase: "start", durationMs: elapsed(startedAt, finishedAt),
          ...emptyDurations, installedCapabilities: [],
        });
        throw error;
      }
    },
    async stopSandbox(idOrName) {
      const sandbox = await load(idOrName);
      if (!sandbox.stop) throw new Error("Daytona sandbox does not support stop");
      await sandbox.stop(60);
    },
    async archiveSandbox(idOrName) {
      const sandbox = await load(idOrName);
      if (!sandbox.archive) throw new Error("Daytona sandbox does not support archive");
      await sandbox.archive();
    },
    async deleteSandbox(idOrName) {
      const sandbox = await load(idOrName);
      if (!sandbox.delete) throw new Error("Daytona sandbox does not support delete");
      await clearReadSecrets(sandbox.id);
      try {
        await sandbox.delete(60, true);
      } catch (deleteError) {
        try {
          await load(sandbox.id);
        } catch (observationError) {
          if (isTerminalProviderNotFound(observationError)) return;
        }
        throw deleteError;
      }
    },
    async updateNetworkPolicy(idOrName, domains) {
      const sandbox = await load(idOrName);
      if (!sandbox.updateNetworkSettings) {
        throw new Error("Daytona sandbox does not support network policy updates");
      }
      await sandbox.updateNetworkSettings(domains === null
        ? { networkBlockAll: false }
        : { domainAllowList: domains.join(",") });
    },
    async configureGitHubReadAccess(idOrName, input) {
      if (!client.secret) throw new Error("Daytona Secrets are unavailable for GitHub repository access");
      const sandbox = await load(idOrName);
      if (!sandbox.updateSecrets) throw new Error("Daytona sandbox secret mounting is unavailable");
      const prefix = secretPrefix(sandbox.id);
      const specifications = [
        { env: "GITHUB_READ_BASIC", name: `${prefix}GIT`, value: input.gitBasicCredential, hosts: ["github.com"] },
        { env: "GH_TOKEN", name: `${prefix}API`, value: input.ghToken, hosts: ["api.github.com"] },
      ] as const;
      const existing = await client.secret.list({ name: prefix, limit: 20 });
      let attachedNewSecret = false;
      for (const specification of specifications) {
        const current = existing.items.find((secret) => secret.name === specification.name);
        if (current) {
          await client.secret.update(current.id, { value: specification.value, hosts: [...specification.hosts] });
        } else {
          await client.secret.create({
            name: specification.name,
            value: specification.value,
            description: `Avalon GitHub repository access for ${sandbox.id}`,
            hosts: [...specification.hosts],
          });
          attachedNewSecret = true;
        }
      }
      if (attachedNewSecret && sandbox.state === "started" && sandbox.stop) await sandbox.stop(60);
      await sandbox.updateSecrets(Object.fromEntries(specifications.map((specification) => [specification.env, specification.name])));
      if (attachedNewSecret && sandbox.start) await sandbox.start(60);
    },
    async clearGitHubReadAccess(idOrName) {
      const sandbox = await load(idOrName);
      await sandbox.updateSecrets?.({});
      await clearReadSecrets(sandbox.id);
    },
    async readFile(idOrName, path) {
      const sandbox = await load(idOrName);
      if (!sandbox.fs) throw new Error("Daytona sandbox filesystem is unavailable");
      return new Uint8Array(await sandbox.fs.downloadFile(path, 120));
    },
    async writeFile(idOrName, path, bytes, signal) {
      throwIfFileTransferCancelled(signal);
      const sandbox = await load(idOrName);
      if (!sandbox.fs) throw new Error("Daytona sandbox filesystem is unavailable");
      throwIfFileTransferCancelled(signal);
      // Daytona's streaming helper is Node-only. uploadFile selects its Web
      // FormData implementation in Cloudflare Workers.
      await sandbox.fs.uploadFile(Buffer.from(bytes), path, 120);
      throwIfFileTransferCancelled(signal);
    },
    async runCommand(idOrName, input) {
      const sandbox = await load(idOrName);
      if (!sandbox.process) throw new Error("Daytona sandbox process service is unavailable");
      let cleaned = false;
      let cancelled = false;
      let terminal = false;
      const cleanup = async (suppressFailure: boolean): Promise<void> => {
        if (cleaned) return;
        cleaned = true;
        try {
          await sandbox.process!.deleteSession(input.taskName);
        } catch (error) {
          if (!suppressFailure && !isTerminalProviderNotFound(error)) throw error;
        }
      };
      try {
        const timeoutSeconds = Math.max(1, Math.ceil(input.timeoutMs / 1_000));
        if (input.signal?.aborted) {
          cancelled = true;
          throw new Error("Terminal command cancelled");
        }
        const command = `(cd -- ${shellQuote(input.cwd)} || exit $?; if [ -f /workspace/.rally/session.env ]; then . /workspace/.rally/session.env || exit $?; fi; timeout --signal=TERM --kill-after=5s ${timeoutSeconds}s bash -lc ${shellQuote(input.command)}; rally_status=$?; if [ "$rally_status" -eq 124 ]; then printf '\\nAVALON_COMMAND_TIMED_OUT\\n' >&2; fi; exit "$rally_status")`;
        const supportsObservation = Boolean(
          sandbox.process.getSession
          && sandbox.process.getSessionCommand
          && sandbox.process.getSessionCommandLogs,
        );
        if (!supportsObservation) {
          throw new Error("Daytona command observation is unavailable; Rally refused to execute an unrecoverable command");
        }
        const execution = (async () => {
          let commands: Array<{ id: string; command: string; exitCode?: number | null }> = [];
          try {
            commands = (await sandbox.process!.getSession!(input.taskName)).commands;
          } catch {
            if (input.signal?.aborted) {
              cancelled = true;
              throw new Error("Terminal command cancelled");
            }
            await input.assertSubmissionAuthority?.();
            try {
              await sandbox.process!.createSession(input.taskName);
            } catch {
              // A create response can be lost after Daytona created the named
              // session. Resolve that ambiguity by loading the same name.
              commands = (await sandbox.process!.getSession!(input.taskName)).commands;
            }
          }
          if (commands.length > 1) {
            throw new Error("The stable Daytona command session contains more than one command");
          }
          if (commands[0] && commands[0].command !== command) {
            await input.assertSubmissionAuthority?.();
            try {
              await sandbox.process!.deleteSession(input.taskName);
            } catch (error) {
              await sandbox.stop?.();
              throw error;
            }
            await input.assertSubmissionAuthority?.();
            try {
              await sandbox.process!.createSession(input.taskName);
              commands = [];
            } catch (error) {
              await sandbox.stop?.();
              throw error;
            }
          }
          let commandId = commands[0]?.id;
          let observedExitCode = commands[0]?.exitCode ?? undefined;
          let initialStdout: string | undefined;
          let initialStderr: string | undefined;
          if (!commandId) {
            if (input.signal?.aborted) {
              cancelled = true;
              throw new Error("Terminal command cancelled");
            }
            await input.assertSubmissionAuthority?.();
            const submitted = await sandbox.process!.executeSessionCommand(input.taskName, {
              command,
              runAsync: true,
              suppressInputEcho: true,
            }, timeoutSeconds + 10);
            if (!submitted.cmdId) throw new Error("Daytona did not return a command identifier");
            commandId = submitted.cmdId;
            observedExitCode = submitted.exitCode ?? undefined;
            initialStdout = submitted.stdout;
            initialStderr = submitted.stderr;
          }
          await input.onSubmitted?.(commandId);
          let delayMs = 250;
          const observationDeadline = Date.now() + input.timeoutMs + 15_000;
          while (observedExitCode === undefined) {
            if (Date.now() >= observationDeadline) {
              throw new Error("Daytona command outcome is still unknown after the observation deadline");
            }
            const observed = await sandbox.process!.getSessionCommand!(input.taskName, commandId);
            observedExitCode = observed.exitCode ?? undefined;
            if (observedExitCode === undefined) {
              await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
              delayMs = Math.min(2_000, delayMs * 2);
            }
          }
          const stdoutChunks: string[] = [];
          const stderrChunks: string[] = [];
          let capturedBytes = 0;
          const capture = (stream: "stdout" | "stderr", chunk: string) => {
            if (capturedBytes >= MAX_STREAMED_COMMAND_LOG_BYTES) return;
            const remaining = MAX_STREAMED_COMMAND_LOG_BYTES - capturedBytes;
            const bytes = new TextEncoder().encode(chunk);
            const boundedChunk = bytes.byteLength <= remaining
              ? chunk
              : new TextDecoder().decode(bytes.slice(0, remaining));
            capturedBytes += new TextEncoder().encode(boundedChunk).byteLength;
            if (stream === "stdout") stdoutChunks.push(boundedChunk);
            else stderrChunks.push(boundedChunk);
          };
          const logs = await sandbox.process!.getSessionCommandLogs!(
            input.taskName,
            commandId,
            (chunk) => capture("stdout", chunk),
            (chunk) => capture("stderr", chunk),
          );
          const stdout = stdoutChunks.join("") || logs?.stdout || "";
          const stderr = stderrChunks.join("") || logs?.stderr || "";
          return {
            exitCode: observedExitCode,
            stdout: stdout || initialStdout || "",
            stderr: stderr || initialStderr || "",
          };
        })();
        const abort = input.signal ? new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            cancelled = true;
            void cleanup(true).finally(() => reject(new Error("Terminal command cancelled")));
          };
          input.signal!.addEventListener("abort", onAbort, { once: true });
          void execution.finally(() => input.signal!.removeEventListener("abort", onAbort)).catch(() => undefined);
        }) : null;
        const result = await (abort ? Promise.race([execution, abort]) : execution);
        terminal = true;
        const timedOut = result.exitCode === 124 && (result.stderr ?? "").includes("AVALON_COMMAND_TIMED_OUT");
        return {
          exitCode: result.exitCode ?? 1,
          stdout: result.stdout ?? "",
          stderr: (result.stderr ?? "").replace(/\n?AVALON_COMMAND_TIMED_OUT\n?/gu, ""),
          ...(timedOut ? { timedOut: true } : {}),
        };
      } finally {
        if (cancelled || (terminal && !input.retainSessionForRecovery)) await cleanup(cancelled);
      }
    },
    async cleanupCommand(idOrName, taskName) {
      const sandbox = await load(idOrName);
      if (!sandbox.process) throw new Error("Daytona sandbox process service is unavailable");
      try {
        await sandbox.process.deleteSession(taskName);
        return "deleted";
      } catch (error) {
        // Recovery is token-fenced in the work-stream object, but an abandoned
        // provider request can return after its token expires. A missing named
        // session is already quiescent; treating that idempotent outcome as a
        // reason to stop the whole sandbox could disrupt the successor.
        if (isTerminalProviderNotFound(error)) return "missing";
        throw error;
      }
    },
    async publishGitBundle(input) {
      assertTrustedGitInput(input);
      if (input.bundle.byteLength > 50 * 1_048_576) {
        throw new Error("The Git bundle exceeds the 50 MiB publication limit");
      }
      if (!client.secret) throw new Error("Daytona Secrets are unavailable for trusted Git publication");
      const operationKey = input.operationId.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80);
      const secretName = `AVALON_GH_${operationKey}`;
      const existingSecrets = await client.secret.list({ name: secretName, limit: 20 });
      for (const existing of existingSecrets.items.filter((secret) => secret.name === secretName)) {
        await client.secret.delete(existing.id);
      }
      const secret = await client.secret.create({
        name: secretName,
        value: input.githubBasicCredential,
        description: `Ephemeral Avalon publication ${input.operationId}`,
        hosts: ["github.com"],
      });
      let publisher: DaytonaSandboxLike | null = null;
      try {
        publisher = await client.create({
          name: `rally-publisher-${operationKey}`.slice(0, 100),
          language: "typescript",
          snapshot: configuration.snapshot,
          public: false,
          ephemeral: true,
          autoStopInterval: 15,
          autoArchiveInterval: 60,
          autoDeleteInterval: 0,
          ttlMinutes: 30,
          domainAllowList: "github.com",
          secrets: { GITHUB_WRITE_BASIC: secret.name },
          labels: { "rally.publisher": input.operationId },
        }, { timeout: 60 });
        if (!publisher.fs || !publisher.process) throw new Error("The Daytona publisher sandbox is missing required services");
        await publisher.fs.uploadFile(Buffer.from(input.bundle), "/workspace/publication.bundle", 120);
        const repositoryUrl = `https://github.com/${input.repositoryFullName}.git`;
        const expectedOld = input.expectedOldSha ?? "";
        const command = [
          "set -euo pipefail",
          "export GIT_CONFIG_NOSYSTEM=1 HOME=/tmp/rally-publisher-home",
          ...terminalGitCaSetupCommands({ required: true }),
          'mkdir -p "$HOME"',
          "git init --bare /workspace/repository.git >/dev/null",
          `git -C /workspace/repository.git fetch /workspace/publication.bundle ${shellQuote(`refs/heads/${input.headRef}`)}:${shellQuote(`refs/heads/${input.headRef}`)}`,
          "git -C /workspace/repository.git fsck --strict",
          `test "$(git -C /workspace/repository.git rev-parse ${shellQuote(`refs/heads/${input.headRef}`)})" = ${shellQuote(input.headSha)}`,
          `git -C /workspace/repository.git merge-base --is-ancestor ${shellQuote(input.baseSha)} ${shellQuote(input.headSha)}`,
          `git -C /workspace/repository.git remote add origin ${shellQuote(repositoryUrl)}`,
          `git -C /workspace/repository.git config ${shellQuote(`http.${repositoryUrl}.extraheader`)} "Authorization: Basic $GITHUB_WRITE_BASIC"`,
          `remote_sha=$(git -C /workspace/repository.git ls-remote origin ${shellQuote(`refs/heads/${input.headRef}`)} | cut -f1)`,
          `test "$remote_sha" = ${shellQuote(expectedOld)}`,
          `git -C /workspace/repository.git push origin ${shellQuote(`${input.headSha}:refs/heads/${input.headRef}`)}`,
          `test "$(git -C /workspace/repository.git ls-remote origin ${shellQuote(`refs/heads/${input.headRef}`)} | cut -f1)" = ${shellQuote(input.headSha)}`,
          "printf 'published\\n'",
        ].join("\n");
        const sessionId = `rally-publisher-${operationKey}`;
        await publisher.process.createSession(sessionId);
        let result;
        try {
          result = await publisher.process.executeSessionCommand(sessionId, {
            command,
            runAsync: false,
            suppressInputEcho: true,
          }, 180);
        } finally {
          await publisher.process.deleteSession(sessionId);
        }
        if ((result.exitCode ?? 1) !== 0) {
          throw new Error(`Trusted Git publication failed with exit code ${result.exitCode ?? 1}`);
        }
        return { publishedSha: input.headSha };
      } finally {
        if (publisher?.delete) await publisher.delete(60, true).catch(() => undefined);
        await client.secret.delete(secret.id).catch(() => undefined);
      }
    },
  };
}
