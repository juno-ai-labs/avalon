import { asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { asHarnessRunId, asUserId } from "@rally/contracts";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __integrationTesting } from "../src/services/integrations";
import { withLocalWorkstreamAuthorities } from "../src/runtime/local-authorities";
import { withWorkstreamRuntimeDatabase } from "../src/services/workstream-runtime-database";
import {
  TERMINAL_PLUGIN_ACTIVATION_BUDGET_MS,
} from "../src/services/terminal/contract";
import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import { compileTerminalNetworkPolicy } from "../src/services/terminal/network-policy";
import { createAvalonTerminalPlugin } from "../src/services/terminal/plugin";
import type { TerminalGitHubReadGateway } from "../src/services/terminal/repository";
import { createTestEnv } from "./helpers/cloudflare-test";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import type { DatabaseSync } from "node:sqlite";
import {
  openWorkstreamAuthorityForTest,
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testTerminalOperationExecutor,
  testWorkstreamObjectStore,
  workstreamObjectGet,
  workstreamObjectRun,
  seedWorkstreamObjectParticipant,
} from "./helpers/durable-authority";

const W = asWorkspaceId("30000000-0000-4000-8000-000000000001");
const S = asWorkstreamId("30000000-0000-4000-8000-000000000002");
const R = asHarnessRunId("30000000-0000-4000-8000-000000000003");
const U = asUserId("30000000-0000-4000-8000-000000000004");
const CONNECTION = "30000000-0000-4000-8000-000000000005";
const BASE = "a".repeat(40);
const HEAD_REF = "rally/workstream-30000000";

const openDatabases: ReturnType<typeof preRetirementProductSqliteDatabase>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of openDatabases.splice(0)) database.close();
});

function fixture(capability: "supported" | "unsupported", emergencyDisabled = false) {
  const database = preRetirementProductSqliteDatabase();
  openDatabases.push(database);
  // Tool loading routes work-stream state through the object port once the
  // authority is open; the run row lives only there since migration 0090.
  openWorkstreamAuthorityForTest(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${U}', 'plugin-user', 'plugin@example.com', 'Plugin', '2026-08-13', '2026-08-13');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${W}', 'Plugin', 'terminal-plugin', 'global', '${U}', '2026-08-13', '2026-08-13');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${W}', '${U}', 'owner', 'active', '2026-08-13');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${S}', '${W}', 'Plugin', 'Plugin', 'ad_hoc', '${U}', 'idle',
            '2026-08-13', '2026-08-13', '2026-08-13');
  `);
  const objectStore = testWorkstreamObjectStore();
  openDatabases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, { workstreamId: S, workspaceId: W });
  const objectStores = new Map<string, DatabaseSync>([[S, objectStore]]);
  workstreamObjectRun(
    objectStore,
    `INSERT INTO harness_runs
      (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
    VALUES (?, ?, ?, 'test', ?, 'running', '2026-08-13')`,
    R, W, S, JSON.stringify({ type: "user", userId: U }),
  );
  const env = createTestEnv({
    DB: sqliteD1(database), AVALON_REGION: "global",
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    TERMINAL_REGION_CAPABILITY: capability,
    DAYTONA_API_KEY: "daytona-key", DAYTONA_API_URL: "https://app.daytona.io/api",
    DAYTONA_TARGET: "us", DAYTONA_TERMINAL_SNAPSHOT: "terminal-snapshot",
    TERMINAL_EMERGENCY_DISABLED: emergencyDisabled ? "true" : "false",
  });
  const input: WorkstreamWorkflowInput = {
    region: "global", workspaceId: W, workstreamId: S, harnessRunId: R,
    triggerMessageId: null, automationSubscriptionId: null, activityId: null,
    executionPrincipal: { type: "user", userId: U }, reason: "user_message",
  };
  return { database, objectStore, env, input };
}

function provider(): TerminalSandboxProvider {
  return {
    createSandbox: vi.fn(async (request) => ({
      id: `sandbox-${request.generation}`,
      name: request.stableName,
      state: "running" as const,
      domainAllowList: request.domainAllowList,
    })),
    getSandbox: vi.fn(async (name) => ({
      id: "sandbox-existing",
      name,
      state: "running" as const,
      domainAllowList: compileTerminalNetworkPolicy("trusted_only", []).effectiveDomains,
    })),
    startSandbox: vi.fn(async () => undefined),
    stopSandbox: vi.fn(async () => undefined),
    archiveSandbox: vi.fn(async () => undefined),
    deleteSandbox: vi.fn(async () => undefined),
    updateNetworkPolicy: vi.fn(async () => undefined),
    configureGitHubReadAccess: vi.fn(async () => undefined),
    clearGitHubReadAccess: vi.fn(async () => undefined),
    readFile: vi.fn(async () => new Uint8Array()),
    writeFile: vi.fn(async () => undefined),
    runUtilityCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    cleanupCommand: vi.fn(async () => undefined),
    publishGitBundle: vi.fn(async (request) => ({ publishedSha: request.headSha })),
  };
}

function selectRepository(
  database: ReturnType<typeof preRetirementProductSqliteDatabase>,
  objectStore: DatabaseSync,
): void {
  database.exec(`
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
       display_name, granted_scopes_json, model_plugin_id, status, config_json, created_at, updated_at)
    VALUES ('${CONNECTION}', '${W}', 'github', 'workspace', NULL, '123', 'GitHub',
            '["github.contents.read","github.pull_requests.read"]', 'plugin_github', 'healthy',
            '{"githubRepositoryAccess":{"version":1,"revision":1,"mode":"all_repositories","defaultAccess":"full_access","repositories":[]}}',
            '2026-08-13', '2026-08-13');
  `);
  workstreamObjectRun(
    objectStore,
    `INSERT INTO terminal_repository
       (id, connection_id, repository_id, repository_full_name, base_ref, base_sha,
        head_ref, state, selected_by_user_id, remote_access, created_at, updated_at)
     VALUES (1, ?, 42, 'owner/repo', 'main', ?, ?, 'selected', ?, 'read_only', ?, ?)`,
    CONNECTION,
    BASE,
    HEAD_REF,
    U,
    Date.parse("2026-08-13T00:00:00.000Z"),
    Date.parse("2026-08-13T00:00:00.000Z"),
  );
}

function readGateway(baseSha = BASE): TerminalGitHubReadGateway {
  return {
    mintRepositoryToken: vi.fn(async () => ({
      accessToken: "read-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })),
    verifyRepositoryIdentity: vi.fn(async () => undefined),
    resolveBaseRef: vi.fn(async () => baseSha),
  };
}

describe("Terminal Bind integration", () => {
  it("registers the complete deferred plugin without allocating a sandbox", async () => {
    const { objectStore, env, input } = fixture("supported");
    const tools = await __integrationTesting.loadHarnessTools(withWorkstreamRuntimeDatabase(env, W, S), input);
    const plugin = tools.plugins.find((candidate) => candidate.canonicalId === "rally:terminal");

    expect(plugin).toMatchObject({ preload: false, explicit: false, shortWireName: "terminal" });
    expect(plugin?.tools.map((tool) => tool.definition.name)).toEqual([
      "read_file", "edit_file", "write_file", "apply_patch", "run_command",
      "checkout_repository", "import_resource", "publish_resource", "publish_branch_and_pr",
    ]);
    expect(workstreamObjectGet(objectStore, "SELECT COUNT(*) AS count FROM terminal_workspace")).toEqual({ count: 0 });
  });

  it("starts the sandbox when Terminal activates, before any Terminal tool executes", async () => {
    const { objectStore, env, input } = fixture("supported");
    const sandboxProvider = provider();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const plugin = await createAvalonTerminalPlugin(env, input, undefined, {
      provider: sandboxProvider,
    });

    expect(plugin?.onActivate).toBeTypeOf("function");
    expect(plugin?.activationTimeoutMs).toBe(TERMINAL_PLUGIN_ACTIVATION_BUDGET_MS);
    expect(workstreamObjectGet(objectStore, "SELECT COUNT(*) AS count FROM terminal_workspace"))
      .toEqual({ count: 0 });

    await plugin!.onActivate!({
      workspaceId: W,
      workstreamId: S,
      harnessRunId: R,
      executionPrincipal: { type: "user", userId: U },
      signal: new AbortController().signal,
    });
    await plugin!.onActivate!({
      workspaceId: W,
      workstreamId: S,
      harnessRunId: R,
      executionPrincipal: { type: "user", userId: U },
      signal: new AbortController().signal,
    });

    expect(sandboxProvider.createSandbox).toHaveBeenCalledOnce();
    expect(workstreamObjectGet(
      objectStore,
      "SELECT lifecycle_state, sandbox_id FROM terminal_workspace",
    )).toEqual({ lifecycle_state: "running", sandbox_id: "sandbox-1" });
    const activationEvents = info.mock.calls
      .map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.event === "terminal_plugin_activation_finished");
    expect(activationEvents).toMatchObject([
      {
        activation_attempt: 1,
        tool_call_id: `${R}:plugin:terminal:activation:1`,
      },
      {
        activation_attempt: 2,
        tool_call_id: `${R}:plugin:terminal:activation:2`,
      },
    ]);
    info.mockRestore();
  });

  it("prepares a selected repository during activation", async () => {
    const { database, objectStore, env, input } = fixture("supported");
    selectRepository(database, objectStore);
    const sandboxProvider = provider();
    const githubReadGateway = readGateway();
    const plugin = await createAvalonTerminalPlugin(env, input, undefined, {
      provider: sandboxProvider,
      readGateway: githubReadGateway,
    });

    await plugin!.onActivate!({
      workspaceId: W,
      workstreamId: S,
      harnessRunId: R,
      executionPrincipal: { type: "user", userId: U },
      signal: new AbortController().signal,
    });

    expect(githubReadGateway.mintRepositoryToken).toHaveBeenCalledOnce();
    expect(sandboxProvider.configureGitHubReadAccess).toHaveBeenCalledWith("sandbox-1", {
      gitBasicCredential: btoa("x-access-token:read-token"),
      ghToken: "read-token",
    });
    expect(sandboxProvider.runUtilityCommand).toHaveBeenCalledWith(
      "sandbox-1",
      expect.objectContaining({
        operation: "repository.bootstrap",
        command: expect.stringContaining("clone --no-checkout 'https://github.com/owner/repo.git'"),
        timeoutMs: 180_000,
      }),
    );
    expect(workstreamObjectGet(
      objectStore,
      "SELECT bootstrapped_sandbox_generation FROM terminal_repository",
    )).toEqual({ bootstrapped_sandbox_generation: 1 });
  });

  it("keeps checkout available when selected-repository preparation needs repair", async () => {
    const { database, objectStore, env, input } = fixture("supported");
    selectRepository(database, objectStore);
    const plugin = await createAvalonTerminalPlugin(env, input, undefined, {
      provider: provider(),
      readGateway: readGateway("b".repeat(40)),
    });

    await expect(plugin!.onActivate!({
      workspaceId: W,
      workstreamId: S,
      harnessRunId: R,
      executionPrincipal: { type: "user", userId: U },
      signal: new AbortController().signal,
    })).resolves.toBeUndefined();

    expect(plugin?.tools.map((tool) => tool.definition.name)).toContain("checkout_repository");
    expect(workstreamObjectGet(
      objectStore,
      "SELECT bootstrapped_sandbox_generation FROM terminal_repository",
    )).toEqual({ bootstrapped_sandbox_generation: null });
  });

  it("threads the resident object's Terminal boundaries through plugin setup", async () => {
    const { objectStore, env, input } = fixture("supported");
    const messageId = "30000000-0000-4000-8000-000000000005";
    const connectionId = "30000000-0000-4000-8000-000000000006";
    seedWorkstreamObjectParticipant(objectStore, {
      userId: U,
      participationReason: "creator",
      addedAt: Date.parse("2026-08-13T00:00:00.000Z"),
    });
    workstreamObjectRun(
      objectStore,
      `INSERT INTO messages
         (id, workspace_id, workstream_id, author_type, author_user_id, message_type,
          text_content, sequence_number, created_at)
       VALUES (?, ?, ?, 'human', ?, 'text', 'Use Terminal twice', 1, '2026-08-13')`,
      messageId,
      W,
      S,
      U,
    );
    workstreamObjectRun(
      objectStore,
      `INSERT INTO terminal_repository
         (id, connection_id, repository_id, repository_full_name, base_ref, base_sha,
          head_ref, state, selected_by_user_id, remote_access, created_at, updated_at)
       VALUES (1, ?, 42, 'owner/repo', 'main', ?, 'avalon/resident-agent',
               'selected', ?, 'read_only', ?, ?)`,
      connectionId,
      "a".repeat(40),
      U,
      Date.parse("2026-08-13T00:00:00.000Z"),
      Date.parse("2026-08-13T00:00:00.000Z"),
    );
    workstreamObjectRun(
      objectStore,
      "UPDATE harness_runs SET trigger_message_id = ? WHERE id = ?",
      messageId,
      R,
    );
    input.triggerMessageId = messageId;
    const residentResourceAttacher = vi.fn(async () => undefined);
    // The resident Terminal authority is installed on the environment now,
    // rather than threaded in as a factory: the plugin builds its port from
    // `env` either way and never learns which it got.
    const resident = vi.fn(testTerminalOperationExecutor(objectStore));

    await __integrationTesting.loadHarnessTools(
      withLocalWorkstreamAuthorities(
        withWorkstreamRuntimeDatabase(env, W, S),
        W,
        S,
        { terminal: resident },
      ),
      input,
      undefined,
      residentResourceAttacher,
    );

    expect(resident).toHaveBeenCalled();
    expect(workstreamObjectGet(
      objectStore,
      "SELECT run_id, repository_full_name FROM terminal_publication_grants WHERE run_id = ?",
      R,
    )).toEqual({ run_id: R, repository_full_name: "owner/repo" });
  });

  it("omits Terminal in unsupported regions", async () => {
    const { env, input } = fixture("unsupported");
    const tools = await __integrationTesting.loadHarnessTools(withWorkstreamRuntimeDatabase(env, W, S), input);
    expect(tools.plugins.some((plugin) => plugin.canonicalId === "rally:terminal")).toBe(false);
  });

  it("omits Terminal without crashing when an opted-in development environment is incomplete", async () => {
    const { env, input } = fixture("supported");
    delete env.DAYTONA_API_KEY;
    delete env.DAYTONA_TARGET;
    const tools = await __integrationTesting.loadHarnessTools(withWorkstreamRuntimeDatabase(env, W, S), input);
    expect(tools.plugins.some((plugin) => plugin.canonicalId === "rally:terminal")).toBe(false);
  });

  it("keeps the complete plugin visible while the emergency breaker blocks provider operations", async () => {
    const { env, input } = fixture("supported", true);
    const tools = await __integrationTesting.loadHarnessTools(withWorkstreamRuntimeDatabase(env, W, S), input);
    const plugin = tools.plugins.find((candidate) => candidate.canonicalId === "rally:terminal");
    expect(plugin?.tools).toHaveLength(9);
    await expect(plugin!.onActivate!({
      workspaceId: W, workstreamId: S, harnessRunId: R,
      executionPrincipal: { type: "user", userId: U }, signal: new AbortController().signal,
    })).rejects.toMatchObject({
      name: "HarnessPluginActivationError",
      message: "Wait for an operator to re-enable Terminal before trying another tool.",
      retryable: false,
    });
    await expect(plugin!.tools.find((tool) => tool.definition.name === "read_file")!.execute!(
      { filePath: "README.md" },
      {
        workspaceId: W, workstreamId: S, harnessRunId: R, toolCallId: "breaker-call",
        executionPrincipal: { type: "user", userId: U }, signal: new AbortController().signal,
      },
    )).rejects.toMatchObject({
      code: "sandbox_unavailable",
      details: { reason: "Wait for an operator to re-enable Terminal before trying another tool." },
    });
  });
});
