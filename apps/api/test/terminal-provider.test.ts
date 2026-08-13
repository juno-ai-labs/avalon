import { describe, expect, it, vi } from "vitest";

import { createDaytonaTerminalProvider } from "../src/services/terminal/daytona-provider";

describe("Daytona Terminal provider", () => {
  it("creates a private managed sandbox with native policy and lifecycle backstops", async () => {
    const executeCommand = vi.fn(async () => ({ exitCode: 0 }));
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
      snapshot: "avalon-terminal-2026-08-13",
      emergencyDisabled: false,
    }, clientFactory);

    const createdSnapshot = await provider.createSandbox({
      stableName: "avalon-ws-stream",
      workspaceId: "workspace-1",
      workstreamId: "stream-1",
      generation: 1,
      domainAllowList: ["github.com", "*.npmjs.org"],
      environment: { AVALON_RESOURCE_DIR: "/workspace/.avalon-output" },
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
      snapshot: "avalon-terminal-2026-08-13",
      public: false,
      autoStopInterval: 15,
      autoArchiveInterval: 60,
      autoDeleteInterval: -1,
      ttlMinutes: 0,
      domainAllowList: "github.com,*.npmjs.org",
      envVars: { AVALON_RESOURCE_DIR: "/workspace/.avalon-output" },
      labels: {
        "avalon.workspace": "workspace-1",
        "avalon.workstream": "stream-1",
        "avalon.generation": "1",
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
    expect(executeCommand).toHaveBeenCalledWith(
      expect.stringMatching(/bash -lc .*sudo -n install.*sqlite3.*pnpm@11\.13\.0.*tsx@4\.20\.6.*gh --version/su),
      undefined,
      undefined,
      120,
    );
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
      stableName: "avalon-ws-stream", workspaceId: "workspace-1", workstreamId: "stream-1",
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
      stableName: "avalon-ws-stream", workspaceId: "workspace-1", workstreamId: "stream-1",
      generation: 1, domainAllowList: ["github.com"], environment: {},
    });
    await expect(provider.prepareSandbox!(createdSnapshot.id, ["github.com"]))
      .rejects.toMatchObject({ name: "TerminalSandboxInitializationError" });
    expect(remove).toHaveBeenCalledWith(60, true);
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
    expect(sandbox.start).toHaveBeenCalledWith(60);
    expect(sandbox.stop).toHaveBeenCalledOnce();
    expect(sandbox.archive).toHaveBeenCalledOnce();
    expect(sandbox.updateNetworkSettings).toHaveBeenCalledWith({ domainAllowList: "pypi.org,*.pythonhosted.org" });
    expect(sandbox.delete).toHaveBeenCalledWith(60, true);
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

  it("moves file bytes without host paths and runs one non-interactive session command", async () => {
    const uploadFileStream = vi.fn(async () => undefined);
    const downloadFile = vi.fn(async () => new Uint8Array([104, 105]));
    const createSession = vi.fn(async () => undefined);
    const executeSessionCommand = vi.fn(async () => ({ cmdId: "cmd-1" }));
    const getSession = vi.fn()
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValue({ sessionId: "avalon-task-1", commands: [] });
    const getSessionCommand = vi.fn(async () => ({ id: "cmd-1", command: "envelope", exitCode: 0 }));
    const getSessionCommandLogs = vi.fn(async (_sessionId, _commandId, onStdout?: (chunk: string) => void) => {
      onStdout?.("ok\n");
    });
    const deleteSession = vi.fn(async () => undefined);
    const sandbox = {
      id: "sandbox-1", name: "sandbox", state: "started",
      fs: { uploadFileStream, downloadFile },
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

    expect(uploadFileStream).toHaveBeenCalledWith(expect.any(Uint8Array), "workspace/hello.txt", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(downloadFile).toHaveBeenCalledWith("workspace/hello.txt", 120);
    expect(executeSessionCommand).toHaveBeenCalledWith("avalon-task-1", {
      command: expect.stringMatching(/timeout --signal=TERM --kill-after=5s 120s bash -lc 'printf ok'/u),
      runAsync: true,
      suppressInputEcho: true,
    }, 130);
    expect(executeSessionCommand).toHaveBeenCalledWith("avalon-task-1", {
      command: expect.stringContaining("avalon_status=$?"),
      runAsync: true,
      suppressInputEcho: true,
    }, 130);
    expect(deleteSession).toHaveBeenCalledWith("avalon-task-1");
  });

  it("cancels a command by deleting its provider session and stops the sandbox if cleanup fails", async () => {
    const controller = new AbortController();
    const deleteSession = vi.fn(async () => { throw new Error("cleanup failed"); });
    const stop = vi.fn(async () => undefined);
    const sandbox = {
      id: "sandbox-1", name: "sandbox", state: "started", stop,
      process: {
        createSession: vi.fn(async () => undefined),
        getSession: vi.fn(async () => { throw new Error("not found"); }),
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
    expect(stop).toHaveBeenCalledOnce();
  });

  it("reattaches to the one command in a stable provider session after a lost Worker response", async () => {
    const sessionCommand = {
      id: "cmd-existing",
      command: "cd -- '/workspace' && existing-envelope",
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

  it("publishes a verified bundle from a fresh ephemeral sandbox with a host-scoped secret", async () => {
    const uploadFileStream = vi.fn(async () => undefined);
    const createSession = vi.fn(async () => undefined);
    const executeSessionCommand = vi.fn(async () => ({
      cmdId: "publisher-cmd",
      exitCode: 0,
      stdout: "published\n",
    }));
    const getSession = vi.fn(async () => { throw new Error("not found"); });
    const getSessionCommand = vi.fn(async () => ({ id: "publisher-cmd", command: "envelope", exitCode: 0 }));
    const getSessionCommandLogs = vi.fn(async (_sessionId, _commandId, onStdout?: (chunk: string) => void) => { onStdout?.("published\n"); });
    const deleteSession = vi.fn(async () => undefined);
    const removePublisher = vi.fn(async () => undefined);
    const publisherSandbox = {
      id: "publisher-1", name: "avalon-publisher", state: "started",
      fs: { uploadFileStream, downloadFile: vi.fn() },
      process: { createSession, getSession, getSessionCommand, getSessionCommandLogs, executeSessionCommand, deleteSession },
      delete: removePublisher,
    };
    const createSecret = vi.fn(async (input: { name: string; hosts?: string[] }) => ({
      id: "secret-1", name: input.name, placeholder: "dtn_secret_1",
      hosts: input.hosts ?? [], createdAt: "", updatedAt: "",
    }));
    const deleteSecret = vi.fn(async () => undefined);
    const create = vi.fn(async () => publisherSandbox);
    const client = {
      create,
      get: vi.fn(async () => publisherSandbox),
      secret: {
        list: vi.fn(async () => ({ items: [], total: 0, nextCursor: null })),
        create: createSecret,
        update: vi.fn(),
        delete: deleteSecret,
      },
    };
    const provider = createDaytonaTerminalProvider({
      capability: "supported", apiKey: "secret", apiUrl: "https://app.daytona.io/api",
      target: "us", snapshot: "snapshot", emergencyDisabled: false,
    }, () => client);

    await expect(provider.publishGitBundle({
      operationId: "publication-1",
      bundle: new Uint8Array([1, 2, 3]),
      repositoryFullName: "owner/repo",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      headRef: "avalon/workstream-1",
      expectedOldSha: null,
      githubBasicCredential: "encoded-credential",
    })).resolves.toEqual({ publishedSha: "b".repeat(40) });
    expect(createSecret).toHaveBeenCalledWith(expect.objectContaining({
      value: "encoded-credential",
      hosts: ["github.com"],
    }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: "snapshot",
      ephemeral: true,
      public: false,
      domainAllowList: "github.com",
      secrets: { GITHUB_WRITE_BASIC: expect.any(String) },
    }), { timeout: 60 });
    expect(uploadFileStream).toHaveBeenCalledWith(expect.any(Uint8Array), "/workspace/publication.bundle", expect.anything());
    expect(executeSessionCommand).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      command: expect.stringContaining("git fsck --strict"),
    }), 180);
    expect(removePublisher).toHaveBeenCalledWith(60, true);
    expect(deleteSecret).toHaveBeenCalledWith("secret-1");
  });
});
