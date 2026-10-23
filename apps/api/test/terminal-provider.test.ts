import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDaytonaTerminalProvider,
  terminalGitCaSetupCommands,
  type TerminalProviderOperationMeasurement,
} from "../src/services/terminal/daytona-provider";
import type { TerminalProviderRequestMeasurement } from "../src/services/terminal/tracing";

describe("Daytona Terminal provider", () => {
  it("executes Rally utility commands directly and traces each Daytona request", async () => {
    const measurements: TerminalProviderRequestMeasurement[] = [];
    const times = [0, 25, 25, 75, 75, 95];
    const executeCommand = vi.fn(async () => ({ exitCode: 0, result: "ready\n" }));
    const sandbox = {
      id: "sandbox-utility", name: "sandbox-utility", state: "started",
      process: {
        executeCommand,
        createSession: vi.fn(), executeSessionCommand: vi.fn(), deleteSession: vi.fn(),
      },
    };
    const get = vi.fn(async () => sandbox);
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get }), {
      now: vi.fn(() => times.shift()!),
      observeRequest: (measurement) => { measurements.push(measurement); },
    });

    await expect(provider.runUtilityCommand("sandbox-utility", {
      operation: "file.inspect", command: "printf ready", cwd: "/workspace", timeoutMs: 5_000,
    })).resolves.toEqual({ exitCode: 0, stdout: "ready\n", stderr: "" });
    await expect(provider.runUtilityCommand("sandbox-utility", {
      operation: "file.inspect", command: "printf ready", cwd: "/workspace", timeoutMs: 5_000,
    })).resolves.toEqual({ exitCode: 0, stdout: "ready\n", stderr: "" });

    expect(executeCommand).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledOnce();
    expect(executeCommand).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/cd -- '\/workspace'.*timeout .* 5s bash -lc 'printf ready'/u),
      undefined,
      undefined,
      15,
    );
    expect(measurements).toEqual([
      { operation: "sandbox.get", detail: null, outcome: "completed", durationMs: 25, requestCount: 1, pollCount: 0, bytes: 0 },
      { operation: "process.execute_utility", detail: "file.inspect", outcome: "completed", durationMs: 50, requestCount: 1, pollCount: 0, bytes: 6 },
      { operation: "process.execute_utility", detail: "file.inspect", outcome: "completed", durationMs: 20, requestCount: 1, pollCount: 0, bytes: 6 },
    ]);
  });

  it("detects direct-command timeouts in Daytona's stdout-only response", async () => {
    const executeCommand = vi.fn(async () => ({
      exitCode: 124,
      result: "\nAVALON_COMMAND_TIMED_OUT\n",
    }));
    const sandbox = {
      id: "sandbox-timeout", name: "sandbox-timeout", state: "started",
      process: {
        executeCommand,
        createSession: vi.fn(), executeSessionCommand: vi.fn(), deleteSession: vi.fn(),
      },
    };
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get: vi.fn(async () => sandbox) }));

    await expect(provider.runUtilityCommand(sandbox.id, {
      operation: "file.inspect", command: "sleep 10", cwd: "/workspace", timeoutMs: 5_000,
    })).resolves.toEqual({ exitCode: 124, stdout: "", stderr: "", timedOut: true });
    expect(executeCommand).toHaveBeenCalledWith(
      expect.not.stringContaining("AVALON_COMMAND_TIMED_OUT\\n' >&2"),
      undefined,
      undefined,
      15,
    );
  });

  it("does not execute a direct utility after cancellation wins during sandbox lookup", async () => {
    const controller = new AbortController();
    const executeCommand = vi.fn(async () => ({ exitCode: 0, result: "stale" }));
    const sandbox = {
      id: "sandbox-cancel-load", name: "sandbox-cancel-load", state: "started",
      process: {
        executeCommand,
        createSession: vi.fn(), executeSessionCommand: vi.fn(), deleteSession: vi.fn(),
      },
    };
    let finishLookup!: (value: typeof sandbox) => void;
    const get = vi.fn(async () => new Promise<typeof sandbox>((resolve) => { finishLookup = resolve; }));
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get }));

    const pending = provider.runUtilityCommand(sandbox.id, {
      operation: "file.inspect", command: "printf stale", cwd: "/workspace", timeoutMs: 5_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
    controller.abort();
    finishLookup(sandbox);

    await expect(pending).rejects.toThrow(/cancelled/iu);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("quiesces and restarts the sandbox when an in-flight direct utility is cancelled", async () => {
    const controller = new AbortController();
    let finishExecution!: (result: { exitCode: number; result: string }) => void;
    const executeCommand = vi.fn(async () => new Promise<{ exitCode: number; result: string }>((resolve) => {
      finishExecution = resolve;
    }));
    const stop = vi.fn(async () => undefined);
    const start = vi.fn(async () => undefined);
    const sandbox = {
      id: "sandbox-cancel-direct", name: "sandbox-cancel-direct", state: "started", stop, start,
      process: {
        executeCommand,
        createSession: vi.fn(), executeSessionCommand: vi.fn(), deleteSession: vi.fn(),
      },
    };
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get: vi.fn(async () => sandbox) }));

    const pending = provider.runUtilityCommand(sandbox.id, {
      operation: "file.replace", command: "sleep 100", cwd: "/workspace", timeoutMs: 120_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledOnce());
    controller.abort();
    finishExecution({ exitCode: 143, result: "" });

    await expect(pending).rejects.toThrow(/cancelled/iu);
    expect(stop).toHaveBeenCalledWith(60);
    expect(start).toHaveBeenCalledWith(60);
  });

  it("round-trips Daytona's Git CA path through a fresh Bash session", () => {
    const directory = mkdtempSync(join(tmpdir(), "avalon-terminal-ca-"));
    try {
      const caPath = join(directory, "proxy ca's bundle.pem");
      const sessionEnvPath = join(directory, "session.env");
      writeFileSync(caPath, "test certificate bundle");
      execFileSync("bash", ["-c", [
        "set -euo pipefail",
        ...terminalGitCaSetupCommands({ required: false, sessionEnvPath }),
      ].join("\n")], {
        env: { ...process.env, CURL_CA_BUNDLE: caPath },
      });

      const restored = execFileSync(
        "bash",
        ["-c", '. "$1"; printf "%s" "$GIT_SSL_CAINFO"', "_", sessionEnvPath],
        { encoding: "utf8" },
      );
      expect(restored).toBe(caPath);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    // The budget covers forking a real bash on a contended machine, not the assertion.
  }, 30_000);

  it("fails before the next operation when Daytona advertises an unreadable Git CA path", () => {
    const directory = mkdtempSync(join(tmpdir(), "avalon-terminal-ca-"));
    try {
      const markerPath = join(directory, "operation-ran");
      for (const required of [false, true]) {
        const command = [
          "set -euo pipefail",
          ...terminalGitCaSetupCommands({ required }),
          'printf invoked > "$AVALON_TEST_MARKER"',
        ].join("\n");

        expect(() => execFileSync("bash", ["-c", command], {
          env: {
            ...process.env,
            AVALON_TEST_MARKER: markerPath,
            CURL_CA_BUNDLE: join(directory, "missing-ca.pem"),
          },
        })).toThrow();
        expect(existsSync(markerPath)).toBe(false);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    // The budget covers forking a real bash twice on a contended machine, not the assertion.
  }, 30_000);

  it("creates a private managed sandbox with native policy and lifecycle backstops", async () => {
    const executeCommand = vi.fn()
      .mockResolvedValueOnce({ exitCode: 0, result: "AVALON_BOOTSTRAP_INSTALLED=sqlite3,gh,pnpm,tsx\n" })
      .mockResolvedValueOnce({ exitCode: 0, result: "bash:ok\n" });
    const created = {
      id: "sandbox-1",
      name: "avalon-ws-stream",
      state: "started",
    };
    const observed = {
      ...created,
      domainAllowList: "github.com,*.npmjs.org",
      refreshData: vi.fn(async () => undefined),
      process: {
        executeCommand,
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(async () => ({})),
        deleteSession: vi.fn(async () => undefined),
      },
    };
    const create = vi.fn(async () => created);
    const get = vi.fn(async () => observed);
    const clientFactory = vi.fn(() => ({
      create,
      get,
    }));
    const provider = createDaytonaTerminalProvider({
      capability: "supported",
      apiKey: "secret",
      apiUrl: "https://app.daytona.io/api",
      target: "us",
      snapshot: "daytona-small",
      emergencyDisabled: false,
    }, clientFactory);

    const createdSnapshot = await provider.createSandbox({
      stableName: "avalon-ws-stream",
      workspaceId: "workspace-1",
      workstreamId: "stream-1",
      substreamId: "0",
      generation: 1,
      domainAllowList: ["github.com", "*.npmjs.org"],
      environment: { AVALON_RESOURCE_DIR: "/workspace/.rally-output" },
    });
    expect(createdSnapshot).toEqual({
      id: "sandbox-1",
      name: "avalon-ws-stream",
      state: "running",
      domainAllowList: ["github.com", "*.npmjs.org"],
    });
    await expect(provider.prepareSandbox!(createdSnapshot.id, ["github.com", "*.npmjs.org"]))
      .resolves.toEqual(createdSnapshot);
    expect(create).toHaveBeenCalledWith({
      name: "avalon-ws-stream",
      language: "typescript",
      snapshot: "daytona-small",
      public: false,
      autoStopInterval: 15,
      autoArchiveInterval: 60,
      autoDeleteInterval: -1,
      ttlMinutes: 0,
      domainAllowList: "github.com,*.npmjs.org",
      envVars: { AVALON_RESOURCE_DIR: "/workspace/.rally-output" },
      labels: {
        "rally.workspace": "workspace-1",
        "rally.workstream": "stream-1",
        "rally.substream": "0",
        "rally.generation": "1",
      },
    }, { timeout: 60 });
    expect(clientFactory).toHaveBeenCalledWith({
      apiKey: "secret",
      apiUrl: "https://app.daytona.io/api",
      target: "us",
      requestTimeoutMs: 120_000,
    });
    expect(get).toHaveBeenCalledWith("sandbox-1");
    expect(observed.refreshData).toHaveBeenCalledTimes(2);
    expect(executeCommand).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/bash -lc .*sudo -n install.*sqlite3.*pnpm@11\.13\.0.*tsx@4\.20\.6.*AVALON_BOOTSTRAP_INSTALLED=/su),
      undefined,
      undefined,
      120,
    );
    expect(executeCommand).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/bash -lc .*python3 -c.*gh --version/su),
      undefined,
      undefined,
      120,
    );
  });

  it("asks Daytona to delete a sandbox after it stops only when the caller sets a retention", async () => {
    const created = { id: "sandbox-1", name: "avalon-run", state: "started" };
    const observed = {
      ...created,
      domainAllowList: "github.com",
      refreshData: vi.fn(async () => undefined),
      process: {
        executeCommand: vi.fn()
          .mockResolvedValue({ exitCode: 0, result: "AVALON_BOOTSTRAP_INSTALLED=sqlite3,gh,pnpm,tsx\nbash:ok\n" }),
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(async () => ({})),
        deleteSession: vi.fn(async () => undefined),
      },
    };
    const create = vi.fn(async () => created);
    const provider = createDaytonaTerminalProvider({
      capability: "supported",
      apiKey: "secret",
      apiUrl: "https://app.daytona.io/api",
      target: "us",
      snapshot: "daytona-small",
      emergencyDisabled: false,
    }, vi.fn(() => ({ create, get: vi.fn(async () => observed) })));

    await provider.createSandbox({
      stableName: "avalon-run",
      workspaceId: "workspace-1",
      workstreamId: "sidekick-1",
      substreamId: "run-1",
      generation: 1,
      domainAllowList: ["github.com"],
      environment: {},
      autoDeleteAfterStoppedMinutes: 43_200,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ autoStopInterval: 15, autoDeleteInterval: 43_200 }),
      { timeout: 60 },
    );
  });

  it("measures provisioning, compatibility installation, verification, and warming separately", async () => {
    const measurements: TerminalProviderOperationMeasurement[] = [];
    const times = [0, 100, 300, 400, 450, 2_450, 2_750, 3_000, 4_200];
    const now = vi.fn(() => times.shift()!);
    const executeCommand = vi.fn()
      .mockResolvedValueOnce({ exitCode: 0, result: "AVALON_BOOTSTRAP_INSTALLED=sqlite3,gh,pnpm\n" })
      .mockResolvedValueOnce({ exitCode: 0, result: "bash:ok\n" });
    const sandbox = {
      id: "sandbox-measured",
      name: "avalon-measured",
      state: "started",
      domainAllowList: "github.com",
      refreshData: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      process: {
        executeCommand,
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(async () => ({})),
        deleteSession: vi.fn(async () => undefined),
      },
    };
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "daytona-small", emergencyDisabled: false,
    }, () => ({
      create: vi.fn(async () => sandbox),
      get: vi.fn(async () => sandbox),
    }), { now, observe: (measurement) => measurements.push(measurement) });

    const created = await provider.createSandbox({
      stableName: sandbox.name, workspaceId: "workspace-1", workstreamId: "stream-1", substreamId: "0",
      generation: 1, domainAllowList: ["github.com"], environment: {},
    });
    await provider.prepareSandbox!(created.id, ["github.com"]);
    sandbox.state = "stopped";
    await provider.startSandbox(created.id);

    expect(measurements).toEqual([
      {
        operation: "sandbox_create", outcome: "completed", snapshot: "daytona-small",
        sourceState: "absent", failurePhase: "none", durationMs: 300,
        providerCreateMs: 100, policyReadbackMs: 200, installMs: 0, verifyMs: 0,
        installedCapabilities: [],
      },
      {
        operation: "sandbox_bootstrap", outcome: "completed", snapshot: "daytona-small",
        sourceState: "running", failurePhase: "none", durationMs: 2_350,
        providerCreateMs: 0, policyReadbackMs: 50, installMs: 2_000, verifyMs: 300,
        installedCapabilities: ["sqlite3", "gh", "pnpm"],
      },
      {
        operation: "sandbox_start", outcome: "completed", snapshot: "daytona-small",
        sourceState: "stopped", failurePhase: "none", durationMs: 1_200,
        providerCreateMs: 0, policyReadbackMs: 0, installMs: 0, verifyMs: 0,
        installedCapabilities: [],
      },
    ]);
    expect(now).toHaveBeenCalledTimes(9);
  });

  it("measures failed provider creation without exposing the provider error", async () => {
    const measurements: TerminalProviderOperationMeasurement[] = [];
    const times = [1_000, 1_750];
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "daytona-small", emergencyDisabled: false,
    }, () => ({
      create: vi.fn(async () => { throw new Error("provider detail must not enter analytics"); }),
      get: vi.fn(),
    }), {
      now: () => times.shift()!,
      observe: (measurement) => measurements.push(measurement),
    });

    await expect(provider.createSandbox({
      stableName: "avalon-failed", workspaceId: "workspace-1", workstreamId: "stream-1", substreamId: "0",
      generation: 1, domainAllowList: [], environment: {},
    })).rejects.toThrow("provider detail must not enter analytics");
    expect(measurements).toEqual([{
      operation: "sandbox_create", outcome: "failed", snapshot: "daytona-small",
      sourceState: "absent", failurePhase: "provider_create", durationMs: 750,
      providerCreateMs: 750, policyReadbackMs: 0, installMs: 0, verifyMs: 0,
      installedCapabilities: [],
    }]);
    expect(JSON.stringify(measurements)).not.toContain("provider detail");
  });

  it("reports only the provider-observed create policy", async () => {
    const created = { id: "sandbox-1", name: "avalon-ws-stream", state: "started" };
    const executeCommand = vi.fn(async () => ({ exitCode: 0 }));
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({
      create: vi.fn(async () => created),
      get: vi.fn(async () => ({
        ...created,
        domainAllowList: "",
        process: {
          executeCommand,
          createSession: vi.fn(async () => undefined),
          executeSessionCommand: vi.fn(async () => ({})),
          deleteSession: vi.fn(async () => undefined),
        },
      })),
    }));

    const createdSnapshot = await provider.createSandbox({
      stableName: "avalon-ws-stream", workspaceId: "workspace-1", workstreamId: "stream-1", substreamId: "0",
      generation: 1, domainAllowList: ["github.com"], environment: {},
    });
    await expect(provider.prepareSandbox!(createdSnapshot.id, ["github.com"]))
      .resolves.toMatchObject({ domainAllowList: [] });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("fails closed and discards a sandbox whose Avalon workspace cannot be initialized", async () => {
    const remove = vi.fn(async () => undefined);
    const created = { id: "sandbox-1", name: "avalon-ws-stream", state: "started" };
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({
      create: vi.fn(async () => created),
      get: vi.fn(async () => ({
        ...created,
        domainAllowList: "github.com",
        process: {
          executeCommand: vi.fn(async () => ({ exitCode: 1 })),
          createSession: vi.fn(async () => undefined),
          executeSessionCommand: vi.fn(async () => ({})),
          deleteSession: vi.fn(async () => undefined),
        },
        delete: remove,
      })),
    }));

    const createdSnapshot = await provider.createSandbox({
      stableName: "avalon-ws-stream", workspaceId: "workspace-1", workstreamId: "stream-1", substreamId: "0",
      generation: 1, domainAllowList: ["github.com"], environment: {},
    });
    await expect(provider.prepareSandbox!(createdSnapshot.id, ["github.com"]))
      .rejects.toMatchObject({ name: "TerminalSandboxInitializationError" });
    expect(remove).toHaveBeenCalledWith(60, true);
  });

  describe("deadline conversion", () => {
    // Installed and restored in hooks rather than the test body, per
    // docs/testing.md: a restore a throwing assertion can skip is not a
    // restore, and this one spans every case below.
    const WALL_CLOCK_BASE = 1_000_000_000_000;
    let wallClock = WALL_CLOCK_BASE;

    beforeEach(() => {
      wallClock = WALL_CLOCK_BASE;
      vi.spyOn(Date, "now").mockImplementation(() => wallClock);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const deadlineProvider = (get: () => Promise<unknown>) => createDaytonaTerminalProvider({
      capability: "supported",
      apiKey: "secret",
      apiUrl: "https://app.daytona.io/api",
      target: "us",
      snapshot: "snapshot",
      emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get: vi.fn(get) }) as never);

    it("charges its own sandbox lookup against the caller's deadline", async () => {
      const sandbox = {
        id: "sandbox-1",
        name: "avalon-ws-stream",
        state: "stopped",
        domainAllowList: "github.com",
        start: vi.fn(async () => undefined),
        recover: vi.fn(async () => undefined),
      };
      // The lookup ahead of the SDK call is a provider round trip, and the
      // time it takes is the caller's deadline being spent. A wait computed
      // before it would let the restore outlive the deadline by this much.
      const provider = deadlineProvider(async () => {
        wallClock += 20_000;
        return sandbox;
      });

      await provider.startSandbox("sandbox-1", { deadlineAtMs: WALL_CLOCK_BASE + 90_000 });

      expect(sandbox.start).toHaveBeenCalledWith(70);
    });

    it("rounds a deadline down to Daytona's seconds and never asks it to wait forever", async () => {
      const sandbox = {
        id: "sandbox-1",
        name: "avalon-ws-stream",
        state: "stopped",
        domainAllowList: "github.com",
        start: vi.fn(async () => undefined),
        recover: vi.fn(async () => undefined),
      };
      const provider = deadlineProvider(async () => sandbox);

      // Down, not up: 94.5s left may not become a 95s wait, or the wait
      // outlives the instant it was given.
      await provider.startSandbox("sandbox-1", { deadlineAtMs: WALL_CLOCK_BASE + 94_500 });
      await provider.recoverSandbox("sandbox-1", { deadlineAtMs: WALL_CLOCK_BASE + 94_500 });
      // A deadline already reached still sends the start, so the next tool
      // call finds a restore that has at least been requested. Zero is the one
      // value that must not reach the SDK: it reads it as "wait forever".
      await provider.startSandbox("sandbox-1", { deadlineAtMs: WALL_CLOCK_BASE });
      await provider.startSandbox("sandbox-1", { deadlineAtMs: WALL_CLOCK_BASE - 30_000 });

      expect(sandbox.start.mock.calls).toEqual([[94], [1], [1]]);
      expect(sandbox.recover).toHaveBeenCalledWith(94);
    });
  });

  it("looks up ambiguous creates by stable name and delegates explicit lifecycle changes", async () => {
    const sandbox = {
      id: "sandbox-1",
      name: "avalon-ws-stream",
      state: "stopped",
      domainAllowList: "github.com",
      refreshData: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      archive: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      updateNetworkSettings: vi.fn(async () => undefined),
    };
    const get = vi.fn(async () => sandbox);
    const provider = createDaytonaTerminalProvider({
      capability: "supported",
      apiKey: "secret",
      apiUrl: "https://app.daytona.io/api",
      target: "us",
      snapshot: "snapshot",
      emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get }));

    await expect(provider.getSandbox("avalon-ws-stream")).resolves.toMatchObject({
      id: "sandbox-1",
      name: "avalon-ws-stream",
      state: "stopped",
      domainAllowList: ["github.com"],
    });
    await provider.startSandbox("sandbox-1");
    await provider.stopSandbox("sandbox-1");
    await provider.archiveSandbox("sandbox-1");
    await provider.updateNetworkPolicy("sandbox-1", ["pypi.org", "*.pythonhosted.org"]);
    await provider.deleteSandbox("sandbox-1");

    expect(get).toHaveBeenCalledWith("avalon-ws-stream");
    // No caller budget leaves the SDK's own default wait in place, which is
    // what the lifecycle alarm and repository checkout want.
    expect(sandbox.start).toHaveBeenCalledWith(undefined);
    expect(sandbox.stop).toHaveBeenCalledWith(60);
    expect(sandbox.archive).toHaveBeenCalledOnce();
    expect(sandbox.updateNetworkSettings).toHaveBeenCalledWith({ domainAllowList: "pypi.org,*.pythonhosted.org" });
    expect(sandbox.delete).toHaveBeenCalledWith(60, true);
  });

  it("exposes recovery metadata and invokes Daytona recovery on the same sandbox", async () => {
    const sandbox = {
      id: "sandbox-1", name: "retained", state: "error", recoverable: true,
      recover: vi.fn(async () => { sandbox.state = "started"; }),
    };
    const create = vi.fn();
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({ create, get: vi.fn(async () => sandbox) }));
    await expect(provider.getSandbox("sandbox-1")).resolves.toMatchObject({ state: "failed", recoverable: true });
    await provider.recoverSandbox("sandbox-1");
    expect(sandbox.recover).toHaveBeenCalledWith(undefined);
    await expect(provider.getSandbox("sandbox-1")).resolves.toMatchObject({ id: "sandbox-1", state: "running" });
    expect(create).not.toHaveBeenCalled();
  });

  it("reports transitional states without turning them into failure verdicts", async () => {
    // Daytona auto-stops and auto-archives on its own schedule.
    // A tool call landing inside one of those transitions must
    // not read as a verdict that the workspace is gone.
    const observed = [
      ["stopping", "starting"],
      ["archiving", "starting"],
      ["destroying", "starting"],
      ["pausing", "starting"],
      ["resizing", "starting"],
      ["snapshotting", "starting"],
      ["forking", "starting"],
      ["pulling_snapshot", "starting"],
      ["resuming", "starting"],
      ["paused", "stopped"],
      // Failure state is separate from the recovery verdict.
      ["error", "failed"],
      ["build_failed", "failed"],
      ["destroyed", "expired"],
      // Anything a later SDK adds waits rather than being replaced.
      ["a_state_this_sdk_has_never_published", "unknown"],
    ] as const;
    const get = vi.fn(async (name: string) => ({ id: "sandbox-1", name: "stable", state: name }));
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get }));

    for (const [daytonaState, expected] of observed) {
      await expect(provider.getSandbox(daytonaState), daytonaState)
        .resolves.toMatchObject({ state: expected });
    }
  });

  it("evicts every alias after lifecycle changes", async () => {
    const first = {
      id: "sandbox-alias", name: "provider-stable-name", state: "started",
      stop: vi.fn(async () => undefined),
    };
    const second = {
      id: "sandbox-alias", name: "provider-stable-name", state: "stopped",
      archive: vi.fn(async () => undefined),
    };
    const third = {
      id: "sandbox-alias", name: "provider-stable-name", state: "archived",
      delete: vi.fn(async () => undefined),
    };
    const replacement = {
      id: "sandbox-replacement", name: "provider-stable-name", state: "started",
    };
    const get = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(third)
      .mockResolvedValueOnce(replacement);
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get }));

    await provider.getSandbox("historical-alias");
    await provider.stopSandbox(first.id);
    await expect(provider.getSandbox("historical-alias")).resolves.toMatchObject({ state: "stopped" });
    await provider.archiveSandbox(first.id);
    await expect(provider.getSandbox("historical-alias")).resolves.toMatchObject({ state: "archived" });
    await provider.deleteSandbox(first.id);
    await expect(provider.getSandbox("historical-alias")).resolves.toMatchObject({ id: "sandbox-replacement" });

    expect(get).toHaveBeenCalledTimes(4);
  });

  it("reconciles a lost delete response from provider absence", async () => {
    const remove = vi.fn(async () => { throw new Error("delete response timed out"); });
    const sandbox = { id: "sandbox-1", name: "sandbox", state: "started", delete: remove };
    const get = vi.fn()
      .mockResolvedValueOnce(sandbox)
      .mockRejectedValueOnce({ statusCode: 404 });
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get }));

    await expect(provider.deleteSandbox("sandbox-1")).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith(60, true);
    expect(get).toHaveBeenNthCalledWith(2, "sandbox-1");
  });

  it("does not create a command session after a rejected lookup", async () => {
    const createSession = vi.fn();
    const executeSessionCommand = vi.fn();
    const refused = Object.assign(new Error("provider authentication rejected"), { statusCode: 401 });
    const provider = createDaytonaTerminalProvider({ capability: "supported", apiKey: "fixture",
      apiUrl: "https://daytona.example.test", target: "us", snapshot: "fixture", emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get: async () => ({ id: "sandbox", name: "fixture", state: "started",
      process: { createSession, executeSessionCommand, deleteSession: vi.fn(),
        getSession: async () => { throw refused; }, getSessionCommand: vi.fn(), getSessionCommandLogs: vi.fn() },
    }) }));
    await expect(provider.runCommand("sandbox", { taskName: "stable", command: "printf ok", cwd: "/workspace",
      timeoutMs: 1_000, retainSessionForRecovery: true,
    })).rejects.toBe(refused);
    expect(createSession).not.toHaveBeenCalled();
    expect(executeSessionCommand).not.toHaveBeenCalled();
  });

  it("retains the accepted command when transient observations exhaust the existing deadline", async () => {
    vi.useFakeTimers();
    try {
      const unavailable = Object.assign(new Error("provider unavailable"), { statusCode: 503 });
      const executeSessionCommand = vi.fn(async () => ({ cmdId: "accepted-command", exitCode: null }));
      const deleteSession = vi.fn();
      const provider = createDaytonaTerminalProvider({ capability: "supported", apiKey: "fixture",
        apiUrl: "https://daytona.example.test", target: "us", snapshot: "fixture", emergencyDisabled: false,
      }, () => ({ create: vi.fn(), get: async () => ({ id: "sandbox", name: "fixture", state: "started",
        process: { createSession: vi.fn(), executeSessionCommand, deleteSession,
          getSession: async () => { throw Object.assign(new Error("missing"), { statusCode: 404 }); },
          getSessionCommand: async () => { throw unavailable; }, getSessionCommandLogs: vi.fn() },
      }) }));
      const pending = expect(provider.runCommand("sandbox", { taskName: "stable", command: "printf ok", cwd: "/workspace",
        timeoutMs: 1_000, retainSessionForRecovery: true,
      })).rejects.toBe(unavailable);
      await vi.runAllTimersAsync();
      await pending;
      expect(executeSessionCommand).toHaveBeenCalledOnce();
      expect(deleteSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["get", "poll", "logs"] as const)("returns to recovery when a session %s read hangs beyond the remaining budget", async (stage) => {
    vi.useFakeTimers();
    try {
      const hang = () => new Promise<never>(() => undefined);
      const executeSessionCommand = vi.fn(async (): Promise<{ cmdId: string; exitCode: number | null }> => ({ cmdId: "accepted-command", exitCode: stage === "poll" ? null : 0 }));
      const getSession = vi.fn(async () => {
        if (stage === "get") return hang();
        throw Object.assign(new Error("missing"), { statusCode: 404 });
      });
      const poll = vi.fn(async () => stage === "poll" ? hang() : { id: "accepted-command", command: "opaque", exitCode: 0 });
      const provider = createDaytonaTerminalProvider({ capability: "supported", apiKey: "fixture",
        apiUrl: "https://daytona.example.test", target: "us", snapshot: "fixture", emergencyDisabled: false,
      }, () => ({ create: vi.fn(), get: async () => ({ id: "sandbox", name: "fixture", state: "started",
        process: { createSession: vi.fn(), executeSessionCommand, deleteSession: vi.fn(), getSession,
          getSessionCommand: poll, getSessionCommandLogs: hang },
      }) }));
      const startedAt = Date.now();
      const result = expect(provider.runCommand("sandbox", { taskName: "stable", command: "printf ok", cwd: "/workspace",
        timeoutMs: 1_000, retainSessionForRecovery: true,
      })).rejects.toMatchObject({ code: "command_observation_deadline" });
      await vi.advanceTimersByTimeAsync(16_000);
      await result;
      expect(Date.now() - startedAt).toBe(16_000);
      expect(getSession).toHaveBeenCalledOnce();
      expect(executeSessionCommand).toHaveBeenCalledTimes(stage === "get" ? 0 : 1);
      if (stage === "poll") expect(poll).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves file bytes without host paths and runs one non-interactive session command", async () => {
    const uploadFile = vi.fn(async () => undefined);
    const downloadFile = vi.fn(async () => new Uint8Array([104, 105]));
    const createSession = vi.fn(async () => undefined);
    const executeSessionCommand = vi.fn(async (
      sessionId: string,
      request: { command: string; runAsync: boolean; suppressInputEcho: boolean },
    ) => {
      void sessionId;
      void request;
      return { cmdId: "cmd-1", exitCode: null };
    });
    const getSession = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("not found"), { statusCode: 404 }))
      .mockResolvedValue({ sessionId: "avalon-task-1", commands: [] });
    const getSessionCommand = vi.fn(async () => ({ id: "cmd-1", command: "envelope", exitCode: 0 }));
    const getSessionCommandLogs = vi.fn(async (_sessionId, _commandId, onStdout?: (chunk: string) => void) => {
      onStdout?.("ok\n");
    });
    const deleteSession = vi.fn(async () => undefined);
    const sandbox = {
      id: "sandbox-1", name: "sandbox", state: "started",
      fs: { uploadFile, downloadFile },
      process: { createSession, getSession, getSessionCommand, getSessionCommandLogs, executeSessionCommand, deleteSession },
    };
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get: vi.fn(async () => sandbox) }));

    await provider.writeFile("sandbox-1", "workspace/hello.txt", new TextEncoder().encode("hi"), new AbortController().signal);
    await expect(provider.readFile("sandbox-1", "workspace/hello.txt")).resolves.toEqual(new Uint8Array([104, 105]));
    await expect(provider.runCommand("sandbox-1", {
      taskName: "avalon-task-1", command: "printf ok", cwd: "workspace", timeoutMs: 120_000,
    })).resolves.toEqual({ exitCode: 0, stdout: "ok\n", stderr: "" });

    expect(uploadFile).toHaveBeenCalledWith(expect.any(Uint8Array), "workspace/hello.txt", 120);
    expect(downloadFile).toHaveBeenCalledWith("workspace/hello.txt", 120);
    expect(executeSessionCommand).toHaveBeenCalledWith("avalon-task-1", {
      command: expect.stringMatching(/^\(cd -- 'workspace' \|\| exit \$\?;.*timeout --signal=TERM --kill-after=5s 120s bash -lc 'printf ok'/u),
      runAsync: true,
      suppressInputEcho: true,
    }, 130);
    expect(executeSessionCommand).toHaveBeenCalledWith("avalon-task-1", {
      command: expect.stringContaining("rally_status=$?"),
      runAsync: true,
      suppressInputEcho: true,
    }, 130);
    const submittedCommand = executeSessionCommand.mock.calls[0]?.[1].command;
    expect(submittedCommand).toMatch(/^\(.*; exit "\$rally_status"\)$/u);
    expect(deleteSession).toHaveBeenCalledWith("avalon-task-1");
  });

  it("does not report a completed write when its Worker deadline expires during upload", async () => {
    const controller = new AbortController();
    const uploadFile = vi.fn(async () => { controller.abort(); });
    const sandbox = {
      id: "sandbox-1", name: "sandbox", state: "started",
      fs: { uploadFile, downloadFile: vi.fn() },
    };
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get: vi.fn(async () => sandbox) }));

    await expect(provider.writeFile(
      "sandbox-1",
      "/workspace/.rally/tmp/write",
      new Uint8Array([1, 2, 3]),
      controller.signal,
    )).rejects.toThrow("Terminal file transfer cancelled");
    expect(uploadFile).toHaveBeenCalledOnce();
  });

  it("cancels a command without stopping the sandbox when session cleanup fails", async () => {
    const controller = new AbortController();
    const deleteSession = vi.fn(async () => { throw new Error("cleanup failed"); });
    const stop = vi.fn(async () => undefined);
    const sandbox = {
      id: "sandbox-1", name: "sandbox", state: "started", stop,
      process: {
        createSession: vi.fn(async () => undefined),
        getSession: vi.fn(async () => { throw Object.assign(new Error("not found"), { statusCode: 404 }); }),
        getSessionCommand: vi.fn(async () => ({ id: "cmd-cancel", command: "envelope" })),
        getSessionCommandLogs: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(async () => new Promise<{ exitCode: number; stdout: string; stderr: string }>(() => undefined)),
        deleteSession,
      },
    };
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get: vi.fn(async () => sandbox) }));

    const pending = provider.runCommand("sandbox-1", {
      taskName: "cancelled-task", command: "sleep 100", cwd: "/workspace", timeoutMs: 120_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/iu);
    expect(deleteSession).toHaveBeenCalledWith("cancelled-task");
    expect(stop).not.toHaveBeenCalled();
  });

  it("does not submit after cancellation wins while session creation is in flight", async () => {
    const controller = new AbortController();
    let finishCreate!: () => void;
    const createSession = vi.fn(async () => (
      new Promise<void>((resolve) => { finishCreate = resolve; })
    ));
    const executeSessionCommand = vi.fn();
    const sandbox = {
      id: "sandbox-1", name: "sandbox", state: "started",
      process: {
        createSession,
        getSession: vi.fn(async () => { throw Object.assign(new Error("not found"), { statusCode: 404 }); }),
        getSessionCommand: vi.fn(),
        getSessionCommandLogs: vi.fn(),
        executeSessionCommand,
        deleteSession: vi.fn(async () => undefined),
      },
    };
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get: vi.fn(async () => sandbox) }));

    const pending = provider.runCommand("sandbox-1", {
      taskName: "pre-submit-cancel", command: "printf stale", cwd: "/workspace", timeoutMs: 120_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledOnce());
    controller.abort();
    finishCreate();
    await expect(pending).rejects.toThrow(/cancelled/iu);
    expect(executeSessionCommand).not.toHaveBeenCalled();
    expect(sandbox.process.deleteSession).toHaveBeenCalledTimes(2);
  });

  it("rechecks durable authority after session creation and before command submission", async () => {
    const createSession = vi.fn(async () => undefined);
    const executeSessionCommand = vi.fn();
    const assertSubmissionAuthority = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("submission authority retired"));
    const sandbox = {
      id: "sandbox-1", name: "sandbox", state: "started",
      process: {
        createSession,
        getSession: vi.fn(async () => { throw Object.assign(new Error("not found"), { statusCode: 404 }); }),
        getSessionCommand: vi.fn(),
        getSessionCommandLogs: vi.fn(),
        executeSessionCommand,
        deleteSession: vi.fn(async () => undefined),
      },
    };
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get: vi.fn(async () => sandbox) }));

    await expect(provider.runCommand("sandbox-1", {
      taskName: "authority-fenced-task",
      command: "printf stale",
      cwd: "/workspace",
      timeoutMs: 120_000,
      assertSubmissionAuthority,
    })).rejects.toThrow("submission authority retired");
    expect(assertSubmissionAuthority).toHaveBeenCalledTimes(2);
    expect(createSession).toHaveBeenCalledOnce();
    expect(executeSessionCommand).not.toHaveBeenCalled();
  });

  it("reattaches to the one command in a stable provider session after a lost Worker response", async () => {
    const expectedEnvelope = "(cd -- '/workspace' || exit $?; if [ -f /workspace/.rally/session.env ]; then . /workspace/.rally/session.env || exit $?; fi; timeout --signal=TERM --kill-after=5s 120s bash -lc 'printf recovered'; rally_status=$?; if [ \"$rally_status\" -eq 124 ]; then printf '\\nAVALON_COMMAND_TIMED_OUT\\n' >&2; fi; exit \"$rally_status\")";
    const sessionCommand = {
      id: "cmd-existing",
      command: expectedEnvelope,
    };
    const getSession = vi.fn(async () => ({ sessionId: "avalon-task-1", commands: [sessionCommand] }));
    const getSessionCommand = vi.fn(async () => ({ ...sessionCommand, exitCode: 0 }));
    const getSessionCommandLogs = vi.fn(async () => ({ stdout: "recovered\n", stderr: "" }));
    const executeSessionCommand = vi.fn();
    const deleteSession = vi.fn(async () => undefined);
    const sandbox = {
      id: "sandbox-1", name: "sandbox", state: "started",
      process: {
        createSession: vi.fn(),
        getSession,
        getSessionCommand,
        getSessionCommandLogs,
        executeSessionCommand,
        deleteSession,
      },
    };
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get: vi.fn(async () => sandbox) }));

    await expect(provider.runCommand("sandbox-1", {
      taskName: "avalon-task-1", command: "printf recovered", cwd: "/workspace", timeoutMs: 120_000,
      retainSessionForRecovery: true,
    })).resolves.toEqual({ exitCode: 0, stdout: "recovered\n", stderr: "" });

    expect(executeSessionCommand).not.toHaveBeenCalled();
    expect(getSessionCommand).toHaveBeenCalledWith("avalon-task-1", "cmd-existing");
    expect(getSessionCommandLogs).toHaveBeenCalledWith(
      "avalon-task-1",
      "cmd-existing",
      expect.any(Function),
      expect.any(Function),
    );
    expect(deleteSession).not.toHaveBeenCalled();
    await provider.cleanupCommand?.("sandbox-1", "avalon-task-1");
    expect(deleteSession).toHaveBeenCalledWith("avalon-task-1");
  });

  it("treats an already-deleted command session as quiescent", async () => {
    const missing = Object.assign(new Error("session missing"), { status: 404 });
    const stop = vi.fn(async () => undefined);
    const sandbox = {
      id: "sandbox-1", name: "sandbox", state: "started", stop,
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(),
        deleteSession: vi.fn(async () => { throw missing; }),
      },
    };
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get: vi.fn(async () => sandbox) }));

    await expect(provider.cleanupCommand?.("sandbox-1", "already-gone"))
      .resolves.toBe("missing");
    expect(stop).not.toHaveBeenCalled();
  });

  it("does not stop a healthy sandbox when ordinary session cleanup fails", async () => {
    const failure = new Error("delete unavailable");
    const stop = vi.fn(async () => undefined);
    const sandbox = {
      id: "sandbox-1", name: "sandbox", state: "started", stop,
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(),
        deleteSession: vi.fn(async () => { throw failure; }),
      },
    };
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get: vi.fn(async () => sandbox) }));

    await expect(provider.cleanupCommand?.("sandbox-1", "cleanup-failed"))
      .rejects.toThrow("delete unavailable");
    expect(stop).not.toHaveBeenCalled();
  });

  it("replaces a stable provider session whose stored command differs", async () => {
    const createSession = vi.fn(async () => undefined);
    const deleteSession = vi.fn(async () => undefined);
    const executeSessionCommand = vi.fn(async () => ({ cmdId: "cmd-fresh", exitCode: 0 }));
    const getSessionCommandLogs = vi.fn(async () => ({ stdout: "fresh\n", stderr: "" }));
    const sandbox = {
      id: "sandbox-1", name: "sandbox", state: "started",
      process: {
        createSession,
        getSession: vi.fn(async () => ({
          sessionId: "avalon-task-1",
          commands: [{ id: "cmd-stale", command: "stale envelope", exitCode: 0 }],
        })),
        getSessionCommand: vi.fn(),
        getSessionCommandLogs,
        executeSessionCommand,
        deleteSession,
      },
    };
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get: vi.fn(async () => sandbox) }));

    await expect(provider.runCommand("sandbox-1", {
      taskName: "avalon-task-1", command: "printf fresh", cwd: "/workspace", timeoutMs: 120_000,
      retainSessionForRecovery: true,
    })).resolves.toEqual({ exitCode: 0, stdout: "fresh\n", stderr: "" });

    expect(deleteSession).toHaveBeenCalledOnce();
    expect(deleteSession).toHaveBeenCalledWith("avalon-task-1");
    expect(createSession).toHaveBeenCalledWith("avalon-task-1");
    expect(executeSessionCommand).toHaveBeenCalledWith(
      "avalon-task-1",
      expect.objectContaining({ command: expect.stringContaining("bash -lc 'printf fresh'") }),
      130,
    );
  });

  it("names the capabilities a failed verification could not satisfy", async () => {
    // The probe reports every one it could not verify so a breaking managed
    // image, or a rebuilt snapshot that lost something, is one diagnostic.
    // Discarding stdout left "verification failed" with nothing to act on.
    const executeCommand = vi.fn()
      .mockResolvedValueOnce({ exitCode: 0, result: "AVALON_BOOTSTRAP_INSTALLED=\n" })
      .mockResolvedValueOnce({ exitCode: 1, result: "AVALON_PROBE_MISSING=git-ca gh\n" });
    const observed = {
      id: "sandbox-1",
      name: "avalon-ws-stream",
      state: "started",
      domainAllowList: "github.com",
      refreshData: vi.fn(async () => undefined),
      process: {
        executeCommand,
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(async () => ({})),
        deleteSession: vi.fn(async () => undefined),
      },
    };
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "rally-terminal-1", emergencyDisabled: false,
    }, () => ({ create: vi.fn(), get: vi.fn(async () => observed) }));

    await expect(provider.prepareSandbox!("sandbox-1", ["github.com"]))
      .rejects.toThrow("Daytona could not initialize the private Rally workspace: missing git-ca, gh");
  });

  it("deletes the sandbox even when its read secrets cannot be listed", async () => {
    // A credential without the Secrets scope answered 403 on the listing that
    // runs before the delete, so the sandbox was never deleted — a live
    // filesystem left accruing cost because tidying its secrets failed.
    const del = vi.fn(async () => undefined);
    const sandbox = { id: "sandbox-1", name: "avalon-ws-stream", state: "started", delete: del };
    const list = vi.fn(async (): Promise<{
      items: Array<{ id: string; name: string }>; total: number; nextCursor: string | null;
    }> => { throw new Error("Access denied"); });
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "rally-terminal-1", emergencyDisabled: false,
    }, () => ({
      create: vi.fn(),
      get: vi.fn(async () => sandbox),
      secret: {
        list,
        create: vi.fn(async () => ({ id: "secret-1", name: "AVALON_READ_x" })),
        update: vi.fn(async () => ({ id: "secret-1", name: "AVALON_READ_x" })),
        delete: vi.fn(async () => undefined),
      },
    }));

    await expect(provider.deleteSandbox("sandbox-1")).resolves.toBeUndefined();
    expect(list).toHaveBeenCalledOnce();
    expect(del).toHaveBeenCalledOnce();
  });

  it("still fails revocation when the read secrets cannot be listed", async () => {
    // The listing tolerance exists for teardown, where an undeleted sandbox
    // costs more than a leftover secret. Revocation is the opposite trade: a
    // caller clearing read access must know the secrets are gone, so the same
    // failure propagates here rather than reporting a revocation that did not
    // happen.
    const updateSecrets = vi.fn(async () => undefined);
    const sandbox = { id: "sandbox-1", name: "avalon-ws-stream", state: "started", updateSecrets };
    const list = vi.fn(async (): Promise<{
      items: Array<{ id: string; name: string }>; total: number; nextCursor: string | null;
    }> => { throw new Error("Access denied"); });
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "rally-terminal-1", emergencyDisabled: false,
    }, () => ({
      create: vi.fn(),
      get: vi.fn(async () => sandbox),
      secret: {
        list,
        create: vi.fn(async () => ({ id: "secret-1", name: "AVALON_READ_x" })),
        update: vi.fn(async () => ({ id: "secret-1", name: "AVALON_READ_x" })),
        delete: vi.fn(async () => undefined),
      },
    }));

    await expect(provider.clearGitHubReadAccess("sandbox-1")).rejects.toThrow("Access denied");
    expect(updateSecrets).toHaveBeenCalledWith({});
    expect(list).toHaveBeenCalledOnce();
  });

});
