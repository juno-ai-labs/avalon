import { asUserId } from "@avalon/contracts";
import type { HarnessToolContext } from "@avalon/agent-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalSandboxCoordinator } from "../src/services/terminal/coordinator";
import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import { sha256Hex } from "../src/lib/crypto";
import {
  createDaytonaTerminalRuntime,
  type TerminalRepositoryPublisher,
  type TerminalResourceBridge,
} from "../src/services/terminal/runtime";
import {
  TerminalToolError,
  type TerminalImportResourceOutput,
  type TerminalPublishedBranchAndPrOutput,
  type TerminalPublishedResourceOutput,
} from "../src/services/terminal/tools";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import {
  seedWorkstreamObjectRoot,
  testWorkstreamObjectStore,
  testWorkstreamRuntimeD1,
  workstreamObjectGet,
  workstreamObjectRun,
} from "./helpers/durable-authority";

const W = "00000000-0000-4000-8000-000000000011";
const S = "00000000-0000-4000-8000-000000000012";
const R = "00000000-0000-4000-8000-000000000013";
const U = asUserId("00000000-0000-4000-8000-000000000014");
const I = "00000000-0000-4000-8000-000000000015";

const openDatabases: ReturnType<typeof preRetirementProductSqliteDatabase>[] = [];
afterEach(() => { for (const database of openDatabases.splice(0)) database.close(); });

function fixture() {
  const database = preRetirementProductSqliteDatabase();
  openDatabases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${U}', 'terminal-runtime', 'runtime@example.com', 'Runtime', '2026-08-13', '2026-08-13');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${W}', 'Runtime', 'runtime-terminal', 'global', '${U}', '2026-08-13', '2026-08-13');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${S}', '${W}', 'Runtime', 'Runtime', 'ad_hoc', '${U}', 'idle',
            '2026-08-13', '2026-08-13', '2026-08-13');
    INSERT INTO resources
      (id, workspace_id, resource_type, provider, title, metadata_json, created_at, updated_at)
    VALUES ('00000000-0000-4000-8000-000000000099', '${W}', 'uploaded_file',
            'avalon_upload', 'resource', '{}', '2026-08-13', '2026-08-13');
  `);
  // The run, its tool invocation, and every sandbox row live in the work
  // stream's own object since migration 0090 dropped the D1 copies.
  const objectStore = testWorkstreamObjectStore();
  openDatabases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, { workstreamId: S, workspaceId: W });
  workstreamObjectRun(
    objectStore,
    `INSERT INTO harness_runs
       (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
     VALUES (?, ?, ?, 'test', ?, 'running', '2026-08-13')`,
    R, W, S, JSON.stringify({ type: "user", userId: U }),
  );
  workstreamObjectRun(
    objectStore,
    `INSERT INTO tool_invocations
       (id, workspace_id, workstream_id, harness_run_id, tool_call_id, tool_name,
        input_hash, input_json, status)
     VALUES (?, ?, ?, ?, 'call-runtime', 'terminal_run_command', 'hash', '{}', 'started')`,
    I, W, S, R,
  );
  const files = new Map<string, Uint8Array>();
  files.set("/workspace/src/file.txt", new TextEncoder().encode("hello\n"));
  const provider: TerminalSandboxProvider = {
    createSandbox: vi.fn(async (input) => ({ id: "sandbox-runtime", name: input.stableName, state: "running" as const, domainAllowList: input.domainAllowList })),
    getSandbox: vi.fn(async (name) => ({ id: "sandbox-runtime", name, state: "running" as const, domainAllowList: [] })),
    startSandbox: vi.fn(async () => undefined), stopSandbox: vi.fn(async () => undefined),
    archiveSandbox: vi.fn(async () => undefined), deleteSandbox: vi.fn(async () => undefined),
    updateNetworkPolicy: vi.fn(async () => undefined),
    configureGitHubReadAccess: vi.fn(async () => undefined), clearGitHubReadAccess: vi.fn(async () => undefined),
    readFile: vi.fn(async (_id, path) => files.get(path) ?? new Uint8Array()),
    writeFile: vi.fn(async (_id, path, bytes) => { files.set(path, bytes); }),
    runCommand: vi.fn(async (_id, input) => {
      if (input.command.startsWith("realpath -m")) return { exitCode: 0, stdout: input.command.includes("escape") ? "/tmp/escape\n" : "/workspace/src/file.txt\n", stderr: "" };
      if (input.taskName.startsWith("avalon-read-stat")) {
        const target = /^target='([^']+)'/u.exec(input.command)?.[1] ?? "";
        const bytes = files.get(target);
        return bytes
          ? { exitCode: 0, stdout: `${bytes.byteLength}\n`, stderr: "" }
          : { exitCode: 44, stdout: "", stderr: "" };
      }
      if (input.command.startsWith("target=") && input.command.includes("sha256sum")) {
        const target = /^target='([^']+)'/u.exec(input.command)?.[1] ?? "";
        const bytes = files.get(target);
        if (!bytes) return { exitCode: 44, stdout: "", stderr: "" };
        return { exitCode: 0, stdout: `${bytes.byteLength} ${await sha256Hex(bytes)}\n`, stderr: "" };
      }
      if (input.command === "long-output") return { exitCode: 0, stdout: "x".repeat(150_000), stderr: "" };
      return { exitCode: input.command === "false" ? 1 : 0, stdout: "ok\n", stderr: input.command === "false" ? "bad\n" : "" };
    }),
    publishGitBundle: vi.fn(async (input) => ({ publishedSha: input.headSha })),
  };
  const resources: TerminalResourceBridge = {
    importResource: vi.fn(async (_context, input, destination): Promise<TerminalImportResourceOutput> => ({
      resourceId: input.resourceId, filePath: destination, outcome: "created",
      mimeType: "text/plain", sizeBytes: 4, sourceSha256: "a".repeat(64),
    })),
    publishResource: vi.fn(async (_context, input, bytes): Promise<TerminalPublishedResourceOutput> => ({
      resourceId: "published", title: input.displayName ?? input.filePath,
      resourceType: "generated_file", provider: "avalon_generated", mimeType: "text/plain",
      sizeBytes: bytes.byteLength, sourceSha256: "b".repeat(64), attachmentKind: "text",
      contentMode: "read", derivativeStatus: "pending", createdAt: "2026-08-13T12:00:00.000Z",
    })),
  };
  const publisher: TerminalRepositoryPublisher = {
    publishBranchAndPr: vi.fn(async (): Promise<TerminalPublishedBranchAndPrOutput> => ({
      repository: "o/r", baseRef: "main", headRef: "avalon/workstream", commitSha: "c".repeat(40),
      publishedSha: "c".repeat(40), outcome: "created",
      pullRequest: { number: 1, url: "https://github.com/o/r/pull/1", title: "Ship", state: "open" },
    })),
  };
  const db = testWorkstreamRuntimeD1(sqliteD1(database), objectStore, { workspaceId: W, workstreamId: S });
  const coordinator = new TerminalSandboxCoordinator(db, provider, { now: () => new Date("2026-08-13T12:00:00.000Z") });
  return { database, objectStore, files, provider, resources, publisher, runtime: createDaytonaTerminalRuntime(db, coordinator, provider, resources, publisher) };
}

const context: HarnessToolContext = {
  workspaceId: W,
  workstreamId: S,
  harnessRunId: R,
  toolCallId: "call-runtime",
  executionPrincipal: { type: "user", userId: U },
  signal: new AbortController().signal,
};

describe("Daytona Terminal runtime", () => {
  it("does not allocate until an operation and resolves paths inside the root", async () => {
    const { objectStore, provider, runtime } = fixture();
    expect(workstreamObjectGet(objectStore, "SELECT COUNT(*) AS count FROM workstream_sandboxes")).toEqual({ count: 0 });

    await runtime.readFile(context, "src/file.txt");
    expect(provider.createSandbox).toHaveBeenCalledOnce();
    expect(provider.readFile).toHaveBeenCalledWith("sandbox-runtime", "/workspace/src/file.txt");
  });

  it("rejects a provider-resolved symlink escape before reading bytes", async () => {
    const { provider, runtime } = fixture();
    await expect(runtime.readFile(context, "escape/file.txt")).rejects.toBeInstanceOf(TerminalToolError);
    expect(provider.readFile).not.toHaveBeenCalled();
  });

  it("quotes parent-directory creation for deliberate writes whose paths contain spaces", async () => {
    const { provider, runtime } = fixture();
    await runtime.writeFile(context, "reports/august result.txt", new TextEncoder().encode("result"));
    expect(provider.runCommand).toHaveBeenLastCalledWith("sandbox-runtime", expect.objectContaining({
      command: expect.stringContaining('dirname -- "$target"'),
    }));
  });

  it("preserves paths with spaces in unified patch headers", async () => {
    const { provider, runtime } = fixture();
    await expect(runtime.applyPatch(context, [
      "--- a/docs/old name.txt",
      "+++ b/docs/new name.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"))).resolves.toMatchObject({
      files: [{ path: "docs/new name.txt", previousPath: "docs/old name.txt", operation: "renamed" }],
    });
    expect(provider.runCommand).toHaveBeenCalledWith("sandbox-runtime", expect.objectContaining({
      command: expect.stringContaining("git apply --check"),
    }));
  });

  it("records one durable command task and terminalizes nonzero exit normally", async () => {
    const { objectStore, provider, runtime } = fixture();
    await expect(runtime.runCommand(context, { command: "false", timeoutMs: 3_000 })).resolves.toMatchObject({
      state: "failed",
      terminationReason: "exited",
      exitCode: 1,
      stdout: "ok\n",
      stderr: "bad\n",
    });
    expect(provider.runCommand).toHaveBeenCalledWith("sandbox-runtime", expect.objectContaining({
      taskName: `avalon-task-${I}`,
      command: "false",
      cwd: "/workspace",
      timeoutMs: 3_000,
    }));
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state, exit_code, termination_reason FROM sandbox_tasks WHERE workspace_id = ? AND tool_invocation_id = ?",
      W, I,
    )).toEqual({ state: "failed", exit_code: 1, termination_reason: "exited" });
  });

  it("keeps an unknown provider outcome recoverable and reattaches on the exact retry", async () => {
    const { objectStore, provider, runtime } = fixture();
    vi.mocked(provider.runCommand)
      .mockRejectedValueOnce(new Error("observation connection reset"))
      .mockResolvedValueOnce({ exitCode: 0, stdout: "recovered\n", stderr: "" });

    await expect(runtime.runCommand(context, { command: "printf recovered", timeoutMs: 3_000 }))
      .rejects.toMatchObject({
        code: "command_outcome_unknown",
        details: { reason: "Resume this run so Avalon can reattach to the same durable command task." },
      });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state, completed_at FROM sandbox_tasks WHERE workspace_id = ? AND tool_invocation_id = ?",
      W, I,
    )).toEqual({ state: "running", completed_at: null });

    await expect(runtime.runCommand(context, { command: "printf recovered", timeoutMs: 3_000 }))
      .resolves.toMatchObject({ state: "completed", stdout: "recovered\n" });
  });

  it("redacts provider secrets before command output reaches durable storage", async () => {
    const { objectStore, provider, runtime } = fixture();
    vi.mocked(provider.runCommand).mockResolvedValueOnce({
      exitCode: 0,
      stdout: "github_pat_1234567890abcdefghijkl dtn_secret_1234567890\n",
      stderr: "",
    });
    await expect(runtime.runCommand(context, { command: "env", timeoutMs: 3_000 }))
      .resolves.toMatchObject({ stdout: "[REDACTED] [REDACTED]\n" });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT stdout_head FROM sandbox_tasks WHERE workspace_id = ? AND tool_invocation_id = ?",
      W, I,
    )).toEqual({ stdout_head: "[REDACTED] [REDACTED]\n" });
  });

  it("resumes a nonterminal durable command task without replacing its original timing", async () => {
    const { objectStore, provider, runtime } = fixture();
    await runtime.readFile(context, "src/file.txt");
    vi.mocked(provider.runCommand).mockClear();
    vi.mocked(provider.runCommand).mockResolvedValueOnce({ exitCode: 0, stdout: "recovered\n", stderr: "" });
    const commandHash = await sha256Hex(JSON.stringify({
      command: "printf recovered",
      cwd: "/workspace",
      timeoutMs: 120_000,
    }));
    workstreamObjectRun(
      objectStore,
      `INSERT INTO sandbox_tasks
       (id, workspace_id, workstream_id, harness_run_id, tool_invocation_id,
        sandbox_generation, provider_task_name, state, command_sha256,
        command_deadline_at, started_at, created_at, updated_at)
       VALUES ('task-existing', ?, ?, ?, ?, 1, ?, 'running', ?,
               '2026-08-13T12:02:00.000Z', '2026-08-13T12:00:00.000Z',
               '2026-08-13T12:00:00.000Z', '2026-08-13T12:00:00.000Z')`,
      W, S, R, I, `avalon-task-${I}`, commandHash,
    );

    await expect(runtime.runCommand(context, { command: "printf recovered", timeoutMs: 120_000 })).resolves.toMatchObject({
      state: "completed",
      stdout: "recovered\n",
      startedAt: "2026-08-13T12:00:00.000Z",
    });
    expect(provider.runCommand).toHaveBeenCalledOnce();
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state, started_at FROM sandbox_tasks WHERE workspace_id = ? AND tool_invocation_id = ?",
      W, I,
    )).toEqual({ state: "completed", started_at: "2026-08-13T12:00:00.000Z" });
  });

  it("uses create-only automatic import destinations and delegates publication bytes", async () => {
    const { files, provider, resources, runtime } = fixture();
    await expect(runtime.importResource(context, { resourceId: "00000000-0000-4000-8000-000000000099" })).resolves.toMatchObject({
      resourceId: "00000000-0000-4000-8000-000000000099",
      filePath: ".avalon/resources/00000000-0000-4000-8000-000000000099/resource",
    });
    files.set("/workspace/.avalon-output/report.txt", new TextEncoder().encode("report"));
    await expect(runtime.publishResource(context, { filePath: "report.txt" })).resolves.toMatchObject({ resourceId: "published", sizeBytes: 6 });
    expect(provider.readFile).toHaveBeenCalledWith("sandbox-runtime", "/workspace/.avalon-output/report.txt");
    expect(resources.importResource).toHaveBeenCalledWith(context, expect.anything(), ".avalon/resources/00000000-0000-4000-8000-000000000099/resource", 1, "sandbox-runtime", expect.anything());
  });

  it("publishes complete command output before returning bounded inline head and tail", async () => {
    const { database, objectStore, resources, runtime } = fixture();
    database.prepare(
      `INSERT INTO resources
       (id, workspace_id, resource_type, provider, title, metadata_json, created_at, updated_at)
       VALUES ('command-log', ?, 'generated_file', 'avalon_terminal', 'Command log', '{}', '2026-08-13', '2026-08-13')`,
    ).run(W);
    vi.mocked(resources.publishResource).mockResolvedValueOnce({
      resourceId: "command-log", title: "Command log", resourceType: "generated_file",
      provider: "avalon_generated", mimeType: "text/plain", sizeBytes: 150_000,
      sourceSha256: "d".repeat(64), attachmentKind: "text", contentMode: "read",
      derivativeStatus: "pending", createdAt: "2026-08-13T12:00:00.000Z",
    });

    await expect(runtime.runCommand(context, { command: "long-output", timeoutMs: 3_000 })).resolves.toMatchObject({
      state: "completed",
      outputResourceId: "command-log",
      stdout: expect.stringContaining("provider output omitted"),
    });
    expect(resources.publishResource).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ filePath: `.avalon/logs/${I}.log` }),
      expect.any(Uint8Array),
    );
    expect(workstreamObjectGet(
      objectStore,
      "SELECT output_resource_id FROM sandbox_tasks WHERE workspace_id = ? AND tool_invocation_id = ?",
      W, I,
    )).toEqual({ output_resource_id: "command-log" });
  });

  it("rejects missing and empty generated files with model-repairable publication errors", async () => {
    const { files, runtime } = fixture();
    await expect(runtime.publishResource(context, { filePath: "missing.txt" })).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("AVALON_RESOURCE_DIR"),
    });
    files.set("/workspace/.avalon-output/empty.txt", new Uint8Array());
    await expect(runtime.publishResource(context, { filePath: "empty.txt" })).rejects.toMatchObject({
      code: "resource_empty",
      message: expect.stringContaining("empty"),
    });
  });
});
