import type { WorkstreamWorkflowInput } from "@avalon/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __integrationTesting } from "../src/services/integrations";
import { compileTerminalNetworkPolicy } from "../src/services/terminal/network-policy";
import { createAvalonTerminalPlugin } from "../src/services/terminal/plugin";
import { TERMINAL_PLUGIN_ACTIVATION_BUDGET_MS } from "../src/services/terminal/contract";
import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import type { TerminalGitHubReadGateway } from "../src/services/terminal/repository";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const W = "30000000-0000-4000-8000-000000000001";
const S = "30000000-0000-4000-8000-000000000002";
const R = "30000000-0000-4000-8000-000000000003";
const U = "30000000-0000-4000-8000-000000000004";
const CONNECTION = "30000000-0000-4000-8000-000000000005";
const BASE = "a".repeat(40);
const HEAD_REF = "avalon/workstream-30000000";

const openDatabases: ReturnType<typeof migratedSqliteDatabase>[] = [];
afterEach(() => { for (const database of openDatabases.splice(0)) database.close(); });

function fixture(capability: "supported" | "unsupported", emergencyDisabled = false) {
  const database = migratedSqliteDatabase();
  openDatabases.push(database);
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
    INSERT INTO harness_runs
      (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
    VALUES ('${R}', '${W}', '${S}', 'test', '{"type":"user","userId":"${U}"}', 'running', '2026-08-13');
  `);
  const env = createTestEnv({
    DB: sqliteD1(database), AVALON_REGION: "global",
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
  return { database, env, input };
}

function provider(): TerminalSandboxProvider {
  return {
    createSandbox: vi.fn(async (input) => ({
      id: `sandbox-${input.generation}`,
      name: input.stableName,
      state: "running" as const,
      domainAllowList: input.domainAllowList,
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
    runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    publishGitBundle: vi.fn(async (input) => ({ publishedSha: input.headSha })),
  };
}

function selectRepository(database: ReturnType<typeof migratedSqliteDatabase>): void {
  database.exec(`
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
       display_name, granted_scopes_json, model_plugin_id, status, config_json, created_at, updated_at)
    VALUES ('${CONNECTION}', '${W}', 'github', 'workspace', NULL, '123', 'GitHub',
            '["github.contents.read","github.pull_requests.read"]', 'plugin_github', 'healthy',
            '{"githubRepositoryAccess":{"version":1,"revision":1,"mode":"all_repositories","defaultAccess":"full_access","repositories":[]}}',
            '2026-08-13', '2026-08-13');
    INSERT INTO workstream_terminal_repositories
      (workspace_id, workstream_id, connection_id, repository_id, repository_full_name, base_ref,
       base_sha, head_ref, state, selected_by_user_id, created_at, updated_at)
    VALUES ('${W}', '${S}', '${CONNECTION}', 42, 'owner/repo', 'main', '${BASE}', '${HEAD_REF}',
            'selected', '${U}', '2026-08-13', '2026-08-13');
  `);
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
  it("registers the complete deferred plugin without allocating before activation", async () => {
    const { database, env, input } = fixture("supported");
    const tools = await __integrationTesting.loadHarnessTools(env, input);
    const plugin = tools.plugins.find((candidate) => candidate.canonicalId === "avalon:terminal");

    expect(plugin).toMatchObject({ preload: false, explicit: false, shortWireName: "terminal" });
    expect(plugin?.tools.map((tool) => tool.definition.name)).toEqual([
      "read_file", "edit_file", "write_file", "apply_patch", "run_command",
      "checkout_repository", "import_resource", "publish_resource", "publish_branch_and_pr",
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstream_sandboxes").get()).toEqual({ count: 0 });
  });

  it("starts the sandbox when Terminal activates, before any Terminal tool executes", async () => {
    const { database, env, input } = fixture("supported");
    const sandboxProvider = provider();
    const plugin = await createAvalonTerminalPlugin(env, input, { provider: sandboxProvider });

    expect(plugin?.onActivate).toBeTypeOf("function");
    expect(plugin?.activationTimeoutMs).toBe(TERMINAL_PLUGIN_ACTIVATION_BUDGET_MS);
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstream_sandboxes").get()).toEqual({ count: 0 });

    await plugin!.onActivate!({
      workspaceId: W,
      workstreamId: S,
      harnessRunId: R,
      executionPrincipal: { type: "user", userId: U },
      signal: new AbortController().signal,
    });

    expect(sandboxProvider.createSandbox).toHaveBeenCalledOnce();
    expect(database.prepare(
      "SELECT state, provider_sandbox_id FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?",
    ).get(W, S)).toEqual({ state: "running", provider_sandbox_id: "sandbox-1" });
  });

  it("prepares a selected repository during activation", async () => {
    const { database, env, input } = fixture("supported");
    selectRepository(database);
    const sandboxProvider = provider();
    const githubReadGateway = readGateway();
    const plugin = await createAvalonTerminalPlugin(env, input, {
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
    expect(sandboxProvider.runCommand).toHaveBeenCalledWith("sandbox-1", expect.objectContaining({
      command: expect.stringContaining("clone --no-checkout 'https://github.com/owner/repo.git'"),
      timeoutMs: 180_000,
    }));
    expect(database.prepare(
      "SELECT bootstrapped_sandbox_generation FROM workstream_terminal_repositories WHERE workspace_id = ? AND workstream_id = ?",
    ).get(W, S)).toEqual({ bootstrapped_sandbox_generation: 1 });
  });

  it("keeps checkout available when selected-repository preparation needs repair", async () => {
    const { database, env, input } = fixture("supported");
    selectRepository(database);
    const plugin = await createAvalonTerminalPlugin(env, input, {
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
    expect(database.prepare(
      "SELECT bootstrapped_sandbox_generation FROM workstream_terminal_repositories WHERE workspace_id = ? AND workstream_id = ?",
    ).get(W, S)).toEqual({ bootstrapped_sandbox_generation: null });
  });

  it("omits Terminal in unsupported regions", async () => {
    const { env, input } = fixture("unsupported");
    const tools = await __integrationTesting.loadHarnessTools(env, input);
    expect(tools.plugins.some((plugin) => plugin.canonicalId === "avalon:terminal")).toBe(false);
  });

  it("omits Terminal without crashing when an opted-in development environment is incomplete", async () => {
    const { env, input } = fixture("supported");
    delete env.DAYTONA_API_KEY;
    delete env.DAYTONA_TARGET;
    const tools = await __integrationTesting.loadHarnessTools(env, input);
    expect(tools.plugins.some((plugin) => plugin.canonicalId === "avalon:terminal")).toBe(false);
  });

  it("keeps the complete plugin visible while the emergency breaker blocks provider operations", async () => {
    const { env, input } = fixture("supported", true);
    const tools = await __integrationTesting.loadHarnessTools(env, input);
    const plugin = tools.plugins.find((candidate) => candidate.canonicalId === "avalon:terminal");
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
