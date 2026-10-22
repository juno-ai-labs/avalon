import { SITE_MANIFEST_MIME_TYPE, asUserId } from "@rally/contracts";
import type { HarnessToolContext } from "@rally/agent-harness";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalSandboxCoordinator } from "../src/services/terminal/coordinator";
import type {
  TerminalCheckoutRepositoryOutput,
  TerminalRepositorySelector,
} from "../src/services/terminal/repository-selection";
import {
  DAYTONA_REQUEST_TIMEOUT_MS,
  type TerminalSandboxProvider,
  type TerminalSandboxState,
} from "../src/services/terminal/daytona-provider";
import { sha256Hex } from "../src/lib/crypto";
import { TERMINAL_PYDANTIC_REQUIREMENT, TERMINAL_SNAPSHOT_PYLIB } from "../src/services/terminal/snapshot-manifest";
import {
  createDaytonaTerminalRuntime,
  TERMINAL_READ_TEXT_PAGE_PYTHON,
  type TerminalRepositoryPublisher,
  type TerminalResourceBridge,
} from "../src/services/terminal/runtime";
import { createTerminalInstructionFiles, type TerminalInstructionFiles } from "../src/services/terminal/instructions";
import { APPLY_PATCH_SCRIPT } from "../src/services/terminal/patch-format";
import { WorkstreamResidentContextStorage } from "../src/durable-objects/workstream-resident-context-storage";
import { createResidentContextPortFactory } from "../src/runtime/resident-context-port";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import {
  TerminalToolError,
  type TerminalImportResourceOutput,
  type TerminalPublishedBranchAndPrOutput,
  type TerminalPublishedResourceOutput,
  type TerminalPublishedSiteOutput,
} from "../src/services/terminal/tools";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import type { DatabaseSync } from "node:sqlite";
import { createTestEnv } from "./helpers/cloudflare-test";
import {
  createTestWorkspaceDO,
  testWorkspaceObjectBinding,
} from "./helpers/workspace-object-rpcs";
import {
  seedWorkstreamObjectRoot,
  seedWorkstreamRun,
  testWorkstreamObjectStore,
  workstreamObjectGet,
  workstreamObjectRun,
  testResourcePortFactory,
  testTerminalPortFactory,
  seedToolReceipt,
  testHarnessRunPort,
} from "./helpers/durable-authority";

const W = "00000000-0000-4000-8000-000000000011";
const S = "00000000-0000-4000-8000-000000000012";
const R = "00000000-0000-4000-8000-000000000013";
const R2 = "00000000-0000-4000-8000-000000000016";
const R3 = "00000000-0000-4000-8000-000000000017";
const U = asUserId("00000000-0000-4000-8000-000000000014");
const I = "00000000-0000-4000-8000-000000000015";

const openDatabases: ReturnType<typeof preRetirementProductSqliteDatabase>[] = [];
const objectDatabases: DatabaseSync[] = [];
const probeRoots: string[] = [];
afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  for (const database of objectDatabases.splice(0)) database.close();
  for (const root of probeRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * The instruction probe a runtime command carries, and the command without it.
 * The simulated shell below runs the probe for real against a temp directory
 * standing in for `/workspace`, so what these tests exercise is the runtime's
 * glue over the actual script and the actual ledger.
 */
function splitProbe(command: string): { rest: string; fragment: string | null } {
  const start = command.indexOf("( set +e; python3 -c '");
  if (start === -1) return { rest: command, fragment: null };
  const ending = ") || true";
  const stop = command.indexOf(ending, start) + ending.length;
  return { rest: command.slice(0, start) + command.slice(stop), fragment: command.slice(start, stop) };
}

function fixture(
  clock: { now(): Date } = { now: () => new Date("2026-08-13T12:00:00.000Z") },
  acquisitionObserved?: ConstructorParameters<typeof TerminalSandboxCoordinator>[7],
  prepareSandbox?: NonNullable<Parameters<typeof createDaytonaTerminalRuntime>[6]>,
  options: {
    withInstructions?: boolean;
    /** Which conversation the run executes in and which owns the sandbox; the main one for both by default. */
    scope?: { parentKind: "workstream" | "automation"; backgroundAgent: boolean; runSubstreamId: string; authoritySubstreamId: string };
  } = {},
) {
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
  // The run, its tool receipt, and every sandbox row live in the work stream's
  // own object since migration 0090 dropped the D1 copies. Terminal no longer
  // reads the receipt — it is handed the id on the tool context — but
  // `terminal_tasks.effect_intent_id` still references it, so a command cannot
  // record a task the harness never planned.
  const objectStore = testWorkstreamObjectStore();
  openDatabases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, { workstreamId: S, workspaceId: W });
  seedWorkstreamRun(objectStore, { id: R,
    executionPrincipalJson: JSON.stringify({ type: "user", userId: U }),
    createdAt: Date.parse("2026-08-13") });
  seedToolReceipt(objectStore, {
    id: I, runId: R, toolCallId: 'call-runtime', toolName: 'run_command',
  });
  const files = new Map<string, Uint8Array>();
  files.set("/workspace/src/file.txt", new TextEncoder().encode("hello\n"));
  const probeRoot = mkdtempSync(join(tmpdir(), "rally-terminal-probe-"));
  probeRoots.push(probeRoot);
  const ledger = new WorkstreamResidentContextStorage(createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    transactionSync: (body: () => unknown) => body(),
    sql: createTestSqlStorage(objectStore),
  }));
  const probeFailures: string[] = [];
  const instructions: TerminalInstructionFiles | undefined = options.withInstructions
    ? createTerminalInstructionFiles(
        createResidentContextPortFactory(createTestEnv({}), ledger)(W, S, "0"),
        (_error, stage) => { probeFailures.push(stage); },
      )
    : undefined;
  // Acquisition reads the provider's state back rather than trusting the row,
  // so a double that always answered "running" would hide a stop this runtime
  // performs itself — command fencing stops the sandbox and the next
  // acquisition is what starts it again.
  const sandboxState = { current: "running" as TerminalSandboxState };
  const provider: TerminalSandboxProvider = {
    createSandbox: vi.fn(async (input) => {
      sandboxState.current = "running";
      return { id: "sandbox-runtime", name: input.stableName, state: "running" as const, domainAllowList: input.domainAllowList };
    }),
    getSandbox: vi.fn(async (name) => ({ id: "sandbox-runtime", name, state: sandboxState.current, domainAllowList: [] })),
    recoverSandbox: vi.fn(async () => undefined),
    startSandbox: vi.fn(async () => { sandboxState.current = "running"; }),
    stopSandbox: vi.fn(async () => { sandboxState.current = "stopped"; }),
    archiveSandbox: vi.fn(async () => { sandboxState.current = "archived"; }),
    deleteSandbox: vi.fn(async () => { sandboxState.current = "expired"; }),
    updateNetworkPolicy: vi.fn(async () => undefined),
    configureGitHubReadAccess: vi.fn(async () => undefined), clearGitHubReadAccess: vi.fn(async () => undefined),
    readFile: vi.fn(async (_id, path) => files.get(path) ?? new Uint8Array()),
    writeFile: vi.fn(async (_id, path, bytes) => { files.set(path, bytes); }),
    runUtilityCommand: vi.fn(),
    runCommand: vi.fn(async (_id, input) => {
      if (input.taskName === "terminal-read-page") {
        const argumentsMatch = / (\d+) (\d+) \d+ \d+(?:;|$)/u.exec(input.command);
        const path = input.command.includes("/workspace/src/file.txt") ? "/workspace/src/file.txt" : "";
        const offset = Number(argumentsMatch?.[1] ?? 1);
        const limit = Number(argumentsMatch?.[2] ?? 200);
        const bytes = files.get(path);
        if (!bytes) return { exitCode: 44, stdout: "", stderr: "" };
        const lines = new TextDecoder().decode(bytes).split("\n");
        if (lines.at(-1) === "") lines.pop();
        const selected = lines.slice(offset - 1, offset - 1 + limit);
        const endLine = selected.length ? offset + selected.length - 1 : Math.min(offset - 1, lines.length);
        const truncated = endLine < lines.length;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            content: selected.join("\n"), startLine: offset, endLine, totalLines: lines.length, truncated,
            ...(truncated ? { nextOffset: endLine + 1 } : {}),
          }),
          stderr: "",
        };
      }
      if (input.command.startsWith("realpath -m")) return { exitCode: 0, stdout: input.command.includes("escape") ? "/tmp/escape\n" : "/workspace/src/file.txt\n", stderr: "" };
      if (input.taskName.startsWith("avalon-read-stat")) {
        const target = /^target='([^']+)'/u.exec(input.command)?.[1] ?? "";
        if (target.includes("escape")) return { exitCode: 43, stdout: "", stderr: "" };
        const bytes = files.get(target);
        return bytes
          ? { exitCode: 0, stdout: `${bytes.byteLength}\n`, stderr: "" }
          : { exitCode: 44, stdout: "", stderr: "" };
      }
      if (input.taskName.startsWith("avalon-write")) {
        const target = /^target='([^']+)'/u.exec(input.command)?.[1] ?? "";
        const temporary = /^temporary='([^']+)'/mu.exec(input.command)?.[1] ?? "";
        const previous = files.get(target);
        const previousText = previous ? new TextDecoder().decode(previous) : "";
        const previousLines = previousText
          ? previousText.split("\n").length - Number(previousText.endsWith("\n"))
          : 0;
        files.set(target, files.get(temporary) ?? new Uint8Array());
        files.delete(temporary);
        return { exitCode: 0, stdout: `${previous ? 0 : 1} ${previousLines}\n`, stderr: "" };
      }
      if (input.command.startsWith("target=") && input.command.includes("sha256sum")) {
        const target = /^target='([^']+)'/u.exec(input.command)?.[1] ?? "";
        const bytes = files.get(target);
        if (!bytes) return { exitCode: 44, stdout: "", stderr: "" };
        return { exitCode: 0, stdout: `${bytes.byteLength} ${await sha256Hex(bytes)}\n`, stderr: "" };
      }
      await input.onSubmitted?.("provider-command-runtime");
      if (input.command === "long-output") return { exitCode: 0, stdout: "x".repeat(150_000), stderr: "" };
      return { exitCode: input.command === "false" ? 1 : 0, stdout: "ok\n", stderr: input.command === "false" ? "bad\n" : "" };
    }),
    cleanupCommand: vi.fn(async () => undefined),
  };
  const runCommandImplementation = vi.mocked(provider.runCommand).getMockImplementation()!;
  provider.runUtilityCommand = vi.fn(async (id, input) => {
    // A command carrying the instruction probe runs the probe for real, against
    // the temp root, and the rest of the command against the simulated shell.
    const { rest, fragment } = splitProbe(input.command);
    if (fragment) {
      const executed = spawnSync("bash", ["-c", fragment.split("'/workspace'").join(`'${probeRoot}'`)], { encoding: "utf8" });
      const result = await provider.runUtilityCommand(id, { ...input, command: rest });
      return { ...result, stdout: `${result.stdout}${executed.stdout}` };
    }
    // The publish path now asks what a path *is* before reading it, and the
    // answer decides whether it publishes as a document, a site, or an
    // archive. The simulated shell answers from the same `files` map every
    // other command reads, so a directory here is any prefix that files live
    // beneath — which is what it is in the sandbox too.
    if (input.operation === "resource.publish.inspect_target") {
      const target = /^target='([^']+)'/u.exec(input.command)?.[1] ?? "";
      const exact = files.get(target);
      if (exact) return { exitCode: 0, stdout: `file ${exact.byteLength} ${await sha256Hex(exact)}\n`, stderr: "" };
      const beneath = [...files.entries()]
        .filter(([path]) => path.startsWith(`${target}/`))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
      if (beneath.length === 0) return { exitCode: 44, stdout: "", stderr: "" };
      const listed = await Promise.all(beneath.map(async ([path, bytes]) =>
        `${bytes.byteLength} ${await sha256Hex(bytes)} ${path.slice(target.length + 1)}`));
      return { exitCode: 0, stdout: `directory\n${listed.join("\n")}\n`, stderr: "" };
    }
    return runCommandImplementation(id, {
    ...input,
    taskName: input.operation === "file.read_page"
      ? "terminal-read-page"
      : input.operation === "file.inspect"
        ? "avalon-read-stat"
        : input.operation === "file.replace"
          ? "avalon-write"
          : "terminal-utility",
    });
  });
  const resources: TerminalResourceBridge = {
    // This suite drives the runtime's ordinary tool surface; crash-repair
    // reconciliation is proved against real rows in `terminal-publication.test.ts`.
    reconcilePublishedResource: vi.fn(async () => ({ outcome: "not_landed" as const })),
    importResource: vi.fn(async (_context, input, destination): Promise<TerminalImportResourceOutput> => ({
      resourceId: input.resourceId, filePath: destination, outcome: "created",
      mimeType: "text/plain", sizeBytes: 4, sourceSha256: "a".repeat(64),
    })),
    publishResource: vi.fn(async (_context, input, bytes): Promise<TerminalPublishedResourceOutput> => ({
      resourceId: "published", title: input.displayName ?? input.filePath,
      publishKind: "file", resourceType: "generated_file", provider: "avalon_generated", mimeType: "text/plain",
      sizeBytes: bytes.byteLength, sourceSha256: "b".repeat(64), attachmentKind: "text",
      contentMode: "read", derivativeStatus: "pending", createdAt: "2026-08-13T12:00:00.000Z",
    })),
    publishedKindForPath: vi.fn(async (): Promise<"site" | "archive" | "file" | null> => null),
    publishSiteResource: vi.fn(async (
      _context,
      input,
      site: Parameters<TerminalResourceBridge["publishSiteResource"]>[2],
    ): Promise<TerminalPublishedSiteOutput> => ({
      resourceId: "published-site", title: input.displayName ?? input.filePath,
      publishKind: "site", resourceType: "generated_site", provider: "avalon_generated", attachmentKind: "site",
      slug: "site-slug",
      url: `https://${"1".repeat(8)}-g.rallyusercontent.test`,
      mode: site.mode, stateful: site.stateful, version: 1,
      mimeType: SITE_MANIFEST_MIME_TYPE, fileCount: site.files.length,
      totalBytes: site.files.reduce((total, file) => total + file.bytes.byteLength, 0),
      manifestSha256: "c".repeat(64), createdAt: "2026-08-13T12:00:00.000Z",
    })),
  };
  const publisher: TerminalRepositoryPublisher = {
    publishBranchAndPr: vi.fn(async (): Promise<TerminalPublishedBranchAndPrOutput> => ({
      repository: "o/r", baseRef: "main", headRef: "avalon/workstream", commitSha: "c".repeat(40),
      publishedSha: "c".repeat(40), outcome: "created",
      pullRequest: { number: 1, url: "https://github.com/o/r/pull/1", title: "Ship", state: "open" },
    })),
  };
  const coordinatorEnv = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    WORKSPACE_DOS: testWorkspaceObjectBinding(createTestWorkspaceDO({
      workspaceId: W,
      regionalDatabase: database,
      register: (created) => { objectDatabases.push(created); },
    }).instance, ["terminalNetworkSettings"]),
  });
  const coordinator = new TerminalSandboxCoordinator(
    coordinatorEnv,
    testTerminalPortFactory(objectStore),
    testResourcePortFactory(objectStore),
    provider,
    clock,
    undefined,
    false,
    acquisitionObserved,
    options.scope ? { ...options.scope, runsPort: () => testHarnessRunPort(objectStore) } : undefined,
  );
  return { database, objectStore, files, provider, sandboxState, resources, publisher, coordinator, ledger, probeRoot, probeFailures, instructions, runtime: createDaytonaTerminalRuntime(
    testTerminalPortFactory(objectStore), coordinator, provider, resources, publisher, null, prepareSandbox,
    () => clock.now().getTime(), instructions) };
}

const context: HarnessToolContext = {
  workspaceId: W,
  workstreamId: S,
  harnessRunId: R,
  toolCallId: "call-runtime",
  // The receipt the harness planned this call against. Terminal keys its
  // provider task name and its `terminal_tasks` row to this, so a resumed run
  // recognizes the command it already started.
  effectIntentId: I,
  executionPrincipal: { type: "user", userId: U },
  signal: new AbortController().signal,
};

describe("Daytona Terminal runtime", () => {
  function loseObservationAfterSubmission(provider: TerminalSandboxProvider): void {
    vi.mocked(provider.runCommand).mockImplementationOnce(async (_id, input) => {
      await input.onSubmitted?.("provider-command-unknown");
      throw new Error("observation connection reset");
    });
  }
  it("does not allocate until an operation and resolves paths inside the root", async () => {
    const { objectStore, provider, runtime } = fixture();
    expect(workstreamObjectGet(objectStore, "SELECT COUNT(*) AS count FROM terminal_workspace")).toEqual({ count: 0 });

    await runtime.readFile(context, "src/file.txt");
    expect(provider.createSandbox).toHaveBeenCalledOnce();
    expect(provider.readFile).toHaveBeenCalledWith("sandbox-runtime", "/workspace/src/file.txt");
  });

  it.each([400, 404])("uses the real file read on a healthy sandbox and retains it after HTTP %s", async (status) => {
    const { provider, runtime, objectStore } = fixture();
    const unavailable = Object.assign(new Error("file endpoint unavailable"), { status });
    vi.mocked(provider.readFile).mockRejectedValueOnce(unavailable);
    await expect(runtime.readFile(context, "src/file.txt")).rejects.toMatchObject({ code: "file_read_failed" });
    expect(provider.readFile).toHaveBeenCalledWith("sandbox-runtime", "/workspace/src/file.txt");
    expect(vi.mocked(provider.runUtilityCommand).mock.calls.some(([, input]) => input.operation === "sandbox.readiness")).toBe(false);
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    expect(provider.startSandbox).not.toHaveBeenCalled();
    await expect(runtime.readFile(context, "src/file.txt")).resolves.toEqual(new TextEncoder().encode("hello\n"));
    expect(provider.createSandbox).toHaveBeenCalledOnce();
    expect(workstreamObjectGet(objectStore, "SELECT generation, sandbox_id FROM terminal_workspace WHERE id = 1"))
      .toEqual({ generation: 1, sandbox_id: "sandbox-runtime" });
  });

  it("reads a bounded text page inside the sandbox without downloading the file", async () => {
    const { provider, runtime } = fixture();

    await expect(runtime.readFilePage(context, "src/file.txt", 1, 200)).resolves.toEqual({
      content: "hello", startLine: 1, endLine: 1, totalLines: 1, truncated: false,
    });
    expect(provider.runUtilityCommand).toHaveBeenCalledOnce();
    expect(provider.runCommand).not.toHaveBeenCalled();
    expect(provider.readFile).not.toHaveBeenCalled();
  });

  it("rejects a text line larger than the page budget instead of returning a stuck cursor", () => {
    const root = mkdtempSync(join(tmpdir(), "rally-terminal-page-"));
    try {
      const path = join(root, "minified.txt");
      writeFileSync(path, "x".repeat(256 * 1_024 + 1));
      const result = spawnSync("python3", [
        "-c", TERMINAL_READ_TEXT_PAGE_PYTHON,
        root, path, "1", "200", String(256 * 1_024), String(10 * 1_048_576),
      ], { encoding: "utf8" });

      expect(result.status).toBe(51);
      expect(result.stdout.trim()).toBe(String(256 * 1_024 + 1));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // The budget covers forking a real python3 on a contended machine, not the assertion.
  }, 30_000);

  it("maps an oversized text line to an actionable limit error", async () => {
    const { provider, runtime } = fixture();
    vi.mocked(provider.runUtilityCommand).mockResolvedValueOnce({
      exitCode: 51, stdout: String(256 * 1_024 + 1), stderr: "",
    });

    await expect(runtime.readFilePage(context, "src/file.txt", 1, 200)).rejects.toMatchObject({
      code: "limit_exceeded",
      message: expect.stringContaining("single line"),
    });
  });

  it("acquires and prepares one sandbox once for all tools in the same run", async () => {
    const prepareSandbox = vi.fn(async () => undefined);
    const { coordinator, runtime } = fixture(undefined, undefined, prepareSandbox);
    const acquire = vi.spyOn(coordinator, "acquire");

    await runtime.readFile(context, "src/file.txt");
    await runtime.readFile({ ...context, toolCallId: "call-runtime-2" }, "src/file.txt");

    expect(acquire).toHaveBeenCalledOnce();
    expect(prepareSandbox).toHaveBeenCalledOnce();
  });

  it("single-flights acquisition and preparation across a burst of utility operations", async () => {
    const prepareSandbox = vi.fn(async () => undefined);
    const { coordinator, provider, runtime } = fixture(undefined, undefined, prepareSandbox);
    const acquire = vi.spyOn(coordinator, "acquire");

    const pages = await Promise.all(Array.from({ length: 64 }, (_, index) =>
      runtime.readFilePage(
        { ...context, toolCallId: `call-runtime-stress-${index}` },
        "src/file.txt",
        1,
        200,
      )));

    expect(pages).toHaveLength(64);
    expect(pages.every((page) => page?.content === "hello")).toBe(true);
    expect(acquire).toHaveBeenCalledOnce();
    expect(prepareSandbox).toHaveBeenCalledOnce();
    expect(provider.createSandbox).toHaveBeenCalledOnce();
    expect(provider.runUtilityCommand).toHaveBeenCalledTimes(64);
  });

  it("releases the lease after each call and re-runs readiness when the row moved on", async () => {
    const { coordinator, runtime, objectStore, provider, sandboxState } = fixture();
    const acquire = vi.spyOn(coordinator, "acquire");
    const bytes = new TextEncoder().encode("first\n");

    await runtime.writeFile(context, "src/file.txt", bytes);
    // Nothing is held between two calls of one run: the lease is the call's.
    expect(workstreamObjectGet(objectStore, "SELECT operation_run_id FROM terminal_workspace WHERE id = 1"))
      .toEqual({ operation_run_id: null });
    await runtime.writeFile({ ...context, toolCallId: "call-runtime-second" }, "src/file.txt", bytes);
    expect(acquire).toHaveBeenCalledOnce();

    // The sweep stopped the sandbox while this run held nothing. The cached
    // handle is not trusted past the row: the claim sees a stopped sandbox
    // and readiness starts it again under the lease this call now holds.
    workstreamObjectRun(objectStore, "UPDATE terminal_workspace SET lifecycle_state = 'stopped', idle_expires_at = NULL WHERE id = 1");
    sandboxState.current = "stopped";
    await runtime.writeFile({ ...context, toolCallId: "call-runtime-after-stop" }, "src/file.txt", bytes);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(provider.startSandbox).toHaveBeenCalledWith(
      "sandbox-runtime",
      expect.objectContaining({ deadlineAtMs: expect.any(Number) }),
    );
    expect(workstreamObjectGet(objectStore, "SELECT lifecycle_state, operation_run_id FROM terminal_workspace WHERE id = 1"))
      .toEqual({ lifecycle_state: "running", operation_run_id: null });
  });

  it("runs one run's write calls one at a time even when the harness overlaps them", async () => {
    const { provider, runtime } = fixture();
    const bytes = new TextEncoder().encode("one\n");
    let finishFirst!: () => void;
    vi.mocked(provider.writeFile).mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }));
    const first = runtime.writeFile(context, "src/a.txt", bytes);
    await vi.waitFor(() => expect(provider.writeFile).toHaveBeenCalledOnce(), { timeout: 5_000 });
    const second = runtime.writeFile({ ...context, toolCallId: "call-runtime-overlapping" }, "src/b.txt", bytes);
    await new Promise((resolve) => setTimeout(resolve, 25));
    // The lease is the run's, so the second call's claim would be answered
    // "held"; the turn is what keeps it off the sandbox until the first ends.
    expect(provider.writeFile).toHaveBeenCalledOnce();

    finishFirst();
    await expect(first).resolves.toMatchObject({ created: true });
    await expect(second).resolves.toMatchObject({ created: true });
    expect(provider.writeFile).toHaveBeenCalledTimes(2);
  });

  it("refuses an edit whose file changed since it was read", async () => {
    const { provider, runtime } = fixture();
    const read = new TextEncoder().encode("hello\n");
    const digest = await sha256Hex(read);
    vi.mocked(provider.runUtilityCommand).mockImplementationOnce(async (_id, input) => {
      expect(input.operation).toBe("file.replace");
      // The replacement is fenced on the digest of what the edit read.
      expect(input.command).toContain(digest);
      // A sibling's write landed between the read and this replacement.
      return { exitCode: 48, stdout: "", stderr: "" };
    });

    await expect(runtime.writeFile(
      context, "src/file.txt", new TextEncoder().encode("changed\n"),
      { previousText: "hello\n", previousSha256: digest },
    )).rejects.toMatchObject({ code: "file_changed" });
  });

  it("does not read past this run's own preparation of the checkout", async () => {
    let finishPreparation!: () => void;
    const prepare = vi.fn(() => new Promise<void>((resolve) => { finishPreparation = resolve; }));
    const { provider, runtime } = fixture(undefined, undefined, prepare);
    const preparing = runtime.prepare(context);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce(), { timeout: 5_000 });
    // The row already says running; the checkout is not there yet. A read
    // from this run joins the preparation instead of peeking past it.
    const read = runtime.readFile({ ...context, toolCallId: "call-runtime-early-read" }, "src/file.txt");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(provider.runUtilityCommand).not.toHaveBeenCalled();

    finishPreparation();
    await preparing;
    await expect(read).resolves.toEqual(new TextEncoder().encode("hello\n"));
  });

  it("does not let a read use a sandbox made under another principal", async () => {
    const { provider, runtime, objectStore } = fixture();
    await runtime.writeFile(context, "src/file.txt", new TextEncoder().encode("mine\n"));
    const otherPrincipal = {
      ...context,
      toolCallId: "call-runtime-other-principal",
      executionPrincipal: { type: "user" as const, userId: asUserId("00000000-0000-4000-8000-0000000000ee") },
    };

    await runtime.readFile(otherPrincipal, "src/file.txt");
    // Replaced before it was read, not read: the generation's files were
    // another principal's, and a read skips the lease but not that check.
    expect(provider.createSandbox).toHaveBeenCalledTimes(2);
    expect(workstreamObjectGet(objectStore, "SELECT generation FROM terminal_workspace WHERE id = 1"))
      .toEqual({ generation: 2 });
  });

  it("records a background agent's command in its owner's object, which does not hold the agent's run", async () => {
    const worker = "00000000-0000-4000-8000-000000000077";
    const workerRun = "00000000-0000-4000-8000-000000000078";
    const workerEffect = "00000000-0000-4000-8000-000000000079";
    // A holder from another conversation is live while its lease is, judged
    // against the instant the command starts, so the two clocks have to agree.
    const { objectStore, runtime } = fixture({ now: () => new Date() }, undefined, undefined, {
      scope: { parentKind: "workstream", backgroundAgent: true, runSubstreamId: worker, authoritySubstreamId: "0" },
    });
    // Neither the agent's run nor the receipt the harness planned for this
    // call is in this object: both live in the agent's own conversation.
    const agent = { ...context, harnessRunId: workerRun, toolCallId: "call-worker", effectIntentId: workerEffect };

    await expect(runtime.runCommand(agent, { command: "true", timeoutMs: 3_000 })).resolves.toBeDefined();
    expect(workstreamObjectGet(
      objectStore,
      "SELECT run_id, run_substream_id, state FROM terminal_tasks WHERE effect_intent_id = ?",
      workerEffect,
    )).toEqual({ run_id: workerRun, run_substream_id: worker, state: "completed" });
  });

  it("still refuses a command of this object's own run that the harness never planned", async () => {
    const { objectStore, runtime } = fixture();
    const unplanned = { ...context, toolCallId: "call-unplanned", effectIntentId: "00000000-0000-4000-8000-000000000080" };

    await expect(runtime.runCommand(unplanned, { command: "true", timeoutMs: 3_000 }))
      .rejects.toMatchObject({ code: "command_recovery_unavailable" });
    expect(workstreamObjectGet(objectStore, "SELECT COUNT(*) AS count FROM terminal_tasks")).toEqual({ count: 0 });
  });

  it("reads without the lease while another run holds it, and writes wait", async () => {
    const { objectStore, provider, runtime } = fixture();
    seedWorkstreamRun(objectStore, { id: R2, status: "running",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });
    const other = { ...context, harnessRunId: R2, toolCallId: "call-other-run" };
    let finishWrite!: () => void;
    // Hold the other run's write open at the provider so its lease is held
    // for the whole of this test's middle.
    vi.mocked(provider.writeFile).mockImplementationOnce(() => new Promise<void>((resolve) => { finishWrite = resolve; }));
    const held = runtime.writeFile(other, "src/other.txt", new TextEncoder().encode("held\n"));
    await vi.waitFor(() => expect(workstreamObjectGet(
      objectStore,
      "SELECT operation_run_id FROM terminal_workspace WHERE id = 1",
    )).toEqual({ operation_run_id: R2 }), { timeout: 5_000 });

    await expect(runtime.readFile(context, "src/file.txt")).resolves.toEqual(new TextEncoder().encode("hello\n"));
    await expect(runtime.readFilePage(context, "src/file.txt", 1, 200)).resolves.toMatchObject({ content: "hello" });
    await expect(runtime.writeFile(context, "src/file.txt", new TextEncoder().encode("mine\n")))
      .rejects.toMatchObject({ code: "sandbox_busy" });
    expect(workstreamObjectGet(objectStore, "SELECT operation_run_id FROM terminal_workspace WHERE id = 1"))
      .toEqual({ operation_run_id: R2 });

    finishWrite();
    await expect(held).resolves.toEqual({ created: true, previousLines: 0 });
    await expect(runtime.writeFile(context, "src/file.txt", new TextEncoder().encode("mine\n")))
      .resolves.toEqual({ created: false, previousLines: 1 });
    expect(workstreamObjectGet(objectStore, "SELECT operation_run_id FROM terminal_workspace WHERE id = 1"))
      .toEqual({ operation_run_id: null });
  });

  it("cleans an uploaded write temp file after a provider request failure", async () => {
    const { provider, runtime } = fixture();
    vi.mocked(provider.runUtilityCommand).mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(runtime.writeFile(context, "src/new.txt", new TextEncoder().encode("new")))
      .rejects.toThrow("provider unavailable");
    expect(provider.runUtilityCommand).toHaveBeenCalledTimes(2);
    expect(provider.runUtilityCommand).toHaveBeenLastCalledWith("sandbox-runtime", expect.objectContaining({
      operation: "file.temp_cleanup",
      command: expect.stringMatching(/^rm -f -- /u),
    }));
  });

  it("rejects a provider-resolved symlink escape before reading bytes", async () => {
    const { provider, runtime } = fixture();
    await expect(runtime.readFile(context, "escape/file.txt")).rejects.toBeInstanceOf(TerminalToolError);
    expect(provider.readFile).not.toHaveBeenCalled();
  });

  it("refuses stale command admission after a stopped run hands off the lease", async () => {
    const { objectStore, provider, runtime } = fixture();
    let finishPath!: () => void;
    vi.mocked(provider.runUtilityCommand).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishPath = resolve; });
      return { exitCode: 0, stdout: "/workspace/src\n", stderr: "" };
    });
    const stale = runtime.runCommand(context, {
      command: "printf stale",
      cwd: "src",
      timeoutMs: 3_000,
    });
    await vi.waitFor(() => expect(provider.runUtilityCommand).toHaveBeenCalledOnce());
    workstreamObjectRun(
      objectStore,
      `UPDATE runs SET status = 'needs_input', terminalized_at = ? WHERE run_id = ?`,
      Date.now(),
      R,
    );
    seedWorkstreamRun(objectStore, { id: R2, status: "admitted",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });
    await expect(runtime.readFile(
      { ...context, harnessRunId: R2, toolCallId: "call-admission-successor" },
      "src/file.txt",
    )).resolves.toEqual(new TextEncoder().encode("hello\n"));

    finishPath();
    await expect(stale).rejects.toMatchObject({ code: "command_recovery_unavailable" });
    expect(vi.mocked(provider.runCommand).mock.calls.some(([, input]) => (
      input.taskName === `avalon-task-${I}`
    ))).toBe(false);
    expect(workstreamObjectGet(
      objectStore,
      "SELECT COUNT(*) AS count FROM terminal_tasks",
    )).toEqual({ count: 0 });
  });

  it("retires a sandbox before handoff when a submitting command has no provider session", async () => {
    let clockNow = Date.now();
    const acquisitionObserved = vi.fn(async () => undefined);
    const { objectStore, provider, runtime } = fixture(
      { now: () => new Date(clockNow) },
      acquisitionObserved,
    );
    let finishSubmission!: () => void;
    let providerSubmissions = 0;
    vi.mocked(provider.createSandbox).mockImplementation(async (input) => ({
      id: input.generation === 1 ? "sandbox-runtime" : `sandbox-runtime-${input.generation}`,
      name: input.stableName,
      state: "running" as const,
      domainAllowList: input.domainAllowList,
    }));
    vi.mocked(provider.deleteSandbox).mockRejectedValueOnce(new Error("delete response lost"));
    vi.mocked(provider.getSandbox).mockRejectedValueOnce(
      Object.assign(new Error("sandbox missing after delete"), { status: 404 }),
    );
    vi.mocked(provider.runCommand).mockImplementationOnce(async (_id, input) => {
      await new Promise<void>((resolve) => { finishSubmission = resolve; });
      await input.assertSubmissionAuthority?.();
      providerSubmissions += 1;
      await input.onSubmitted?.("provider-command-too-late");
      return { exitCode: 0, stdout: "late\n", stderr: "" };
    });
    const stale = runtime.runCommand(context, { command: "sleep 3", timeoutMs: 3_000 });
    await vi.waitFor(() => {
      expect(workstreamObjectGet(
        objectStore,
        "SELECT state FROM terminal_tasks WHERE effect_intent_id = ?",
        I,
      )).toEqual({ state: "submitting" });
    });
    const submitting = workstreamObjectGet(
      objectStore,
      "SELECT command_deadline_at, started_at FROM terminal_tasks WHERE effect_intent_id = ?",
      I,
    ) as { command_deadline_at: number; started_at: number };
    // Both timestamps are written from adjacent reads of the same real clock, so
    // their difference is the submitting window itself: the request timeout, not
    // the request timeout plus the command's own 3s budget.
    expect(submitting.command_deadline_at - submitting.started_at)
      .toBeGreaterThanOrEqual(DAYTONA_REQUEST_TIMEOUT_MS);
    expect(submitting.command_deadline_at - submitting.started_at)
      .toBeLessThan(DAYTONA_REQUEST_TIMEOUT_MS + 1_000);
    workstreamObjectRun(
      objectStore,
      `UPDATE runs SET status = 'needs_input', terminalized_at = ? WHERE run_id = ?`,
      Date.now(),
      R,
    );
    seedWorkstreamRun(objectStore, { id: R2, status: "admitted",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });

    const linkedContext = {
      ...context,
      harnessRunId: R2,
      toolCallId: "call-submission-successor",
    };
    // A write: a read takes no lease and would neither wait nor recover.
    const linkedBytes = new TextEncoder().encode("linked\n");
    await expect(runtime.writeFile(
      linkedContext,
      "src/file.txt",
      linkedBytes,
    )).rejects.toMatchObject({ code: "sandbox_busy" });
    expect(provider.cleanupCommand).not.toHaveBeenCalled();
    expect(provider.stopSandbox).not.toHaveBeenCalled();
    acquisitionObserved.mockClear();

    clockNow = submitting.command_deadline_at + 1;
    await expect(runtime.writeFile(
      linkedContext,
      "src/file.txt",
      linkedBytes,
    )).resolves.toEqual({ created: false, previousLines: 1 });
    expect(provider.deleteSandbox).toHaveBeenCalledWith("sandbox-runtime");
    expect(provider.getSandbox).toHaveBeenCalledWith("sandbox-runtime");
    expect(provider.stopSandbox).not.toHaveBeenCalled();
    expect(provider.createSandbox).toHaveBeenCalledTimes(2);
    expect(provider.writeFile).toHaveBeenCalledWith(
      "sandbox-runtime-2", expect.stringContaining("/workspace/.rally/tmp/"), linkedBytes, expect.anything(),
    );
    expect(acquisitionObserved).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ action: "start", localFilesRetained: false }),
    );
    expect(workstreamObjectGet(
      objectStore,
      "SELECT generation, sandbox_id FROM terminal_workspace WHERE id = 1",
    )).toEqual({ generation: 2, sandbox_id: "sandbox-runtime-2" });
    finishSubmission();
    await expect(stale).rejects.toMatchObject({ code: "command_recovery_unavailable" });
    expect(providerSubmissions).toBe(0);
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state, provider_task_id FROM terminal_tasks WHERE effect_intent_id = ?",
      I,
    )).toEqual({ state: "cancelled", provider_task_id: null });
  });

  it("quotes parent-directory creation for deliberate writes whose paths contain spaces", async () => {
    const { provider, runtime } = fixture();
    await runtime.writeFile(context, "reports/august result.txt", new TextEncoder().encode("result"));
    expect(provider.runUtilityCommand).toHaveBeenCalledOnce();
    expect(provider.runUtilityCommand).toHaveBeenLastCalledWith("sandbox-runtime", expect.objectContaining({
      command: expect.stringContaining('dirname -- "$target"'),
    }));
  });

  it("does not repeat containment after an exact edit read the same path", async () => {
    const { provider, runtime } = fixture();
    const bytes = await runtime.readFile(context, "src/file.txt");
    vi.mocked(provider.runUtilityCommand).mockClear();

    await runtime.writeFile(
      context,
      "src/file.txt",
      new TextEncoder().encode("updated\n"),
      { previousText: new TextDecoder().decode(bytes!), previousSha256: await sha256Hex(bytes!) },
    );

    expect(provider.runUtilityCommand).toHaveBeenCalledOnce();
    expect(vi.mocked(provider.runUtilityCommand).mock.calls[0]![1].command).not.toContain("realpath -m");
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
    expect(provider.runUtilityCommand).toHaveBeenCalledWith("sandbox-runtime", expect.objectContaining({
      command: expect.stringContaining("git apply --check"),
    }));
  });

  it("applies a *** Begin Patch envelope with the vendored reference applier written beside the patch", async () => {
    const { provider, runtime, files } = fixture();
    const original = vi.mocked(provider.runUtilityCommand).getMockImplementation()!;
    const commands: string[] = [];
    let outcome: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean } = { exitCode: 0, stdout: "Done!\n", stderr: "" };
    vi.mocked(provider.runUtilityCommand).mockImplementation(async (id, input) => {
      if (input.operation === "file.apply_patch" && input.command.includes(".apply_patch.py")) {
        commands.push(input.command);
        return outcome;
      }
      return original(id, input);
    });
    const patch = [
      "",
      "*** Begin Patch",
      "*** Update File: src/file.txt",
      "@@",
      "-hello",
      "+bye",
      "*** Add File: docs/new.txt",
      "+first",
      "+second",
      "*** End Patch",
      "",
    ].join("\n");
    await expect(runtime.applyPatch(context, patch)).resolves.toEqual({
      files: [
        { path: "src/file.txt", operation: "edited", additions: 1, deletions: 1 },
        { path: "docs/new.txt", operation: "created", additions: 2, deletions: 0 },
      ],
      additions: 3,
      deletions: 1,
    });
    // The applier travels with the patch: the vendored text, unmodified, and
    // the patch without the blank line the model put before its envelope.
    const script = [...files.keys()].find((path) => path.endsWith(".apply_patch.py"))!;
    const written = [...files.keys()].find((path) => path.endsWith(".patch"))!;
    expect(new TextDecoder().decode(files.get(script))).toBe(APPLY_PATCH_SCRIPT);
    expect(new TextDecoder().decode(files.get(written))).toBe(patch.slice(1));
    expect(commands[0]).toContain(`python3 '${script}' < '${written}'`);
    expect(commands[0]).toContain("import pydantic");
    expect(commands[0]).not.toContain("git apply");
    // The install is the snapshot's pin, staged and moved into place as one
    // step, and the snapshot's own copy is searched first.
    expect(commands[0]).toContain(`--target "$staging" '${TERMINAL_PYDANTIC_REQUIREMENT}'`);
    expect(commands[0]).toContain(`mv -T -- "$staging" "$lib"`);
    expect(commands[0]).toContain(`pythonpath='${TERMINAL_SNAPSHOT_PYLIB}':"$lib"`);
    // Every path the patch names is contained before the applier runs.
    expect(commands[0]).toContain("target='/workspace/src/file.txt'");
    expect(commands[0]).toContain("target='/workspace/docs/new.txt'");
    // A path an `*** Add File:` section would create must not exist yet: the
    // applier would truncate it and still print `Done!`. The preflight is the
    // command's own shell, so it runs here against a scratch root: clean until
    // the destination appears, then exit 54 naming it, while an updated file's
    // existence is not a collision.
    // macOS exposes /var as a symlink to /private/var. The production
    // containment command compares real paths, so the scratch root substituted
    // for /workspace must be canonical too or a valid child is rejected as an
    // apparent escape on that platform.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "apply-patch-")));
    try {
      const preflight = commands[0]!.split("\nlib=")[0]!
        .replaceAll("/workspace", root)
        // Daytona is Linux and provides GNU `realpath -m`; macOS's BSD
        // `realpath` has no `-m`, so use the same non-existent-path semantics
        // through Python when exercising the generated shell locally.
        .replaceAll(
          'realpath -m -- "$target"',
          'python3 -c \'import os,sys; print(os.path.realpath(sys.argv[1]))\' "$target"',
        );
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src/file.txt"), "hello\n");
      expect(spawnSync("bash", ["-c", preflight], { encoding: "utf8" })).toMatchObject({ status: 0, stdout: "" });
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "docs/new.txt"), "kept\n");
      expect(spawnSync("bash", ["-c", preflight], { encoding: "utf8" })).toMatchObject({ status: 54, stdout: "docs/new.txt\n" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    outcome = { exitCode: 54, stdout: "docs/new.txt\n", stderr: "" };
    await expect(runtime.applyPatch(context, patch)).rejects.toMatchObject({
      code: "patch_does_not_apply",
      message: "The patch could not be applied: `docs/new.txt` already exists, and `*** Add File:` would replace it. Read it and change it in place, or choose another path.",
    });
    // Containment runs in that same shell, before the applier: a path that
    // resolves outside the root through a symlink exits 43.
    outcome = { exitCode: 0, stdout: "Done!\n", stderr: "" };
    await expect(runtime.applyPatch(context, [
      "*** Begin Patch", "*** Update File: src/escape/passwd", "@@", "-root", "+toor", "*** End Patch",
    ].join("\n"))).resolves.toBeDefined();
    const escapeRoot = realpathSync(mkdtempSync(join(tmpdir(), "apply-patch-")));
    try {
      const preflight = commands.at(-1)!.split("\nlib=")[0]!
        .replaceAll("/workspace", escapeRoot)
        .replaceAll(
          'realpath -m -- "$target"',
          'python3 -c \'import os,sys; print(os.path.realpath(sys.argv[1]))\' "$target"',
        );
      mkdirSync(join(escapeRoot, "src/escape"), { recursive: true });
      expect(spawnSync("bash", ["-c", preflight], { encoding: "utf8" })).toMatchObject({ status: 0 });
      rmSync(join(escapeRoot, "src/escape"), { recursive: true });
      symlinkSync("/etc", join(escapeRoot, "src/escape"));
      expect(spawnSync("bash", ["-c", preflight], { encoding: "utf8" })).toMatchObject({ status: 43 });
    } finally {
      rmSync(escapeRoot, { recursive: true, force: true });
    }
    // A rejected patch's classification comes first and the patch's own
    // context lines follow, still at exit 0, so a file that ends in `Done!`
    // cannot forge success; a crash's last line is the exception; a timeout,
    // an empty output and a failed install each say what they are.
    outcome = { exitCode: 0, stdout: "Invalid Context 0:\n hello\nDone!\n", stderr: "" };
    await expect(runtime.applyPatch(context, patch)).rejects.toMatchObject({
      code: "patch_does_not_apply",
      message: "The patch could not be applied: Invalid Context 0. Re-read the affected files, regenerate the patch from their current contents, and retry.",
    });
    outcome = { exitCode: 1, stdout: "Traceback (most recent call last):\n  File \"apply_patch.py\", line 1\nUnicodeDecodeError: 'utf-8' codec can't decode byte 0xff\n", stderr: "" };
    await expect(runtime.applyPatch(context, patch)).rejects.toMatchObject({
      code: "patch_does_not_apply",
      message: expect.stringContaining("The patch could not be applied: UnicodeDecodeError: 'utf-8' codec can't decode byte 0xff."),
    });
    outcome = { exitCode: 0, stdout: "", stderr: "" };
    await expect(runtime.applyPatch(context, patch)).rejects.toMatchObject({
      code: "patch_does_not_apply",
      message: expect.stringContaining("the applier printed nothing"),
    });
    outcome = { exitCode: 124, stdout: "", stderr: "", timedOut: true };
    await expect(runtime.applyPatch(context, patch)).rejects.toMatchObject({
      code: "patch_tooling_unavailable",
      message: expect.stringContaining("did not finish in time"),
    });
    outcome = { exitCode: 53, stdout: "ERROR: No matching distribution found for pydantic==2.13.5\n", stderr: "" };
    await expect(runtime.applyPatch(context, patch)).rejects.toMatchObject({
      code: "patch_tooling_unavailable",
      message: expect.stringContaining("(ERROR: No matching distribution found for pydantic==2.13.5)"),
    });
    outcome = { exitCode: 43, stdout: "", stderr: "" };
    await expect(runtime.applyPatch(context, patch)).rejects.toMatchObject({ code: "path_outside_root" });
  });

  it("refuses every write path before it touches the provider at all", async () => {
    const { objectStore, provider, runtime } = fixture();
    const unreceipted: HarnessToolContext = { ...context };
    delete unreceipted.effectIntentId;

    await expect(runtime.runCommand(unreceipted, { command: "true", timeoutMs: 3_000 }))
      .rejects.toMatchObject({ code: "tool_receipt_missing" });
    await expect(runtime.publishResource(unreceipted, { filePath: "report.md" }))
      .rejects.toMatchObject({ code: "tool_receipt_missing" });
    await expect(runtime.publishBranchAndPr(unreceipted, { title: "Ship", body: "Why" }))
      .rejects.toMatchObject({ code: "tool_receipt_missing" });

    // Not one provider call, and no sandbox. The guard used to run after
    // `acquire`, so a doomed call could still create or start a Daytona
    // sandbox, take the mutation lease, and burn a generation before being
    // rejected — side effects for a call that never ran.
    expect(provider.createSandbox).not.toHaveBeenCalled();
    expect(provider.getSandbox).not.toHaveBeenCalled();
    expect(provider.startSandbox).not.toHaveBeenCalled();
    expect(provider.runCommand).not.toHaveBeenCalled();
    expect(provider.readFile).not.toHaveBeenCalled();
    expect(workstreamObjectGet(objectStore, "SELECT COUNT(*) AS count FROM terminal_workspace"))
      .toEqual({ count: 0 });
    expect(workstreamObjectGet(objectStore, "SELECT COUNT(*) AS count FROM terminal_tasks"))
      .toEqual({ count: 0 });
  });

  it("records one durable command task and terminalizes nonzero exit normally", async () => {
    const { objectStore, provider, runtime } = fixture();
    const result = await runtime.runCommand(context, { command: "false", timeoutMs: 3_000 });
    expect(result).toMatchObject({
      state: "failed",
      terminationReason: "exited",
      exitCode: 1,
      stdout: "ok\n",
      stderr: "bad\n",
      acquisitionDurationMs: expect.any(Number),
      totalDurationMs: expect.any(Number),
    });
    expect(result.acquisitionDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(result.acquisitionDurationMs);
    expect(provider.runCommand).toHaveBeenCalledWith("sandbox-runtime", expect.objectContaining({
      taskName: `avalon-task-${I}`,
      command: "false",
      cwd: "/workspace",
      timeoutMs: 3_000,
    }));
    expect(provider.cleanupCommand).toHaveBeenCalledOnce();
    expect(provider.cleanupCommand).toHaveBeenCalledWith("sandbox-runtime", `avalon-task-${I}`);
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state, exit_code, termination_reason FROM terminal_tasks WHERE effect_intent_id = ?",
      I,
    )).toEqual({ state: "failed", exit_code: 1, termination_reason: "exited" });
  });

  it("keeps an unknown provider outcome recoverable and reattaches on the exact retry", async () => {
    const { objectStore, provider, runtime } = fixture();
    const timeoutMs = 15 * 60_000;
    const submittedAfter = Date.now();
    loseObservationAfterSubmission(provider);
    vi.mocked(provider.runCommand).mockImplementationOnce(async (_id, input) => {
      await input.onSubmitted?.("provider-command-unknown");
      return { exitCode: 0, stdout: "recovered\n", stderr: "" };
    });

    await expect(runtime.runCommand(context, { command: "printf recovered", timeoutMs }))
      .rejects.toMatchObject({
        code: "command_outcome_unknown",
        details: { reason: "Resume this run so Rally can reattach to the same durable command task." },
      });
    const retained = workstreamObjectGet(
      objectStore,
      `SELECT state, completed_at, command_deadline_at
         FROM terminal_tasks WHERE effect_intent_id = ?`,
      I,
    ) as { state: string; completed_at: number | null; command_deadline_at: number };
    expect(retained).toMatchObject({ state: "running", completed_at: null });
    expect(retained.command_deadline_at)
      .toBeGreaterThanOrEqual(submittedAfter + timeoutMs + DAYTONA_REQUEST_TIMEOUT_MS);

    await expect(runtime.runCommand(context, { command: "printf recovered", timeoutMs }))
      .resolves.toMatchObject({ state: "completed", stdout: "recovered\n" });
  });

  it("stops a retained accepted command before a linked run uses the sandbox", async () => {
    const clockNow = Date.now();
    const { objectStore, provider, runtime, sandboxState } = fixture({ now: () => new Date(clockNow) });
    loseObservationAfterSubmission(provider);

    await expect(runtime.runCommand(context, { command: "sleep 3", timeoutMs: 3_000 }))
      .rejects.toMatchObject({ code: "command_outcome_unknown" });
    const retained = workstreamObjectGet(
      objectStore,
      "SELECT state, command_deadline_at FROM terminal_tasks WHERE effect_intent_id = ?",
      I,
    ) as { state: string; command_deadline_at: number };
    expect(retained.state).toBe("running");

    workstreamObjectRun(
      objectStore,
      `UPDATE runs
          SET status = 'needs_input', terminalized_at = ?, completed_at = ?
        WHERE run_id = ?`,
      clockNow,
      clockNow,
      R,
    );
    seedWorkstreamRun(objectStore, { id: R2, status: "admitted",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });
    seedWorkstreamRun(objectStore, { id: R3, status: "admitted",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });
    const linkedContext = { ...context, harnessRunId: R2, toolCallId: "call-linked" };
    let finishStop!: () => void;
    vi.mocked(provider.stopSandbox).mockImplementationOnce(async () => (
      new Promise<void>((resolve) => {
        finishStop = () => { sandboxState.current = "stopped"; resolve(); };
      })
    ));

    // Writes, because a read takes no lease: it would neither wait for the
    // retained command nor recover it.
    const linkedBytes = new TextEncoder().encode("linked\n");
    const firstLinkedWrite = runtime.writeFile(linkedContext, "src/file.txt", linkedBytes);
    let linkedWriteSettled = false;
    void firstLinkedWrite.then(
      () => { linkedWriteSettled = true; },
      () => { linkedWriteSettled = true; },
    );
    await vi.waitFor(() => expect(provider.stopSandbox).toHaveBeenCalledOnce());
    await expect(runtime.writeFile(
      { ...context, harnessRunId: R3, toolCallId: "call-linked-contender" },
      "src/file.txt",
      linkedBytes,
    )).rejects.toMatchObject({ code: "sandbox_busy" });
    expect(linkedWriteSettled).toBe(false);
    expect(provider.startSandbox).not.toHaveBeenCalled();
    expect(provider.writeFile).not.toHaveBeenCalled();
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state FROM terminal_tasks WHERE effect_intent_id = ?",
      I,
    )).toEqual({ state: "running" });
    finishStop();
    await expect(firstLinkedWrite).resolves.toEqual({ created: false, previousLines: 1 });
    expect(provider.stopSandbox).toHaveBeenCalledWith("sandbox-runtime");
    expect(provider.cleanupCommand).not.toHaveBeenCalled();
    expect(provider.startSandbox).toHaveBeenCalledWith(
      "sandbox-runtime",
      expect.objectContaining({ deadlineAtMs: expect.any(Number) }),
    );
    expect(provider.writeFile).toHaveBeenCalledOnce();
    expect(vi.mocked(provider.stopSandbox).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(provider.startSandbox).mock.invocationCallOrder[0]!);
    expect(vi.mocked(provider.startSandbox).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(provider.writeFile).mock.invocationCallOrder[0]!);
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state, termination_reason FROM terminal_tasks WHERE effect_intent_id = ?",
      I,
    )).toEqual({ state: "cancelled", termination_reason: "cancelled" });
    // The linked run's call is over, and the recovered lease went back with it.
    expect(workstreamObjectGet(
      objectStore,
      "SELECT operation_run_id FROM terminal_workspace WHERE id = 1",
    )).toEqual({ operation_run_id: null });
  });

  it("keeps a linked run fenced when provider stop is not confirmed", async () => {
    const { objectStore, provider, runtime } = fixture();
    loseObservationAfterSubmission(provider);
    vi.mocked(provider.stopSandbox).mockRejectedValueOnce(new Error("stop unavailable"));

    await expect(runtime.runCommand(context, { command: "sleep 3", timeoutMs: 3_000 }))
      .rejects.toMatchObject({ code: "command_outcome_unknown" });
    workstreamObjectRun(
      objectStore,
      `UPDATE runs SET status = 'needs_input', terminalized_at = ? WHERE run_id = ?`,
      Date.now(),
      R,
    );
    seedWorkstreamRun(objectStore, { id: R2, status: "admitted",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });

    await expect(runtime.writeFile(
      { ...context, harnessRunId: R2, toolCallId: "call-linked" },
      "src/file.txt",
      new TextEncoder().encode("linked\n"),
    )).rejects.toMatchObject({ code: "sandbox_busy" });
    expect(provider.writeFile).not.toHaveBeenCalled();
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state FROM terminal_tasks WHERE effect_intent_id = ?",
      I,
    )).toEqual({ state: "running" });
    // The failed call released nothing: a run with its own command still
    // unsettled keeps the lease, which is what a successor recovers from.
    expect(workstreamObjectGet(
      objectStore,
      "SELECT operation_run_id FROM terminal_workspace WHERE id = 1",
    )).toEqual({ operation_run_id: R });
  });

  it.each(["absent", "archived"] as const)("reconciles a stop 404 against the retained sandbox metadata: %s", async (providerState) => {
    const { objectStore, provider, runtime } = fixture();
    vi.mocked(provider.createSandbox).mockImplementation(async (input) => ({
      id: input.generation === 1 ? "sandbox-runtime" : `sandbox-runtime-${input.generation}`,
      name: input.stableName,
      state: "running" as const,
      domainAllowList: input.domainAllowList,
    }));
    loseObservationAfterSubmission(provider);
    vi.mocked(provider.stopSandbox).mockRejectedValueOnce(
      Object.assign(new Error("sandbox missing"), { status: 404 }),
    );

    await expect(runtime.runCommand(context, { command: "sleep 3", timeoutMs: 3_000 }))
      .rejects.toMatchObject({ code: "command_outcome_unknown" });
    workstreamObjectRun(
      objectStore,
      `UPDATE runs SET status = 'needs_input', terminalized_at = ? WHERE run_id = ?`,
      Date.now(),
      R,
    );
    seedWorkstreamRun(objectStore, { id: R2, status: "admitted",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });

    if (providerState === "absent") {
      vi.mocked(provider.getSandbox).mockRejectedValueOnce(Object.assign(new Error("sandbox missing"), { status: 404 }));
    } else {
      vi.mocked(provider.getSandbox).mockResolvedValue({
        id: "sandbox-runtime", name: "sandbox-runtime", state: "archived", domainAllowList: [],
      });
    }
    const linkedBytes = new TextEncoder().encode("linked\n");
    if (providerState === "absent") {
      await expect(runtime.writeFile(
        { ...context, harnessRunId: R2, toolCallId: "call-missing-sandbox-successor" }, "src/file.txt", linkedBytes,
      )).rejects.toMatchObject({ code: "sandbox_busy" });
      expect(provider.deleteSandbox).not.toHaveBeenCalled();
      expect(provider.createSandbox).toHaveBeenCalledOnce();
      expect(workstreamObjectGet(objectStore, "SELECT generation, sandbox_id FROM terminal_workspace WHERE id = 1"))
        .toEqual({ generation: 1, sandbox_id: "sandbox-runtime" });
      expect(workstreamObjectGet(objectStore, "SELECT state FROM terminal_tasks WHERE effect_intent_id = ?", I))
        .toEqual({ state: "running" });
      return;
    }
    const expectedId = "sandbox-runtime";
    const expectedGeneration = 1;
    await expect(runtime.writeFile(
      { ...context, harnessRunId: R2, toolCallId: "call-missing-sandbox-successor" },
      "src/file.txt",
      linkedBytes,
    )).resolves.toEqual({ created: false, previousLines: 1 });
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    expect(provider.createSandbox).toHaveBeenCalledTimes(expectedGeneration);
    expect(provider.writeFile).toHaveBeenCalledWith(
      expectedId, expect.stringContaining("/workspace/.rally/tmp/"), linkedBytes, expect.anything(),
    );
    // Recovered, used, and released: the call is over.
    expect(workstreamObjectGet(
      objectStore,
      "SELECT generation, sandbox_id, operation_run_id FROM terminal_workspace WHERE id = 1",
    )).toEqual({ generation: expectedGeneration, sandbox_id: expectedId, operation_run_id: null });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state FROM terminal_tasks WHERE effect_intent_id = ?",
      I,
    )).toEqual({ state: "cancelled" });
  });

  it("keeps an aborted command unsettled until tokenized recovery confirms provider stop", async () => {
    const controller = new AbortController();
    const { objectStore, provider, runtime, sandboxState } = fixture();
    vi.mocked(provider.runCommand).mockImplementationOnce(async (_id, input) => {
      await input.onSubmitted?.("provider-command-aborted");
      return new Promise((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(new Error("provider cancellation")), { once: true });
      });
    });
    vi.mocked(provider.stopSandbox)
      .mockRejectedValueOnce(new Error("first stop failed"))
      .mockImplementationOnce(async () => { sandboxState.current = "stopped"; });
    const abortedContext = { ...context, signal: controller.signal };
    const command = runtime.runCommand(abortedContext, {
      command: "sleep 100",
      timeoutMs: 120_000,
    });
    await vi.waitFor(() => expect(workstreamObjectGet(
      objectStore,
      "SELECT state FROM terminal_tasks WHERE effect_intent_id = ?",
      I,
    )).toEqual({ state: "running" }));
    controller.abort();
    await expect(command).rejects.toMatchObject({ code: "command_outcome_unknown" });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state, completed_at FROM terminal_tasks WHERE effect_intent_id = ?",
      I,
    )).toEqual({ state: "running", completed_at: null });
    workstreamObjectRun(
      objectStore,
      `UPDATE runs SET status = 'needs_input', terminalized_at = ? WHERE run_id = ?`,
      Date.now(),
      R,
    );
    seedWorkstreamRun(objectStore, { id: R2, status: "admitted",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });
    const linked = { ...context, harnessRunId: R2, toolCallId: "call-abort-successor" };
    const linkedBytes = new TextEncoder().encode("linked\n");
    await expect(runtime.writeFile(linked, "src/file.txt", linkedBytes))
      .rejects.toMatchObject({ code: "sandbox_busy" });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state FROM terminal_tasks WHERE effect_intent_id = ?",
      I,
    )).toEqual({ state: "running" });

    await expect(runtime.writeFile(linked, "src/file.txt", linkedBytes))
      .resolves.toEqual({ created: false, previousLines: 1 });
    expect(provider.stopSandbox).toHaveBeenCalledTimes(2);
    expect(provider.startSandbox).toHaveBeenCalledWith(
      "sandbox-runtime",
      expect.objectContaining({ deadlineAtMs: expect.any(Number) }),
    );
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state FROM terminal_tasks WHERE effect_intent_id = ?",
      I,
    )).toEqual({ state: "cancelled" });
  });

  it("keeps a late large result local after recovery wins without publishing or deleting", async () => {
    const { objectStore, provider, resources, runtime } = fixture();
    let finishProvider!: (result: { exitCode: number; stdout: string; stderr: string }) => void;
    const providerPending = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
      (resolve) => { finishProvider = resolve; },
    );
    vi.mocked(provider.runCommand).mockImplementationOnce(async (_id, input) => {
      await input.onSubmitted?.("provider-command-late");
      return providerPending;
    });

    const late = runtime.runCommand(context, { command: "sleep 3", timeoutMs: 3_000 });
    await vi.waitFor(() => {
      expect(workstreamObjectGet(
        objectStore,
        "SELECT state FROM terminal_tasks WHERE effect_intent_id = ?",
        I,
      )).toEqual({ state: "running" });
    });
    workstreamObjectRun(
      objectStore,
      `UPDATE runs SET status = 'needs_input', terminalized_at = ? WHERE run_id = ?`,
      Date.now(),
      R,
    );
    seedWorkstreamRun(objectStore, { id: R2, status: "admitted",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });

    // A write: it is what recovers the retained command. A read would take
    // no lease and leave the command as it found it.
    await expect(runtime.writeFile(
      { ...context, harnessRunId: R2, toolCallId: "call-linked" },
      "src/file.txt",
      new TextEncoder().encode("linked\n"),
    )).resolves.toEqual({ created: false, previousLines: 1 });
    finishProvider({ exitCode: 7, stdout: "x".repeat(150_000), stderr: "late-error\n" });
    await expect(late).resolves.toMatchObject({
      state: "failed",
      exitCode: 7,
      stdout: expect.stringContaining("provider output omitted"),
      stderr: "late-error\n",
    });
    expect(provider.cleanupCommand).not.toHaveBeenCalled();
    expect(provider.stopSandbox).toHaveBeenCalledOnce();
    expect(provider.startSandbox).toHaveBeenCalledOnce();
    expect(resources.publishResource).not.toHaveBeenCalled();
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state, stdout_head FROM terminal_tasks WHERE effect_intent_id = ?",
      I,
    )).toEqual({ state: "cancelled", stdout_head: "" });
  });

  it("does not settle or publish a late result after its holder yields", async () => {
    const { objectStore, provider, resources, runtime } = fixture();
    let finishProvider!: (result: { exitCode: number; stdout: string; stderr: string }) => void;
    vi.mocked(provider.runCommand).mockImplementationOnce(async (_id, input) => {
      await input.onSubmitted?.("provider-command-yielded");
      return new Promise((resolve) => { finishProvider = resolve; });
    });

    const late = runtime.runCommand(context, { command: "sleep 3", timeoutMs: 3_000 });
    await vi.waitFor(() => expect(workstreamObjectGet(
      objectStore,
      "SELECT state FROM terminal_tasks WHERE effect_intent_id = ?",
      I,
    )).toEqual({ state: "running" }));
    workstreamObjectRun(
      objectStore,
      `UPDATE runs SET status = 'needs_input', terminalized_at = ? WHERE run_id = ?`,
      Date.now(),
      R,
    );

    finishProvider({ exitCode: 0, stdout: "x".repeat(150_000), stderr: "" });
    await expect(late).resolves.toMatchObject({
      state: "completed",
      stdout: expect.stringContaining("provider output omitted"),
    });
    expect(resources.publishResource).not.toHaveBeenCalled();
    expect(provider.cleanupCommand).not.toHaveBeenCalled();
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state, stdout_head FROM terminal_tasks WHERE effect_intent_id = ?",
      I,
    )).toEqual({ state: "running", stdout_head: "" });
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
      "SELECT stdout_head FROM terminal_tasks WHERE effect_intent_id = ?",
      I,
    )).toEqual({ stdout_head: "[REDACTED] [REDACTED]\n" });
  });

  it("resumes a nonterminal durable command task without replacing its original timing", async () => {
    const { objectStore, provider, runtime } = fixture();
    await runtime.readFile(context, "src/file.txt");
    vi.mocked(provider.runUtilityCommand).mockClear();
    vi.mocked(provider.runCommand).mockResolvedValueOnce({ exitCode: 0, stdout: "recovered\n", stderr: "" });
    const commandHash = await sha256Hex(JSON.stringify({
      command: "printf recovered",
      cwd: "/workspace",
      timeoutMs: 120_000,
    }));
    workstreamObjectRun(
      objectStore,
      `INSERT INTO terminal_tasks
       (task_id, run_id, effect_intent_id, sandbox_generation, provider_task_name,
        state, command_sha256, command_deadline_at, stdout_head, stdout_tail,
        stderr_head, stderr_tail, stdout_bytes, stderr_bytes, started_at,
        created_at, updated_at)
       VALUES ('task-existing', ?, ?, 1, ?, 'running', ?, ?, '', '', '', '', 0, 0, ?, ?, ?)`,
      R, I, `avalon-task-${I}`, commandHash,
      Date.parse("2026-08-13T12:02:00.000Z"),
      Date.parse("2026-08-13T12:00:00.000Z"),
      Date.parse("2026-08-13T12:00:00.000Z"),
      Date.parse("2026-08-13T12:00:00.000Z"),
    );

    await expect(runtime.runCommand(context, { command: "printf recovered", timeoutMs: 120_000 })).resolves.toMatchObject({
      state: "completed",
      stdout: "recovered\n",
      startedAt: "2026-08-13T12:00:00.000Z",
    });
    expect(provider.runCommand).toHaveBeenCalledOnce();
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state, started_at FROM terminal_tasks WHERE effect_intent_id = ?",
      I,
    )).toEqual({ state: "completed", started_at: Date.parse("2026-08-13T12:00:00.000Z") });
  });

  it("fails closed when a terminal task lacks complete replay timestamps", async () => {
    const { objectStore, provider, runtime } = fixture();
    await runtime.readFile(context, "src/file.txt");
    vi.mocked(provider.runUtilityCommand).mockClear();
    workstreamObjectRun(
      objectStore,
      `INSERT INTO terminal_tasks
       (task_id, run_id, effect_intent_id, sandbox_generation, provider_task_name,
        state, command_sha256, command_deadline_at, stdout_head, stdout_tail,
        stderr_head, stderr_tail, stdout_bytes, stderr_bytes, started_at,
        completed_at, created_at, updated_at)
       VALUES ('task-incomplete', ?, ?, 1, ?, 'completed', ?, ?, 'done', '', '', '',
               4, 0, NULL, NULL, ?, ?)`,
      R, I, `avalon-task-${I}`, "a".repeat(64),
      Date.parse("2026-08-13T12:02:00.000Z"),
      Date.parse("2026-08-13T12:00:00.000Z"),
      Date.parse("2026-08-13T12:00:00.000Z"),
    );

    await expect(runtime.runCommand(context, { command: "printf done", timeoutMs: 120_000 }))
      .rejects.toMatchObject({ code: "command_recovery_unavailable" });
    expect(provider.runCommand).not.toHaveBeenCalled();
  });

  it("uses create-only automatic import destinations and delegates publication bytes", async () => {
    const { files, provider, resources, runtime } = fixture();
    await expect(runtime.importResource(context, { resourceId: "00000000-0000-4000-8000-000000000099" })).resolves.toMatchObject({
      resourceId: "00000000-0000-4000-8000-000000000099",
      filePath: ".rally/resources/00000000-0000-4000-8000-000000000099/resource",
    });
    files.set("/workspace/.rally-output/report.txt", new TextEncoder().encode("report"));
    vi.mocked(provider.runUtilityCommand).mockClear();
    await expect(runtime.publishResource(context, { filePath: "report.txt" })).resolves.toMatchObject({ resourceId: "published", sizeBytes: 6 });
    // Three now, not two: the path's shape is asked once before the
    // before/after stability pair, because a directory and a file publish
    // through entirely different paths.
    expect(provider.runUtilityCommand).toHaveBeenCalledTimes(3);
    expect(provider.readFile).toHaveBeenCalledWith("sandbox-runtime", "/workspace/.rally-output/report.txt");
    expect(resources.importResource).toHaveBeenCalledWith(context, expect.anything(), ".rally/resources/00000000-0000-4000-8000-000000000099/resource", 1, "sandbox-runtime", expect.anything());
  });

  it("publishes complete command output before returning bounded inline head and tail", async () => {
    const { database, objectStore, resources, runtime } = fixture();
    database.prepare(
      `INSERT INTO resources
       (id, workspace_id, resource_type, provider, title, metadata_json, created_at, updated_at)
       VALUES ('command-log', ?, 'generated_file', 'rally_terminal', 'Command log', '{}', '2026-08-13', '2026-08-13')`,
    ).run(W);
    vi.mocked(resources.publishResource).mockResolvedValueOnce({
      resourceId: "command-log", title: "Command log", publishKind: "file", resourceType: "generated_file",
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
      expect.objectContaining({ filePath: `.rally/logs/${I}.log` }),
      expect.any(Uint8Array),
    );
    expect(workstreamObjectGet(
      objectStore,
      "SELECT output_resource_id FROM terminal_tasks WHERE effect_intent_id = ?",
      I,
    )).toEqual({ output_resource_id: "command-log" });
  });

  it("publishes a directory with a root index.js as an active site, module excluded from assets", async () => {
    const { files, provider, resources, runtime } = fixture();
    files.set("/workspace/.rally-output/rsvp/index.html", new TextEncoder().encode("<h1>RSVP</h1>"));
    files.set("/workspace/.rally-output/rsvp/style.css", new TextEncoder().encode("h1{color:red}"));
    files.set(
      "/workspace/.rally-output/rsvp/index.js",
      new TextEncoder().encode("export class SiteData extends DurableObject { async fetch() {} }"),
    );
    await expect(runtime.publishResource(context, { filePath: "rsvp" })).resolves.toMatchObject({
      resourceType: "generated_site",
      attachmentKind: "site",
      mode: "active",
      // The class is exported, so the site gets a database.
      stateful: true,
      fileCount: 3,
    });
    const [, , site] = vi.mocked(resources.publishSiteResource).mock.calls[0]!;
    expect(site.files.map((file) => file.path).sort()).toEqual(["index.html", "index.js", "style.css"]);
    expect(site.serverModuleSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(provider.readFile).toHaveBeenCalledWith("sandbox-runtime", "/workspace/.rally-output/rsvp/index.js");
  });

  it("publishes a directory with only index.html as a static site with no database", async () => {
    const { files, resources, runtime } = fixture();
    files.set("/workspace/.rally-output/checklist/index.html", new TextEncoder().encode("<ul></ul>"));
    await expect(runtime.publishResource(context, { filePath: "checklist" })).resolves.toMatchObject({
      resourceType: "generated_site",
      mode: "static",
      stateful: false,
    });
    const [, , site] = vi.mocked(resources.publishSiteResource).mock.calls[0]!;
    expect(site.serverModuleSha256).toBeNull();
  });

  it("treats a stateless active module as a site without storage", async () => {
    const { files, runtime } = fixture();
    files.set("/workspace/.rally-output/search/index.html", new TextEncoder().encode("<input>"));
    files.set(
      "/workspace/.rally-output/search/index.js",
      new TextEncoder().encode("export default { async fetch(r, env) { return env.ASSETS.fetch(r); } };"),
    );
    await expect(runtime.publishResource(context, { filePath: "search" })).resolves.toMatchObject({
      mode: "active",
      stateful: false,
    });
  });

  it("bundles a multi-file directory with no entry into one zip through the document path", async () => {
    const { files, resources, runtime } = fixture();
    files.set("/workspace/.rally-output/exports/a.csv", new TextEncoder().encode("a,b\n1,2"));
    files.set("/workspace/.rally-output/exports/b.csv", new TextEncoder().encode("c,d\n3,4"));
    const published = await runtime.publishResource(context, { filePath: "exports" });
    expect(published).toMatchObject({ publishKind: "archive", resourceType: "generated_file", fileCount: 2 });
    expect(resources.publishSiteResource).not.toHaveBeenCalled();
    // It rides the ordinary document publish, so identity, replay, and version
    // capture all behave exactly as a document's do.
    const [, , bytes] = vi.mocked(resources.publishResource).mock.calls[0]!;
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("refuses a one-file directory that reaches the archive branch", async () => {
    const { files, runtime } = fixture();
    files.set("/workspace/.rally-output/report/summary.md", new TextEncoder().encode("# Summary"));
    await expect(runtime.publishResource(context, { filePath: "report" }))
      .rejects.toMatchObject({ code: "single_file_directory" });
  });

  it("refuses a republish that would downgrade a live site to an archive", async () => {
    const { files, resources, runtime } = fixture();
    vi.mocked(resources.publishedKindForPath).mockResolvedValue("site");
    files.set("/workspace/.rally-output/rsvp/a.txt", new TextEncoder().encode("one"));
    files.set("/workspace/.rally-output/rsvp/b.txt", new TextEncoder().encode("two"));
    await expect(runtime.publishResource(context, { filePath: "rsvp" }))
      .rejects.toMatchObject({ code: "site_entry_removed" });
  });

  it("refuses an empty directory rather than publishing an empty artifact", async () => {
    const { files, runtime } = fixture();
    files.set("/workspace/.rally-output/other/thing.txt", new TextEncoder().encode("x"));
    await expect(runtime.publishResource(context, { filePath: "empty" }))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects missing and empty generated files with model-repairable publication errors", async () => {
    const { files, runtime } = fixture();
    await expect(runtime.publishResource(context, { filePath: "missing.txt" })).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("AVALON_RESOURCE_DIR"),
    });
    files.set("/workspace/.rally-output/empty.txt", new Uint8Array());
    await expect(runtime.publishResource(context, { filePath: "empty.txt" })).rejects.toMatchObject({
      code: "resource_empty",
      message: expect.stringContaining("empty"),
    });
  });

  it("lets an in-flight activation acquisition settle before a checkout replaces the generation", async () => {
    // Activation no longer blocks the model, so its first tool can be
    // checkout_repository while activation's own repository bootstrap is still
    // running against the sandbox. Replacing the generation underneath that
    // work would be two operations on one sandbox, so the checkout waits for the
    // acquisition to end — here by rejecting, which is what a checkout repairs —
    // before it starts.
    const { provider, resources, publisher, objectStore } = fixture();
    let rejectAcquire = (): void => undefined;
    const acquiring = new Promise<never>((_resolve, reject) => {
      rejectAcquire = () => reject(new TerminalToolError("repository_access_revoked", "Repository access was revoked."));
    });
    const coordinator = {
      acquire: vi.fn(() => acquiring),
      claimForOperation: vi.fn(async () => "held" as const),
      release: vi.fn(async () => undefined),
      holderSubstreamId: () => null,
      peekRunning: vi.fn(async () => null),
    } satisfies Pick<TerminalSandboxCoordinator, "acquire" | "claimForOperation" | "release" | "peekRunning" | "holderSubstreamId">;
    const checkedOut: TerminalCheckoutRepositoryOutput = {
      repository: "o/r", repositoryId: 1, connectionId: "connection-1", connectionName: "GitHub",
      baseRef: "main", baseSha: "a".repeat(40), headRef: "rally/workstream", remoteAccess: "read_only",
      localEditsAllowed: true, remoteWritesAllowed: false, outcome: "selected", backup: null,
    };
    const checkout = vi.fn(async () => checkedOut);
    const selector: TerminalRepositorySelector = { checkout };
    const runtime = createDaytonaTerminalRuntime(
      testTerminalPortFactory(objectStore), coordinator, provider, resources, publisher, selector, undefined, () => 0,
    );

    const activation = runtime.prepare(context).then(() => "resolved", (error: unknown) => error);
    const checkingOut = runtime.checkoutRepository(context, { repositoryFullName: "o/r", requiredRemoteAccess: "read_only" });
    // Flush every continuation the checkout could have taken while the
    // acquisition is still pending: it must not have reached the selector.
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    expect(checkout).not.toHaveBeenCalled();

    rejectAcquire();
    await expect(checkingOut).resolves.toMatchObject({ repository: "o/r" });
    expect(checkout).toHaveBeenCalledOnce();
    await expect(activation).resolves.toMatchObject({ code: "repository_access_revoked" });
  });
  describe("repository instruction files", () => {
    function checkout() {
      const built = fixture(undefined, undefined, undefined, { withInstructions: true });
      writeFileSync(join(built.probeRoot, "AGENTS.md"), "root rules\n");
      mkdirSync(join(built.probeRoot, "src"), { recursive: true });
      return built;
    }

    it("delivers the root file with a read, records it once, and hands the page back intact", async () => {
      const { runtime, ledger, provider, probeFailures } = checkout();
      await expect(runtime.readFilePage(context, "src/file.txt", 1, 200)).resolves.toEqual({
        content: "hello", startLine: 1, endLine: 1, totalLines: 1, truncated: false,
      });
      const pending = ledger.pendingDeliveries();
      expect(pending.map((delivery) => [delivery.block.blockId, delivery.block.content, delivery.block.residency]))
        .toEqual([["AGENTS.md", "root rules\n", "transcript"]]);
      expect(pending[0]!.sourceId).toBe(`AGENTS.md@${await sha256Hex(new TextEncoder().encode("root rules\n"))}`);
      // The probe ran after the read, in its own group, without touching the read's exit status.
      const command = vi.mocked(provider.runUtilityCommand).mock.calls.find(([, input]) => input.operation === "file.read_page")![1].command;
      expect(command).toMatch(/^python3 .*; s=\$\?\n\( set \+e; python3 .*\) \|\| true\nexit \$s$/su);
      await runtime.readFilePage(context, "src/file.txt", 1, 200);
      expect(ledger.allBlocks()).toHaveLength(1);
      expect(probeFailures).toEqual([]);
    });

    it("lets a mutation beneath an unread instruction file proceed, and delivers the file with the read an edit starts with", async () => {
      const { runtime, ledger, files, probeRoot } = checkout();
      writeFileSync(join(probeRoot, "src", "AGENTS.md"), "never write generated files\n");
      const bytes = new TextEncoder().encode("new\n");
      // A whole-file write carries no probe: it is not refused, and it discovers nothing.
      await expect(runtime.writeFile(context, "src/new.txt", bytes)).resolves.toMatchObject({ created: true });
      expect(files.has("/workspace/src/new.txt")).toBe(true);
      expect(ledger.pendingDeliveries()).toEqual([]);
      // The read an edit starts with records the chain for delivery with that batch.
      await expect(runtime.readFile(context, "src/file.txt")).resolves.toEqual(new TextEncoder().encode("hello\n"));
      expect(ledger.pendingDeliveries().map((delivery) => delivery.block.blockId)).toEqual(["AGENTS.md", "src/AGENTS.md"]);
      // Recorded is not yet seen: a second read in the same batch reports the
      // same files again, and nothing is recorded twice.
      await expect(runtime.readFile(context, "src/file.txt")).resolves.toEqual(new TextEncoder().encode("hello\n"));
      expect(ledger.allBlocks()).toHaveLength(2);
      ledger.markDeliveredInTransaction(ledger.pendingDeliveries(), Date.now());
      // Editing the instruction file itself delivers the new content once more, through the next read.
      writeFileSync(join(probeRoot, "src", "AGENTS.md"), "revised\n");
      await expect(runtime.readFile(context, "src/file.txt")).resolves.toEqual(new TextEncoder().encode("hello\n"));
      expect(ledger.allBlocks().filter((block) => block.blockId === "src/AGENTS.md").map((block) => [block.content, block.residency]).sort())
        .toEqual([["never write generated files\n", "none"], ["revised\n", "transcript"]]);
      // A patch carries no probe either, and proceeds before that message has landed.
      await expect(runtime.applyPatch(context, "--- a/src/file.txt\n+++ b/src/file.txt\n@@ -1 +1 @@\n-hello\n+bye\n"))
        .resolves.toMatchObject({ files: [{ path: "src/file.txt", operation: "edited" }] });
    });

    it("reports a ledger failure once, leaves the read's outcome alone, and keeps discovering on the next read", async () => {
      const { runtime, ledger, probeFailures } = checkout();
      vi.spyOn(ledger, "recordLoaded").mockImplementationOnce(() => { throw new Error("ledger unavailable"); });
      // The probe found the root file and the ledger could not record it: the
      // read still succeeds, and the failure is reported rather than surfaced.
      await expect(runtime.readFilePage(context, "src/file.txt", 1, 200)).resolves.toMatchObject({ content: "hello" });
      expect(ledger.pendingDeliveries()).toEqual([]);
      expect(probeFailures).toEqual(["record"]);
      // The next read records it as before.
      await expect(runtime.readFilePage(context, "src/file.txt", 1, 200)).resolves.toMatchObject({ content: "hello" });
      expect(ledger.pendingDeliveries().map((delivery) => delivery.block.blockId)).toEqual(["AGENTS.md"]);
      expect(probeFailures).toEqual(["record"]);
    });

    it("admits a command without a probe of its own and retires every block when the checkout is replaced", async () => {
      const { runtime, ledger, objectStore, provider, resources, publisher, coordinator, instructions } = checkout();
      // A command runs the model's own text, which the probe cannot ride, and
      // pays no probe command first: it is admitted at once and discovers nothing.
      await expect(runtime.runCommand(context, { command: "echo hi", timeoutMs: 1_000 })).resolves.toMatchObject({ state: "completed" });
      expect(workstreamObjectGet(objectStore, "SELECT COUNT(*) AS count FROM terminal_tasks")).toEqual({ count: 1 });
      expect(ledger.pendingDeliveries()).toHaveLength(0);
      // A read is what discovers the root file.
      await expect(runtime.readFilePage(context, "src/file.txt", 1, 200)).resolves.toMatchObject({ content: "hello" });
      expect(ledger.pendingDeliveries()).toHaveLength(1);
      ledger.markDeliveredInTransaction(ledger.pendingDeliveries(), Date.now());
      expect(ledger.residentBlocks({ kind: "repository_instructions" })).toHaveLength(1);

      const checkedOut: TerminalCheckoutRepositoryOutput = {
        repository: "o/r", repositoryId: 1, connectionId: "connection-1", connectionName: "GitHub",
        baseRef: "main", baseSha: "a".repeat(40), headRef: "rally/workstream", remoteAccess: "read_only",
        localEditsAllowed: true, remoteWritesAllowed: false, outcome: "selected", backup: null,
      };
      const selector: TerminalRepositorySelector = { checkout: vi.fn(async () => checkedOut) };
      const replacing = createDaytonaTerminalRuntime(
        testTerminalPortFactory(objectStore), coordinator, provider, resources, publisher, selector, undefined, () => 0, instructions,
      );
      await replacing.checkoutRepository(context, { repositoryFullName: "o/r", requiredRemoteAccess: "read_only" });
      expect(ledger.residentBlocks({ kind: "repository_instructions" })).toEqual([]);
      expect(ledger.allBlocks().map((block) => block.residency)).toEqual(["none"]);
    });
  });
});
