import { Daytona } from "@daytona/sdk";
import { Buffer } from "node:buffer";

import type { TerminalRegionConfiguration } from "./contract";
import {
  TERMINAL_SNAPSHOT_PROBES,
  terminalManagedSnapshotBootstrapCommand,
  terminalSnapshotProbeCommand,
} from "./snapshot-manifest";
import type {
  TerminalProviderRequestMeasurement,
  TerminalProviderRequestOperation,
  TerminalUtilityOperation,
} from "./tracing";
import {
  DAYTONA_REQUEST_TIMEOUT_MS,
  isTerminalProviderNotFound,
  terminalProviderErrorCode,
  terminalShellQuote as shellQuote,
  type TerminalManagedBootstrapCapability,
  type TerminalProviderInstrumentation,
  type TerminalProviderOperationMeasurement,
  type TerminalSandboxProvider,
  type TerminalSandboxSnapshot,
  type TerminalSandboxState,
  type TerminalSandboxWaitOptions,
} from "./provider-contract";

export * from "./provider-contract";

type SupportedTerminalConfiguration = Extract<TerminalRegionConfiguration, { capability: "supported" }>;

export type DaytonaTerminalProvider = TerminalSandboxProvider & {
  prepareSandbox: NonNullable<TerminalSandboxProvider["prepareSandbox"]>;
  cleanupCommand: NonNullable<TerminalSandboxProvider["cleanupCommand"]>;
};

interface DaytonaSandboxLike {
  id: string;
  name: string;
  labels?: Record<string, string>;
  state?: string;
  recoverable?: boolean;
  domainAllowList?: string;
  refreshData?: () => Promise<void>;
  start?: (timeout?: number) => Promise<void>;
  recover?: (timeout?: number) => Promise<void>;
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

class TerminalSandboxInitializationError extends Error {
  /**
   * `missingCapabilities` carries the manifest ids the probe could not verify.
   *
   * The catch that raises this discards the underlying error, which is what made
   * a failed snapshot report only that initialization failed — the probe named
   * every missing capability and nothing carried it out. The ids come from the
   * manifest's fixed set, so this stays content-free.
   */
  constructor(readonly missingCapabilities: readonly string[] = []) {
    super(missingCapabilities.length > 0
      ? `Daytona could not initialize the private Rally workspace: missing ${missingCapabilities.join(", ")}`
      : "Daytona could not initialize the private Rally workspace");
    this.name = "TerminalSandboxInitializationError";
  }
}

/** Lifecycle state and recoverability are separate provider facts. */
function sandboxState(value: string | undefined): TerminalSandboxState {
  switch (value) {
    case "started":
    case "running":
      return "running";
    case "stopped":
    case "paused":
      return "stopped";
    case "archived":
      return "archived";
    case "destroyed":
    case "deleted":
      return "expired";
    // Every state in transit, in either direction. Each one settles into a
    // state Rally can act on, and none of them is a workspace that is gone.
    case "creating":
    case "starting":
    case "restoring":
    case "resuming":
    case "pending_build":
    case "building_snapshot":
    case "pulling_snapshot":
    case "stopping":
    case "archiving":
    case "pausing":
    case "destroying":
    case "resizing":
    case "snapshotting":
    case "forking":
      return "starting";
    case "error":
    case "build_failed":
      return "failed";
    default:
      return "unknown";
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
    recoverable: sandbox.recoverable,
    labels: sandbox.labels,
    domainAllowList: domainList(sandbox.domainAllowList),
  };
}

const defaultClientFactory: DaytonaClientFactory = (config) => new Daytona(config);
const MAX_STREAMED_COMMAND_LOG_BYTES = 5_000_000;

const MANAGED_BOOTSTRAP_CAPABILITIES = ["sqlite3", "gh", "pnpm", "tsx"] as const;

function parseInstalledCapabilities(output: string): TerminalManagedBootstrapCapability[] {
  const match = /^AVALON_BOOTSTRAP_INSTALLED=([^\r\n]*)$/mu.exec(output);
  if (!match) return [];
  const allowed = new Set<string>(MANAGED_BOOTSTRAP_CAPABILITIES);
  return [...new Set(match[1]!.split(",").filter((value) => allowed.has(value)))]
    .map((value) => value as TerminalManagedBootstrapCapability);
}

/**
 * The one detail a failed verification is worth reporting: which capabilities
 * the snapshot could not satisfy.
 *
 * The probe already names them all as `AVALON_PROBE_MISSING=<ids>` precisely so
 * a breaking managed-image update, or a rebuilt snapshot that lost something, is
 * one diagnostic. Discarding stdout threw that away and left "verification
 * failed" with nothing to act on. Filtering against the manifest's own ids keeps
 * this to a fixed enum, so no sandbox content travels out with it.
 */
function parseMissingCapabilities(output: string): string[] {
  const match = /^AVALON_PROBE_MISSING=([^\r\n]*)$/mu.exec(output);
  if (!match) return [];
  const allowed = new Set<string>(TERMINAL_SNAPSHOT_PROBES.map((probe) => probe.id));
  return [...new Set(match[1]!.split(/\s+/u).filter((value) => allowed.has(value)))];
}

export function createDaytonaTerminalProvider(
  configuration: SupportedTerminalConfiguration,
  clientFactory: DaytonaClientFactory = defaultClientFactory,
  instrumentation: TerminalProviderInstrumentation = {},
): DaytonaTerminalProvider {
  const client = clientFactory({
    apiKey: configuration.apiKey,
    apiUrl: configuration.apiUrl,
    target: configuration.target,
    requestTimeoutMs: DAYTONA_REQUEST_TIMEOUT_MS,
  });

  const now = instrumentation.now ?? Date.now;
  const observe = (measurement: TerminalProviderOperationMeasurement): void => {
    try {
      instrumentation.observe?.(measurement);
    } catch {
      // Measurement must never change provider behavior or sandbox durability.
    }
  };
  const elapsed = (start: number, end: number): number => Math.max(0, end - start);
  const measureRequest = async <T>(
    operation: TerminalProviderRequestOperation,
    callback: () => Promise<T>,
    options: {
      bytes?: number | ((result: T | undefined) => number);
      detail?: TerminalUtilityOperation;
      poll?: boolean;
    } = {},
  ): Promise<T> => {
    if (!instrumentation.observeRequest) return callback();
    // Cheap enough to ask per request, and it has to be per request: the one
    // provider instance serves callers that report and callers that do not.
    if (instrumentation.requestObserved?.() === false) return callback();
    const startedAt = now();
    let outcome: TerminalProviderRequestMeasurement["outcome"] = "completed";
    let result: T | undefined;
    let errorCode: string | undefined;
    try {
      result = await callback();
      return result;
    } catch (error) {
      outcome = "failed";
      errorCode = terminalProviderErrorCode(error);
      throw error;
    } finally {
      try {
        await instrumentation.observeRequest?.({
          operation,
          detail: options.detail ?? null,
          outcome,
          ...(errorCode ? { errorCode } : {}),
          durationMs: elapsed(startedAt, now()),
          requestCount: 1,
          pollCount: options.poll ? 1 : 0,
          bytes: typeof options.bytes === "function"
            ? Math.max(0, options.bytes(result))
            : options.bytes ?? 0,
        });
      } catch {
        // Measurement must never change provider behavior or sandbox durability.
      }
    }
  };
  // One provider instance belongs to one harness run. The coordinator already
  // acquires and verifies the sandbox once, so reuse the SDK object instead of
  // issuing a provider GET before every file or process operation.
  const loadedSandboxes = new Map<string, DaytonaSandboxLike>();
  const remember = (requested: string, sandbox: DaytonaSandboxLike): DaytonaSandboxLike => {
    loadedSandboxes.set(requested, sandbox);
    loadedSandboxes.set(sandbox.id, sandbox);
    loadedSandboxes.set(sandbox.name, sandbox);
    return sandbox;
  };
  const forget = (sandbox: DaytonaSandboxLike): void => {
    for (const [key, cached] of loadedSandboxes) {
      if (cached === sandbox) loadedSandboxes.delete(key);
    }
  };
  const load = async (idOrName: string): Promise<DaytonaSandboxLike> => {
    const cached = loadedSandboxes.get(idOrName);
    if (cached) return cached;
    return remember(idOrName, await measureRequest("sandbox.get", () => client.get(idOrName)));
  };
  const loadFresh = async (idOrName: string): Promise<DaytonaSandboxLike> => remember(
    idOrName,
    await measureRequest("sandbox.get", () => client.get(idOrName)),
  );
  const emptyDurations = {
    providerCreateMs: 0,
    policyReadbackMs: 0,
    installMs: 0,
    verifyMs: 0,
  } as const;

  /**
   * What is left of a caller's deadline, in the units `Sandbox.start` and
   * `Sandbox.recover` take.
   *
   * Call this immediately before the SDK call, never earlier: the sandbox
   * lookup above it is a provider round trip, and time spent there is the
   * caller's deadline being spent. `Date.now()` rather than the injected
   * `now`, which is a measurement fixture the tests drive as a fixed sequence
   * and not a wall clock.
   *
   * Three properties of the SDK decide the conversion. It reads seconds, and
   * rounding is *down* so a wait can never outlive the instant it was given.
   * It reads `0` as "wait forever", so a deadline already reached must not
   * arrive as `0` — one second is the smallest finite wait the SDK accepts,
   * and that sub-second overshoot is the floor's unavoidable cost rather than
   * a grace anyone chose. And it spends the same number twice: on the start
   * request itself (`{ timeout: seconds * 1000 }`) and then on the poll loop.
   *
   * That last one bounds what a reached deadline can promise. At the floor the
   * start request carries a 1000ms timeout of its own, so if Daytona's control
   * plane takes longer than that to answer, the client aborts the request
   * rather than the wait and nothing re-issues it. The start was sent; it may
   * not have been accepted. Only `resumeProviderSandbox` re-observing settles
   * which — and it does that on every path, so the caller is never left
   * assuming a restore that is not happening. `undefined` leaves the SDK's own
   * default (60 seconds) in place.
   */
  const waitSeconds = (options?: TerminalSandboxWaitOptions): number | undefined => (
    options?.deadlineAtMs === undefined
      ? undefined
      : Math.max(1, Math.floor((options.deadlineAtMs - Date.now()) / 1_000))
  );

  const secretPrefix = (idOrName: string) => `AVALON_READ_${idOrName.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 60)}_`;
  /**
   * Best effort, including the listing.
   *
   * The individual deletes were already tolerant, but the `list` that finds them
   * was not, and `deleteSandbox` calls this before the delete itself. A
   * credential without the Secrets scope therefore answered 403 here and the
   * sandbox was never deleted — a live filesystem left accruing cost because
   * tidying its read secrets failed. That trade is the wrong way round: a
   * leftover secret is scoped to a sandbox that no longer exists, while an
   * undeleted sandbox is real money and a real authority surface. Teardown
   * proceeds regardless. Revocation does not get that tolerance: a caller
   * clearing read access must know the secrets are gone, so its listing
   * failure still propagates.
   */
  const clearReadSecrets = async (
    idOrName: string,
    options: { tolerateListFailure: boolean },
  ): Promise<void> => {
    if (!client.secret) return;
    const prefix = secretPrefix(idOrName);
    const list = (): Promise<{ items: { id: string; name: string }[] } | null> => measureRequest(
      "secret.list",
      () => client.secret!.list({ name: prefix, limit: 20 }),
    );
    const page = options.tolerateListFailure ? await list().catch(() => null) : await list();
    if (!page) return;
    await Promise.all(page.items
      .filter((secret) => secret.name.startsWith(prefix))
      .map((secret) => measureRequest("secret.delete", () => client.secret!.delete(secret.id)).catch(() => undefined)));
  };

  return {
    async createSandbox(input) {
      const startedAt = now();
      let createFinishedAt = startedAt;
      let phase: TerminalProviderOperationMeasurement["failurePhase"] = "provider_create";
      try {
        const domains = input.domainAllowList.join(",");
        const sandbox = await measureRequest("sandbox.create", () => client.create({
          name: input.stableName,
          language: "typescript",
          snapshot: configuration.snapshot,
          public: false,
          autoStopInterval: 15,
          autoArchiveInterval: 60,
          // Daytona counts this from the stop; a negative value disables it,
          // which is what a sandbox Rally's own sweep retires asks for.
          autoDeleteInterval: input.autoDeleteAfterStoppedMinutes ?? -1,
          ttlMinutes: 0,
          domainAllowList: domains,
          envVars: input.environment,
          labels: {
            "rally.workspace": input.workspaceId,
            "rally.workstream": input.workstreamId,
            "rally.substream": input.substreamId,
            "rally.generation": String(input.generation),
          },
        }, { timeout: 60 }));
        createFinishedAt = now();
        phase = "policy_readback";
        // A successful create response only proves that Daytona accepted the
        // request. Read the provider-owned state back before the coordinator is
        // allowed to treat the egress policy as verified.
        const observed = await load(sandbox.id);
        if (observed.refreshData) await measureRequest("sandbox.refresh", () => observed.refreshData!());
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
      let missingCapabilities: string[] = [];
      let observed: DaytonaSandboxLike | null = null;
      try {
        observed = await load(idOrName);
        if (observed.refreshData) await measureRequest("sandbox.refresh", () => observed!.refreshData!());
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
        const initialized = await measureRequest("process.execute_utility", () => observed!.process!.executeCommand!(
          `bash -lc ${shellQuote(terminalManagedSnapshotBootstrapCommand())}`,
          undefined,
          undefined,
          120,
        ));
        if (initialized.exitCode !== 0) throw new Error("Rally workspace initialization failed");
        installFinishedAt = now();
        installedCapabilities = parseInstalledCapabilities(
          initialized.result ?? initialized.artifacts?.stdout ?? "",
        );
        phase = "verify";
        const verified = await measureRequest("process.execute_utility", () => observed!.process!.executeCommand!(
          `bash -lc ${shellQuote(terminalSnapshotProbeCommand({ requireGitCa: expectedDomainAllowList.length > 0 }))}`,
          undefined,
          undefined,
          120,
        ));
        if (verified.exitCode !== 0) {
          missingCapabilities = parseMissingCapabilities(
            verified.result ?? verified.artifacts?.stdout ?? "",
          );
          throw new Error("Rally workspace verification failed");
        }
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
          missingCapabilities,
        });
        if (observed?.delete) {
          await measureRequest("sandbox.delete", () => observed!.delete!(60, true)).catch(() => undefined);
        }
        throw new TerminalSandboxInitializationError(missingCapabilities);
      }
    },
    async getSandbox(idOrName) {
      const sandbox = await load(idOrName);
      if (sandbox.refreshData) await measureRequest("sandbox.refresh", () => sandbox.refreshData!());
      return snapshot(sandbox);
    },
    async startSandbox(idOrName, options) {
      const startedAt = now();
      let sourceState: TerminalSandboxState = "failed";
      try {
        const sandbox = await load(idOrName);
        sourceState = sandboxState(sandbox.state);
        if (!sandbox.start) throw new Error("Daytona sandbox does not support start");
        await measureRequest("sandbox.start", () => sandbox.start!(waitSeconds(options)));
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
    async recoverSandbox(idOrName, options) {
      const sandbox = await load(idOrName);
      if (!sandbox.recover) throw new Error("Daytona sandbox does not support recovery");
      await measureRequest("sandbox.recover", () => sandbox.recover!(waitSeconds(options)));
    },
    async stopSandbox(idOrName) {
      const sandbox = await load(idOrName);
      if (!sandbox.stop) throw new Error("Daytona sandbox does not support stop");
      await measureRequest("sandbox.stop", () => sandbox.stop!(60));
      forget(sandbox);
    },
    async archiveSandbox(idOrName) {
      const sandbox = await load(idOrName);
      if (!sandbox.archive) throw new Error("Daytona sandbox does not support archive");
      await measureRequest("sandbox.archive", () => sandbox.archive!());
      forget(sandbox);
    },
    async deleteSandbox(idOrName) {
      const sandbox = await load(idOrName);
      if (!sandbox.delete) throw new Error("Daytona sandbox does not support delete");
      await clearReadSecrets(sandbox.id, { tolerateListFailure: true });
      try {
        await measureRequest("sandbox.delete", () => sandbox.delete!(60, true));
        forget(sandbox);
      } catch (deleteError) {
        try {
          await loadFresh(sandbox.id);
        } catch (observationError) {
          if (isTerminalProviderNotFound(observationError)) {
            forget(sandbox);
            return;
          }
        }
        throw deleteError;
      }
    },
    async updateNetworkPolicy(idOrName, domains) {
      const sandbox = await load(idOrName);
      if (!sandbox.updateNetworkSettings) {
        throw new Error("Daytona sandbox does not support network policy updates");
      }
      await measureRequest("sandbox.update_network", () => sandbox.updateNetworkSettings!(domains === null
        ? { networkBlockAll: false }
        : { domainAllowList: domains.join(",") }));
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
      const existing = await measureRequest("secret.list", () => client.secret!.list({ name: prefix, limit: 20 }));
      let attachedNewSecret = false;
      for (const specification of specifications) {
        const current = existing.items.find((secret) => secret.name === specification.name);
        if (current) {
          await measureRequest("secret.update", () => client.secret!.update(current.id, { value: specification.value, hosts: [...specification.hosts] }));
        } else {
          await measureRequest("secret.create", () => client.secret!.create({
            name: specification.name,
            value: specification.value,
            description: `Rally GitHub repository access for ${sandbox.id}`,
            hosts: [...specification.hosts],
          }));
          attachedNewSecret = true;
        }
      }
      if (attachedNewSecret && sandbox.state === "started" && sandbox.stop) {
        await measureRequest("sandbox.stop", () => sandbox.stop!(60));
      }
      await measureRequest("sandbox.update_secrets", () => sandbox.updateSecrets!(Object.fromEntries(specifications.map((specification) => [specification.env, specification.name]))));
      if (attachedNewSecret && sandbox.start) await measureRequest("sandbox.start", () => sandbox.start!(60));
    },
    async clearGitHubReadAccess(idOrName) {
      const sandbox = await load(idOrName);
      if (sandbox.updateSecrets) await measureRequest("sandbox.update_secrets", () => sandbox.updateSecrets!({}));
      await clearReadSecrets(sandbox.id, { tolerateListFailure: false });
    },
    async readFile(idOrName, path) {
      const sandbox = await load(idOrName);
      if (!sandbox.fs) throw new Error("Daytona sandbox filesystem is unavailable");
      const bytes = new Uint8Array(await measureRequest(
        "file.download",
        () => sandbox.fs!.downloadFile(path, 120),
        { bytes: (value) => value?.byteLength ?? 0 },
      ));
      return bytes;
    },
    async writeFile(idOrName, path, bytes, signal) {
      throwIfFileTransferCancelled(signal);
      const sandbox = await load(idOrName);
      if (!sandbox.fs) throw new Error("Daytona sandbox filesystem is unavailable");
      throwIfFileTransferCancelled(signal);
      // Daytona's streaming helper is Node-only. uploadFile selects its Web
      // FormData implementation in Cloudflare Workers.
      await measureRequest("file.upload", () => sandbox.fs!.uploadFile(Buffer.from(bytes), path, 120), { bytes: bytes.byteLength });
      throwIfFileTransferCancelled(signal);
    },
    async runUtilityCommand(idOrName, input) {
      if (input.signal?.aborted) throw new Error("Terminal utility command cancelled");
      const sandbox = await load(idOrName);
      if (input.signal?.aborted) throw new Error("Terminal utility command cancelled");
      if (!sandbox.process?.executeCommand) throw new Error("Daytona process execution is unavailable");
      const timeoutSeconds = Math.max(1, Math.ceil(input.timeoutMs / 1_000));
      // executeCommand exposes one stdout-shaped result and no stderr channel,
      // so the private timeout marker must use that result before we strip it.
      const command = `(cd -- ${shellQuote(input.cwd)} || exit $?; if [ -f /workspace/.rally/session.env ]; then . /workspace/.rally/session.env || exit $?; fi; timeout --signal=TERM --kill-after=5s ${timeoutSeconds}s bash -lc ${shellQuote(input.command)}; rally_status=$?; if [ "$rally_status" -eq 124 ]; then printf '\\nAVALON_COMMAND_TIMED_OUT\\n'; fi; exit "$rally_status")`;
      const execution = measureRequest(
        "process.execute_utility",
        () => sandbox.process!.executeCommand!(command, undefined, undefined, timeoutSeconds + 10),
        {
          bytes: (value) => new TextEncoder().encode(value?.result ?? value?.artifacts?.stdout ?? "").byteLength,
          detail: input.operation,
        },
      );
      const cancelled = Symbol("terminal_utility_cancelled");
      let settleCancellation: ((value: typeof cancelled) => void) | null = null;
      const cancelledAfterQuiescence = new Promise<typeof cancelled>((resolve) => {
        settleCancellation = resolve;
      });
      let cancellationQuiescence: Promise<void> | null = null;
      const cancel = (): void => {
        if (cancellationQuiescence) return;
        cancellationQuiescence = (async () => {
          if (!sandbox.stop || !sandbox.start) {
            await execution.catch(() => undefined);
            return;
          }
          await measureRequest("sandbox.stop", () => sandbox.stop!(60));
          await measureRequest("sandbox.start", () => sandbox.start!(60));
        })();
        void cancellationQuiescence.then(
          () => settleCancellation?.(cancelled),
          async () => {
            // If quiescence could not be established, do not let ownership
            // hand off until the bounded provider execution itself settles.
            await execution.catch(() => undefined);
            settleCancellation?.(cancelled);
          },
        );
      };
      input.signal?.addEventListener("abort", cancel, { once: true });
      if (input.signal?.aborted) cancel();
      let outcome: Awaited<typeof execution> | typeof cancelled;
      try {
        outcome = await Promise.race([execution, cancelledAfterQuiescence]);
      } finally {
        input.signal?.removeEventListener("abort", cancel);
      }
      if (outcome === cancelled || input.signal?.aborted) {
        if (cancellationQuiescence) await cancellationQuiescence;
        void execution.catch(() => undefined);
        throw new Error("Terminal utility command cancelled");
      }
      const result = outcome;
      const stdout = result.result ?? result.artifacts?.stdout ?? "";
      const timedOut = result.exitCode === 124 && stdout.includes("AVALON_COMMAND_TIMED_OUT");
      return {
        exitCode: result.exitCode,
        stdout: stdout.replace(/\n?AVALON_COMMAND_TIMED_OUT\n?/gu, ""),
        stderr: "",
        ...(timedOut ? { timedOut: true } : {}),
      };
    },
    async runCommand(idOrName, input) {
      const sandbox = await load(idOrName);
      if (!sandbox.process) throw new Error("Daytona sandbox process service is unavailable");
      let cleanupRequest: Promise<void> | null = null;
      let cancelled = false;
      let terminal = false;
      const cleanup = async (suppressFailure: boolean): Promise<void> => {
        if (cleanupRequest) return cleanupRequest;
        cleanupRequest = (async () => {
          try {
            await measureRequest("process.session_delete", () => sandbox.process!.deleteSession(input.taskName));
          } catch (error) {
            if (!suppressFailure && !isTerminalProviderNotFound(error)) throw error;
          }
        })();
        return cleanupRequest;
      };
      let closeCreationWindow!: () => void;
      const creationWindowClosed = new Promise<void>((resolve) => {
        closeCreationWindow = resolve;
      });
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
        // Observations are safe to repeat; submission is not. Reuse the command's
        // existing observation budget and backoff for transient read failures.
        let observationDeadline = Date.now() + input.timeoutMs + 15_000;
        const observeCommand = async <T>(read: () => Promise<T>): Promise<T> => {
          let delayMs = 250;
          while (true) {
            if (input.signal?.aborted) throw new Error("Terminal command cancelled");
            try {
              return await read();
            } catch (error) {
              const response = error as { status?: number; statusCode?: number; response?: { status?: number } } | null;
              const status = response?.statusCode ?? response?.status ?? response?.response?.status;
              // Missing sessions and rejected credentials/requests need their
              // caller's decision, rather than a new session on a failed GET.
              if (isTerminalProviderNotFound(error)
                || (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429)
                || Date.now() + delayMs >= observationDeadline) throw error;
              await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
              delayMs = Math.min(2_000, delayMs * 2);
            }
          }
        };
        const readSession = () => observeCommand(() => measureRequest(
          "process.session_get", () => sandbox.process!.getSession!(input.taskName),
        ));
        const execution = (async () => {
          let commands: Array<{ id: string; command: string; exitCode?: number | null }> = [];
          try {
            commands = (await readSession()).commands;
          } catch (error) {
            if (!isTerminalProviderNotFound(error)) throw error;
            if (input.signal?.aborted) {
              cancelled = true;
              throw new Error("Terminal command cancelled", { cause: error });
            }
            await input.assertSubmissionAuthority?.();
            try {
              await measureRequest("process.session_create", () => sandbox.process!.createSession(input.taskName));
            } catch {
              // A create response can be lost after Daytona created the named
              // session. Resolve that ambiguity by loading the same name.
              commands = (await readSession()).commands;
            }
          }
          if (commands.length > 1) {
            throw new Error("The stable Daytona command session contains more than one command");
          }
          if (commands[0] && commands[0].command !== command) {
            await input.assertSubmissionAuthority?.();
            try {
              await measureRequest("process.session_delete", () => sandbox.process!.deleteSession(input.taskName));
            } catch (error) {
              if (sandbox.stop) await measureRequest("sandbox.stop", () => sandbox.stop!());
              throw error;
            }
            await input.assertSubmissionAuthority?.();
            try {
              await measureRequest("process.session_create", () => sandbox.process!.createSession(input.taskName));
              commands = [];
            } catch (error) {
              if (sandbox.stop) await measureRequest("sandbox.stop", () => sandbox.stop!());
              throw error;
            }
          }
          closeCreationWindow();
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
            const submitted = await measureRequest("process.session_submit", () => sandbox.process!.executeSessionCommand(input.taskName, {
              command,
              runAsync: true,
              suppressInputEcho: true,
            }, timeoutSeconds + 10));
            if (!submitted.cmdId) throw new Error("Daytona did not return a command identifier");
            commandId = submitted.cmdId;
            observedExitCode = submitted.exitCode ?? undefined;
            initialStdout = submitted.stdout;
            initialStderr = submitted.stderr;
          }
          await input.onSubmitted?.(commandId);
          let delayMs = 250;
          observationDeadline = Date.now() + input.timeoutMs + 15_000;
          while (observedExitCode === undefined) {
            if (Date.now() >= observationDeadline) {
              throw new Error("Daytona command outcome is still unknown after the observation deadline");
            }
            const observed = await observeCommand(() => measureRequest(
              "process.session_poll",
              () => sandbox.process!.getSessionCommand!(input.taskName, commandId),
              { poll: true },
            ));
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
          const logs = await observeCommand(() => {
            // A failed streaming read may have delivered a prefix. Start each
            // observation afresh so retrying cannot duplicate that prefix.
            stdoutChunks.length = 0;
            stderrChunks.length = 0;
            capturedBytes = 0;
            return measureRequest(
              "process.session_logs",
              () => sandbox.process!.getSessionCommandLogs!(
                input.taskName,
                commandId,
                (chunk) => capture("stdout", chunk),
                (chunk) => capture("stderr", chunk),
              ),
              { bytes: () => capturedBytes },
            );
          });
          const stdout = stdoutChunks.join("") || logs?.stdout || "";
          const stderr = stderrChunks.join("") || logs?.stderr || "";
          return {
            exitCode: observedExitCode,
            stdout: stdout || initialStdout || "",
            stderr: stderr || initialStderr || "",
          };
        })().finally(closeCreationWindow);
        const abort = input.signal ? new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            cancelled = true;
            void (async () => {
              // A delete can win before an in-flight create reaches Daytona.
              // Wait only for that pre-submission window, then delete again.
              await cleanup(true);
              await creationWindowClosed;
              cleanupRequest = null;
              await cleanup(true);
              reject(new Error("Terminal command cancelled"));
            })();
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
        await measureRequest("process.session_delete", () => sandbox.process!.deleteSession(taskName));
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
  };
}
