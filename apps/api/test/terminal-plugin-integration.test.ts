import { agentIdForAddress, asSubstreamId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { asHarnessRunId, asUserId } from "@rally/contracts";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __integrationTesting } from "../src/services/integrations";
import { withLocalWorkstreamAuthorities } from "../src/runtime/local-authorities";
import {
  TERMINAL_PLUGIN_ACTIVATION_BUDGET_MS,
} from "../src/services/terminal/contract";
import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import { compileTerminalNetworkPolicy } from "../src/services/terminal/network-policy";
import { createAvalonTerminalPlugin } from "../src/services/terminal/plugin";
import type { TerminalGitHubReadGateway } from "../src/services/terminal/repository";
import { createTestEnv } from "./helpers/cloudflare-test";
import type { TerminalProviderRpcSession } from "../src/services/terminal/provider-rpc-contract";
import {
  createTestWorkspaceDO,
  workspaceObjectRpcs,
} from "./helpers/workspace-object-rpcs";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import type { DatabaseSync } from "node:sqlite";
import {
  openWorkstreamAuthorityForTest,
  seedWorkstreamObjectRoot,
  seedWorkstreamRun,
  seedCanonicalConversationTurn,
  testSubstreamAgentsBinding,
  testTerminalOperationExecutor,
  testTerminalPortFactory,
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
const objectDatabases: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of openDatabases.splice(0)) database.close();
  for (const database of objectDatabases.splice(0)) database.close();
});

function fixture(
  capability: "supported" | "unsupported",
  emergencyDisabled = false,
  options: {
    /** What WorkspaceDO answers when composition asks who owns an agent. */
    agentOwner?: (input: { workspaceId: string; agentId: string }) => Promise<{ ok: true; value: { agentId: string | null } }>;
  } = {},
) {
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
  seedWorkstreamRun(objectStore, { id: R,
    executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });
  const workspace = createTestWorkspaceDO({
    workspaceId: W, regionalDatabase: database,
    register: (created) => { objectDatabases.push(created); },
  });
  const env = createTestEnv({
    DB: sqliteD1(database), AVALON_REGION: "global",
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
    // The plugin reads the workspace's Terminal egress mode on every turn, and
    // reads it from a real WorkspaceDO: the guidance the model is given should
    // come from the object that decides the policy, not from a fixture's idea
    // of it.
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
      extra: {
        ...workspaceObjectRpcs(workspace.instance, [
          "terminalNetworkMode", "terminalNetworkSettings", "sidekickReadAuthorizationFacts", "sidekickReadExecutionDelegation",
          "resolveConversationToolTarget", "conversationToolScope",
        ]),
        ...(options.agentOwner ? { agentOwner: options.agentOwner } : {}),
      },
    }),
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    TERMINAL_REGION_CAPABILITY: capability,
    DAYTONA_API_KEY: "daytona-key", DAYTONA_API_URL: "https://app.daytona.io/api",
    DAYTONA_TARGET: "us", DAYTONA_TERMINAL_SNAPSHOT: "terminal-snapshot",
    TERMINAL_EMERGENCY_DISABLED: emergencyDisabled ? "true" : "false",
  });
  const input: WorkstreamWorkflowInput = {
    region: "global", workspaceId: W, parentKind: "canvas", parentId: S,
    loopId: `workstream:${S}:substream:0:loop`, harnessRunId: R,
    triggerMessageId: null, activityId: null,
    executionPrincipal: { type: "user", userId: U }, reason: "user_message",
  };
  return { database, objectStore, objectStores, env, input, workspace };
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
    recoverSandbox: vi.fn(async () => undefined),
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
  it("gives a requester's run no Terminal, whose shared files only a delegate's access reaches", async () => {
    const { env, input } = fixture("supported");
    const requester = input.executionPrincipal.type === "user" ? input.executionPrincipal.userId : U;
    const plugin = await createAvalonTerminalPlugin(env, { ...input, parentKind: "automation" }, undefined, {
      provider: provider(), readGateway: readGateway(),
      delegation: { sidekickId: S, creatorUserId: U, accountUserId: U,
        delegates: [{ userId: requester, generation: 0, grantedAt: 1 }], requesterUserId: requester },
    });
    expect(plugin).toBeNull();
  });

  it.each([false, true])("shares Sidekick files and observes withdrawal on inventory refresh (personal repository %s)", async (personalRepository) => {
    const { database, objectStore, objectStores, env, input, workspace } = fixture("supported");
    if (personalRepository) {
      selectRepository(database, objectStore);
      database.prepare("UPDATE connector_connections SET scope = 'personal', owner_user_id = ? WHERE id = ?").run(U, CONNECTION);
    }
    await workspace.instance.applyMemberStatus({ workspaceId: W, sequence: 1, removed: false, relationship: {
      workspaceId: W, userId: U, accessClass: "member", role: "owner", status: "active", incarnation: "test-member", revision: 1,
    } });
    await workspace.instance.sidekickCreate({
      workspaceId: W, automationId: S, authorUserId: U, scope: "workspace",
      authorityGeneration: 1
    });
    const consent = async (userId: typeof U, allowed: boolean) => {
      const request = { workspaceId: W, automationId: S, userId, allowed, operationId: crypto.randomUUID() };
      const prepared = await workspace.instance.sidekickPrepareMyDelegation(request);
      return workspace.instance.sidekickSetDelegation({ ...request, expectedGeneration: prepared.generation, source: "self_service" });
    };
    const sandboxProvider = provider();
    vi.mocked(sandboxProvider.runUtilityCommand).mockImplementation(async (_id, request) => ({
      exitCode: 0,
      stdout: request.operation === "file.read_page" ? JSON.stringify({
        content: "shared site", startLine: 1, endLine: 1, totalLines: 1, truncated: false,
      }) : "0\n",
      stderr: "",
    }));
    const gateway = readGateway();
    const plugin = await createAvalonTerminalPlugin(env, { ...input, parentKind: "automation" }, undefined, {
      provider: sandboxProvider, readGateway: gateway,
    });
    expect(plugin?.systemMessage).toContain("Activations can overlap");
    const read = plugin!.tools.find((tool) => tool.definition.name === "read_file")!.execute!;
    const toolContext = { workspaceId: W, workstreamId: S, harnessRunId: R,
      toolCallId: "wizard-read", executionPrincipal: input.executionPrincipal,
      signal: new AbortController().signal };
    await expect(read({ filePath: "site/index.html" }, toolContext))
      .resolves.toMatchObject({ output: { content: "shared site" } });
    // The completed import's source is no longer readable. Its bytes are
    // already part of shared Sidekick state, so later delegates retain them.
    await testTerminalPortFactory(objectStore)(W, S).recordImportedResource({
      sandboxGeneration: 1, resourceId: "30000000-0000-4000-8000-000000000098",
      destinationPath: "/workspace/site/index.html", sourceSha256: "a".repeat(64),
      sizeBytes: 11, state: "completed", importedAt: 1, now: 1,
    });
    const runAsUser = asUserId("30000000-0000-4000-8000-000000000099");
    // Directory management rights alone grant no Terminal access.
    await expect(read({ filePath: "site/index.html" }, { ...toolContext, toolCallId: "unconsented-editor",
      executionPrincipal: { type: "user", userId: runAsUser },
    })).rejects.toMatchObject({ code: "sandbox_authority_mismatch" });
    expect(sandboxProvider.deleteSandbox).not.toHaveBeenCalled();

    await workspace.instance.applyMemberStatus({ workspaceId: W, sequence: 2, removed: false, relationship: {
      workspaceId: W, userId: runAsUser, accessClass: "member", role: "member", status: "active", incarnation: "new-executor", revision: 1,
    } });
    await consent(runAsUser, true);
    await consent(U, false);
    // Eventual authz permits the existing snapshot to finish its work.
    await expect(read({ filePath: "site/index.html" }, { ...toolContext, toolCallId: "stale-snapshot-read" }))
      .resolves.toMatchObject({ output: { content: "shared site" } });
    const child = asSubstreamId("30000000-0000-4000-8000-000000000088");
    const childRun = asHarnessRunId("30000000-0000-4000-8000-000000000089");
    const childStore = testWorkstreamObjectStore();
    openDatabases.push(childStore);
    seedWorkstreamObjectRoot(childStore, { workstreamId: S, workspaceId: W });
    seedWorkstreamRun(childStore, { id: childRun,
      executionPrincipalJson: JSON.stringify({ type: "user", userId: runAsUser }) });
    objectStores.set(`${S}:${child}`, childStore);
    const activation = await createAvalonTerminalPlugin(env, { ...input, parentKind: "automation",
      substreamId: child, harnessRunId: childRun, executionPrincipal: { type: "user", userId: runAsUser },
    }, undefined, { provider: sandboxProvider, readGateway: gateway });
    await expect(activation!.tools.find((tool) => tool.definition.name === "read_file")!.execute!(
      { filePath: "site/index.html" }, { ...toolContext, toolCallId: "activation-read",
        harnessRunId: childRun, executionPrincipal: { type: "user", userId: runAsUser } },
    )).resolves.toMatchObject({ output: { content: "shared site" } });
    if (personalRepository) {
      expect(gateway.mintRepositoryToken).toHaveBeenCalledTimes(1);
      await expect(activation!.tools.find((tool) => tool.definition.name === "publish_branch_and_pr")!.execute!(
        { title: "Ship", body: "Update" }, { ...toolContext, harnessRunId: childRun,
          toolCallId: "publish-after-withdrawal", effectIntentId: crypto.randomUUID(), executionPrincipal: { type: "user", userId: runAsUser } },
      )).rejects.toMatchObject({ code: "repository_delegate_unavailable" });
    }
    // A refreshed inventory blocks the withdrawn caller, while an independent
    // eligible activation retains the original files.
    const laterWizard = await createAvalonTerminalPlugin(env, { ...input, parentKind: "automation" }, undefined, {
      provider: sandboxProvider,
    });
    await expect(laterWizard!.tools.find((tool) => tool.definition.name === "read_file")!.execute!(
        { filePath: "site/index.html" }, { ...toolContext, toolCallId: "later-editor" },
    )).rejects.toMatchObject({ code: "sandbox_authority_mismatch" });
    expect(sandboxProvider.deleteSandbox).not.toHaveBeenCalled();
    expect(sandboxProvider.createSandbox).toHaveBeenCalledTimes(1);
    expect(workstreamObjectGet(objectStore, "SELECT generation, sandbox_id FROM terminal_workspace"))
      .toEqual({ generation: 1, sandbox_id: "sandbox-1" });
  });

  it("lets the creator read shared files through the assembled Sidekick authoring inventory", async () => {
    const { env, input, workspace } = fixture("supported");
    await workspace.instance.applyMemberStatus({ workspaceId: W, sequence: 1, removed: false, relationship: {
      workspaceId: W, userId: U, accessClass: "member", role: "owner", status: "active", incarnation: "test-member", revision: 1,
    } });
    await workspace.instance.sidekickCreate({ workspaceId: W, automationId: S, authorUserId: U,
      scope: "workspace", authorityGeneration: 1 });
    const snapshot = { id: "wizard-sandbox", name: "wizard-sandbox", state: "running" as const, domainAllowList: [] as string[] };
    // Only the external sandbox provider is doubled; inventory assembly,
    // delegation, shared-file authority and Terminal execution remain real.
    const unexpected = async (): Promise<never> => { throw new Error("Unexpected sandbox provider call"); };
    const session: TerminalProviderRpcSession = {
      createSandbox: async (request) => ({ ok: true, value: { ...snapshot, name: request.stableName, domainAllowList: request.domainAllowList } }),
      prepareSandbox: async (_id, allowList) => ({ ok: true, value: { ...snapshot, domainAllowList: allowList } }),
      runUtilityCommand: async (_id, request) => ({ ok: true, value: { exitCode: 0, stderr: "",
        stdout: request.operation === "file.read_page" ? JSON.stringify({ content: "Wizard setup works", startLine: 1, endLine: 1,
          totalLines: 1, truncated: false }) : "0\n" } }),
      getSandbox: unexpected, recoverSandbox: unexpected, startSandbox: unexpected,
      stopSandbox: unexpected, archiveSandbox: unexpected, deleteSandbox: unexpected,
      updateNetworkPolicy: unexpected, configureGitHubReadAccess: unexpected, clearGitHubReadAccess: unexpected,
      readFile: unexpected, writeFile: unexpected, runCommand: unexpected, cleanupCommand: unexpected,
    };
    const tools = await __integrationTesting.loadHarnessTools(createTestEnv({ ...env,
      TERMINAL_PROVIDER: { createSession: async () => session },
    }), { ...input, parentKind: "automation" });
    const terminal = tools.plugins.find((plugin) => plugin.canonicalId === "rally:terminal")!;
    await expect(terminal.tools.find((tool) => tool.definition.name === "read_file")!.execute!({ filePath: "README.md" }, {
      workspaceId: W, workstreamId: S, harnessRunId: R, toolCallId: "assembled-wizard-read",
      executionPrincipal: input.executionPrincipal, signal: new AbortController().signal,
    })).resolves.toMatchObject({ output: { content: "Wizard setup works" } });
  });

  it("registers the complete deferred plugin without allocating a sandbox", async () => {
    const { objectStore, env, input } = fixture("supported");
    const tools = await __integrationTesting.loadHarnessTools(env, input);
    const plugin = tools.plugins.find((candidate) => candidate.canonicalId === "rally:terminal");

    expect(plugin).toMatchObject({ preload: false, explicit: false, shortWireName: "" });
    expect(plugin?.systemMessage).not.toContain("Sidekick's wizard");
    expect(plugin?.tools.map((tool) => tool.definition.name)).toEqual([
      "read_file", "view_image", "edit_file", "write_file", "apply_patch", "run_command",
      "checkout_repository", "import_resource", "publish_resource", "publish_branch_and_pr",
    ]);
    expect(workstreamObjectGet(objectStore, "SELECT COUNT(*) AS count FROM terminal_workspace")).toEqual({ count: 0 });
  });

  it("keeps the run's other tools when its Terminal authority cannot be resolved", async () => {
    const worker = "30000000-0000-4000-8000-000000000077";
    const otherWorkstream = "30000000-0000-4000-8000-000000000099";
    // The agent's owner is under another work stream: a routing defect the
    // resolver refuses. The refusal takes Terminal away, named, and nothing else.
    const { env, input } = fixture("supported", false, {
      agentOwner: async ({ agentId }) => ({ ok: true, value: {
        agentId: agentId === agentIdForAddress({ parentKind: "canvas", parentId: S, substreamId: asSubstreamId(worker) })
          ? agentIdForAddress({ parentKind: "canvas", parentId: otherWorkstream, substreamId: asSubstreamId("0") })
          : null,
      } }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(createAvalonTerminalPlugin(
      env,
      { ...input, substreamId: asSubstreamId(worker), backgroundAgent: true, loopId: `workstream:${S}:substream:${worker}:loop` },
      undefined,
      { provider: provider() },
    )).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "terminal_authority_unresolved",
      harness_run_id: R,
      substream_id: worker,
      reason: "terminal_authority_parent_mismatch",
    }));
    warn.mockRestore();
  });

  it("gives a background agent its owner's sandbox, in the owner's object", async () => {
    const worker = "30000000-0000-4000-8000-000000000077";
    const { objectStore, objectStores, env, input } = fixture("supported", false, {
      agentOwner: async ({ agentId }) => ({ ok: true, value: {
        // The worker is owned by the main conversation; the main conversation by nobody.
        agentId: agentId === agentIdForAddress({ parentKind: "canvas", parentId: S, substreamId: asSubstreamId(worker) })
          ? agentIdForAddress({ parentKind: "canvas", parentId: S, substreamId: asSubstreamId("0") })
          : null,
      } }),
    });
    // The agent's conversation is its own object, where its run lives.
    const workerStore = testWorkstreamObjectStore();
    openDatabases.push(workerStore);
    seedWorkstreamObjectRoot(workerStore, { workstreamId: S, workspaceId: W });
    seedWorkstreamRun(workerStore, { id: R, executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });
    objectStores.set(`${S}:${worker}`, workerStore);
    const sandboxProvider = provider();
    const plugin = await createAvalonTerminalPlugin(
      env,
      { ...input, substreamId: asSubstreamId(worker), backgroundAgent: true, loopId: `workstream:${S}:substream:${worker}:loop` },
      undefined,
      { provider: sandboxProvider },
    );
    await plugin!.onActivate!({
      workspaceId: W,
      workstreamId: S,
      harnessRunId: R,
      executionPrincipal: { type: "user", userId: U },
      signal: new AbortController().signal,
    });

    await vi.waitFor(() => expect(sandboxProvider.createSandbox).toHaveBeenCalledOnce(), { timeout: 5_000 });
    // The owner's row, under the owner's name, held by the worker's run from its own conversation.
    expect(vi.mocked(sandboxProvider.createSandbox).mock.calls[0]![0].substreamId).toBe("0");
    expect(workstreamObjectGet(objectStore, "SELECT COUNT(*) AS count FROM terminal_workspace")).toEqual({ count: 1 });
    expect(workstreamObjectGet(workerStore, "SELECT COUNT(*) AS count FROM terminal_workspace")).toEqual({ count: 0 });
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

    // Activation no longer waits for the sandbox, so the provider work and its
    // completion log land after `onActivate` has already returned.
    await vi.waitFor(() => {
      expect(sandboxProvider.createSandbox).toHaveBeenCalledOnce();
      expect(workstreamObjectGet(
        objectStore,
        "SELECT lifecycle_state, sandbox_id FROM terminal_workspace",
      )).toEqual({ lifecycle_state: "running", sandbox_id: "sandbox-1" });
      // By attempt, not by arrival: the second activation joins the first's
      // readiness and can settle first, since the first is the one that gives
      // the lease back afterwards.
      const activationEvents = info.mock.calls
        .map(([entry]) => entry as Record<string, unknown>)
        .filter((entry) => entry.event === "terminal_plugin_activation_finished")
        .sort((left, right) => Number(left.activation_attempt) - Number(right.activation_attempt));
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
    }, { timeout: 5_000 });
    info.mockRestore();
  });

  it("pairs a started row with a finished row so an abandoned activation is visible", async () => {
    // Activation no longer awaits its own work, so the runtime decides whether
    // that work survives to settle — and a cancelled continuation cannot log its
    // own death. The pair is the only way to see it: a started row with no
    // finished row for the same tool_call_id is an activation that vanished.
    const { env, input } = fixture("supported");
    const sandboxProvider = provider();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const plugin = await createAvalonTerminalPlugin(env, input, undefined, {
      provider: sandboxProvider,
    });

    await plugin!.onActivate!({
      workspaceId: W,
      workstreamId: S,
      harnessRunId: R,
      executionPrincipal: { type: "user", userId: U },
      signal: new AbortController().signal,
    });

    const rows = (): Record<string, unknown>[] => info.mock.calls
      .map(([entry]) => entry as Record<string, unknown>);
    // The started row is written before activation hands back, so it is already
    // there even though the sandbox is not.
    expect(rows().filter((row) => row.event === "terminal_plugin_activation_started"))
      .toMatchObject([{ tool_call_id: `${R}:plugin:terminal:activation:1` }]);

    await vi.waitFor(() => {
      expect(rows().filter((row) => row.event === "terminal_plugin_activation_finished"))
        .toMatchObject([{ tool_call_id: `${R}:plugin:terminal:activation:1`, state: "completed" }]);
    }, { timeout: 5_000 });
    info.mockRestore();
  });

  it("returns from activation while the sandbox is still being provisioned", async () => {
    // The whole point of the change: the model is not held behind provisioning.
    // Gate the provider call so the assertion cannot pass by the acquisition
    // simply having been fast.
    const { env, input } = fixture("supported");
    const sandboxProvider = provider();
    let releaseCreate = (): void => undefined;
    const created = new Promise<void>((resolve) => { releaseCreate = () => resolve(); });
    vi.mocked(sandboxProvider.createSandbox).mockImplementation(async (request) => {
      await created;
      return {
        id: `sandbox-${request.generation}`,
        name: request.stableName,
        state: "running" as const,
        domainAllowList: request.domainAllowList,
      };
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const plugin = await createAvalonTerminalPlugin(env, input, undefined, {
      provider: sandboxProvider,
    });

    await expect(plugin!.onActivate!({
      workspaceId: W,
      workstreamId: S,
      harnessRunId: R,
      executionPrincipal: { type: "user", userId: U },
      signal: new AbortController().signal,
    })).resolves.toBeUndefined();

    releaseCreate();
    // Wait for the activation to settle, not merely for the provider call: the
    // fixture's databases close in afterEach, and a continuation still running
    // then would fail underneath the next test rather than this one.
    await vi.waitFor(() => {
      expect(sandboxProvider.createSandbox).toHaveBeenCalledOnce();
      expect(info.mock.calls.map(([entry]) => entry as Record<string, unknown>)
        .filter((entry) => entry.event === "terminal_plugin_activation_finished"))
        .toMatchObject([{ state: "completed" }]);
    }, { timeout: 5_000 });
  });

  it("prepares a selected repository during activation", async () => {
    const { database, objectStore, env, input } = fixture("supported");
    selectRepository(database, objectStore);
    const sandboxProvider = provider();
    vi.mocked(sandboxProvider.runUtilityCommand).mockImplementation(async (_id, request) => {
      if (request.operation === "file.inspect") {
        return { exitCode: 0, stdout: "0\n", stderr: "" };
      }
      if (request.operation === "file.read_page") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            content: "",
            startLine: 1,
            endLine: 0,
            totalLines: 0,
            truncated: false,
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
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

    // Repository preparation still happens under activation, but activation no
    // longer waits for it, so it lands after `onActivate` has returned.
    await vi.waitFor(() => {
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
    }, { timeout: 5_000 });

    await expect(plugin!.tools.find((tool) => tool.definition.name === "read_file")!.execute!(
      { filePath: "README.md", offset: 1, limit: 200 },
      {
        workspaceId: W,
        workstreamId: S,
        harnessRunId: R,
        toolCallId: "first-tool-after-activation",
        executionPrincipal: { type: "user", userId: U },
        signal: new AbortController().signal,
      },
    )).resolves.toMatchObject({ output: { content: "" } });
    expect(vi.mocked(sandboxProvider.runUtilityCommand).mock.calls
      .filter(([, request]) => request.operation === "repository.bootstrap"))
      .toHaveLength(1);
    expect(githubReadGateway.mintRepositoryToken).toHaveBeenCalledOnce();
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

  it("revalidates revoked repository access before an ordinary tool can reuse the sandbox", async () => {
    const { database, objectStore, env, input } = fixture("supported");
    selectRepository(database, objectStore);
    database.exec(`UPDATE connector_connections SET status = 'disabled' WHERE id = '${CONNECTION}'`);
    const sandboxProvider = provider();
    const plugin = await createAvalonTerminalPlugin(env, input, undefined, {
      provider: sandboxProvider,
      readGateway: readGateway(),
    });

    await expect(plugin!.onActivate!({
      workspaceId: W,
      workstreamId: S,
      harnessRunId: R,
      executionPrincipal: { type: "user", userId: U },
      signal: new AbortController().signal,
    })).resolves.toBeUndefined();
    expect(plugin?.tools.map((tool) => tool.definition.name)).toContain("checkout_repository");

    await expect(plugin!.tools.find((tool) => tool.definition.name === "read_file")!.execute!(
      { filePath: "README.md", offset: 1, limit: 200 },
      {
        workspaceId: W,
        workstreamId: S,
        harnessRunId: R,
        toolCallId: "read-after-revocation",
        executionPrincipal: { type: "user", userId: U },
        signal: new AbortController().signal,
      },
    )).rejects.toMatchObject({ code: "repository_access_revoked" });
    expect(sandboxProvider.createSandbox).toHaveBeenCalledOnce();
    expect(sandboxProvider.runUtilityCommand).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ operation: "file.inspect" }),
    );
  });

  it("rejects a tool already waiting on the activation's acquisition when repository access was revoked", async () => {
    // The acquisition is shared: activation registers it and the next Terminal
    // tool awaits the same promise. Evicting the cache after preparation fails
    // never reaches a waiter already holding that promise — it would proceed
    // with a sandbox whose repository authorization is gone — so preparation
    // rejects the promise itself. Sandbox creation is parked so the tool is in
    // flight before the rejection happens; with eviction it would start a
    // second acquisition instead.
    const { database, objectStore, env, input } = fixture("supported");
    selectRepository(database, objectStore);
    database.exec(`UPDATE connector_connections SET status = 'disabled' WHERE id = '${CONNECTION}'`);
    const sandboxProvider = provider();
    let releaseCreate = (): void => undefined;
    const created = new Promise<void>((resolve) => { releaseCreate = () => resolve(); });
    vi.mocked(sandboxProvider.createSandbox).mockImplementation(async (request) => {
      await created;
      return {
        id: `sandbox-${request.generation}`,
        name: request.stableName,
        state: "running" as const,
        domainAllowList: request.domainAllowList,
      };
    });
    const plugin = await createAvalonTerminalPlugin(env, input, undefined, {
      provider: sandboxProvider,
      readGateway: readGateway(),
    });

    await plugin!.onActivate!({
      workspaceId: W, workstreamId: S, harnessRunId: R,
      executionPrincipal: { type: "user", userId: U }, signal: new AbortController().signal,
    });
    const waiting = plugin!.tools.find((tool) => tool.definition.name === "read_file")!.execute!(
      { filePath: "README.md", offset: 1, limit: 200 },
      {
        workspaceId: W, workstreamId: S, harnessRunId: R, toolCallId: "read-while-provisioning",
        executionPrincipal: { type: "user", userId: U }, signal: new AbortController().signal,
      },
    );
    await vi.waitFor(() => expect(sandboxProvider.createSandbox).toHaveBeenCalledOnce(), { timeout: 5_000 });
    releaseCreate();

    await expect(waiting).rejects.toMatchObject({ code: "repository_access_revoked" });
    expect(sandboxProvider.createSandbox).toHaveBeenCalledOnce();
    expect(sandboxProvider.runUtilityCommand).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ operation: "file.inspect" }),
    );
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
    seedCanonicalConversationTurn(objectStore, {
      turnId: messageId,
      clientMessageId: messageId,
      actor: "human",
      authorUserId: U,
      authorSnapshot: { displayName: "Terminal user", avatarUrl: null },
      text: "Use Terminal twice",
      transcriptSequence: 1,
      createdAt: "2026-08-13",
    });
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
      "UPDATE runs SET trigger_part_id = ? WHERE run_id = ?",
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
        env,
        W,
        S,
        "0",
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
    const tools = await __integrationTesting.loadHarnessTools(env, input);
    expect(tools.plugins.some((plugin) => plugin.canonicalId === "rally:terminal")).toBe(false);
  });

  it("omits Terminal without crashing when an opted-in development environment is incomplete", async () => {
    const { env, input } = fixture("supported");
    delete env.DAYTONA_API_KEY;
    delete env.DAYTONA_TARGET;
    const tools = await __integrationTesting.loadHarnessTools(env, input);
    expect(tools.plugins.some((plugin) => plugin.canonicalId === "rally:terminal")).toBe(false);
  });

  it("keeps the complete plugin visible while the emergency breaker blocks provider operations", async () => {
    const { env, input } = fixture("supported", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tools = await __integrationTesting.loadHarnessTools(env, input);
    const plugin = tools.plugins.find((candidate) => candidate.canonicalId === "rally:terminal");
    expect(plugin?.tools).toHaveLength(10);
    // Activation stopped blocking the model, so it also stopped being the place
    // a provider failure is raised. The breaker now surfaces on the first tool
    // that actually needs a sandbox, with the same operator guidance, while the
    // plugin stays loaded so unrelated work in the same turn is unaffected.
    await expect(plugin!.onActivate!({
      workspaceId: W, workstreamId: S, harnessRunId: R,
      executionPrincipal: { type: "user", userId: U }, signal: new AbortController().signal,
    })).resolves.toBeUndefined();
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
    // The background acquisition that activation started fails the same way,
    // and its only record is the finished row at warn: nothing reaches the
    // model from here, and nothing posts to operators.
    await vi.waitFor(() => {
      expect(warn.mock.calls.map(([entry]) => entry as Record<string, unknown>)
        .filter((entry) => entry.event === "terminal_plugin_activation_finished"))
        .toMatchObject([{ state: "failed", code: "sandbox_unavailable" }]);
    }, { timeout: 5_000 });
  });
});
