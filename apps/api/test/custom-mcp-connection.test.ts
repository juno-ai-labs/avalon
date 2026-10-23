import { asHarnessRunId, asUserId, asWorkspaceId, asWorkstreamId, type AutomationDraft, type WorkstreamWorkflowInput } from "@rally/contracts";
import { executeAutomationCreatorDiscoveryTool, runHarness } from "@rally/agent-harness";
import { providerRequestView, responsesStreamResponse } from "@rally/agent-harness/test-support/responses-stream";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthContext, Env } from "../src/env";
import { decryptString } from "../src/lib/crypto";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import { ConnectionService } from "../src/services/connection-service";
import { __integrationTesting } from "../src/services/integrations";
import { testSubstreamAgentsBinding, testWorkstreamObjectStore } from "./helpers/durable-authority";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestWorkspaceDO, workspaceObjectRpcs } from "./helpers/workspace-object-rpcs";

const USER_ID = asUserId("00000000-0000-4000-8000-000000000001");
const MEMBER_ID = asUserId("00000000-0000-4000-8000-000000000003");
const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000002");
const CREDENTIAL_KEY = "custom-mcp-connection-test-key";
const SERVER_URL = "https://mcp.example.test/mcp";

const READ_TOOL = {
  name: "search_docs",
  description: "Search the corpus",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  annotations: { readOnlyHint: true },
};
const WRITE_TOOL = {
  name: "publish_doc",
  description: "Publish a document",
  inputSchema: { type: "object" },
};

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("custom MCP connections", () => {
  it("edits a saved legacy MCP recommendation through the current catalog ID", async () => {
    const { auth, env, stub, workspace } = fixture();
    stubMcpServer([READ_TOOL]);
    await new ConnectionService(env, auth).createCustomMcp({
      displayName: "Rally Engineering", scope: "workspace", serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" }, toolPolicy: "all_tools",
    });
    const input = { ...catalogWorkflowInput(), parentKind: "automation" as const };
    await workspace.instance.sidekickCreate({ workspaceId: WORKSPACE_ID, automationId: input.parentId,
      authorUserId: USER_ID, scope: "personal", owningWorkstreamId: null, authorityGeneration: 1,
      creatorConsent: { requestId: crypto.randomUUID() } });
    const saved: AutomationDraft = {
      definitionVersion: 2, name: "Engineering", description: "Inspect Rally", overview: "Inspect Rally",
      instructions: "Inspect the selected Thread.", triggers: [{ type: "manual" }], requiredCapabilities: [],
      expectedOutputs: [], defaultBehavior: {}, memoryTables: [], suggestedScope: "personal",
      followUpQuestion: null, elicitation: null, ready: true,
      recommendedPlugins: [{ pluginId: "plugin_custom_mcp", recommendedTools: [], reason: "Inspect Rally" }],
    };
    // Definition RPCs are doubled; connections and delegation execute against
    // the real WorkspaceDO schema. Inference is not needed for this edit.
    const saveDefinition = vi.fn(async () => ({ definitionRevision: 4 }));
    Object.assign(stub, {
      sidekickReadDetails: async () => [{
        id: input.parentId, name: saved.name, description: saved.description, scope: "personal",
        status: "active", lifecycle: "active", nextRunAt: null, lastRunAt: null,
        updatedAt: "2026-10-22T00:00:00.000Z", currentDefinition: saved,
        currentDefinitionRevision: 3, acceptedDefinitionRevision: 3, authorUserId: USER_ID,
        runAsUserId: USER_ID, connectorBindings: {}, recentRuns: [],
      }],
      sidekickSaveDefinition: saveDefinition,
    });
    const runtimeEnv = withWorkspaceRuntimeDatabase(createTestEnv({ ...env,
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(testWorkstreamObjectStore()),
    }), WORKSPACE_ID);
    const selected = await __integrationTesting.loadHarnessTools(runtimeEnv, input);
    const authoring = selected.plugins.find((plugin) => plugin.canonicalId === "rally:sidekicks")!;
    const tool = (name: string) => authoring.tools.find((candidate) => candidate.definition.name === name)!;
    const listed = await tool("sidekicks_list").execute({}, { toolCallId: "read-saved" } as never);
    const draft = (listed.output as { sidekicks: Array<{ currentDefinition: AutomationDraft }> }).sidekicks[0]!.currentDefinition;
    expect(draft.recommendedPlugins).toEqual([
      { pluginId: "plugin_mcp_rally_engineering_1", recommendedTools: [], reason: "Inspect Rally" },
    ]);
    expect(saved.recommendedPlugins[0]!.pluginId).toBe("plugin_custom_mcp");
    const engineering = selected.plugins.find((plugin) => plugin.connectorType === "custom_mcp")!;
    await engineering.loadTools!();
    __integrationTesting.recordCredentialPluginActivation(engineering.canonicalId, selected.frozenConnections,
      new Set(), selected.loadedAutomationPluginIds);
    await tool("plugin_inspect").execute({ pluginId: "plugin_mcp_rally_engineering_1" }, { toolCallId: "inspect" } as never);
    await expect(tool("submit_draft").execute({ ...draft, instructions: "Inspect the selected Thread and summarize it.",
      icon: "file-text", color: "blue", sidekickId: input.parentId }, { toolCallId: "edit" } as never))
      .resolves.toMatchObject({ output: { accepted: true } });
    expect(saveDefinition).toHaveBeenCalledWith(expect.objectContaining({ draft: expect.objectContaining({
      recommendedPlugins: [{ pluginId: "plugin_mcp_rally_engineering_1", recommendedTools: [], reason: "Inspect Rally" }],
    }) }));
  });

  it.each([false, true])("puts fresh server instructions in the model's system prompt (restored=%s)", async (restored) => {
    const { auth, database, env } = fixture();
    const server: { description?: string; instructions?: string } = {
      description: "Inspect deployment logs", instructions: "Old account guidance.",
    };
    stubMcpServer([READ_TOOL], [], server);
    const { connection } = await new ConnectionService(env, auth).createCustomMcp({
      displayName: "Engineering", scope: "workspace", serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" }, toolPolicy: "all_tools",
    });
    expect(JSON.parse(String(database.prepare("SELECT config_json FROM connector_connections WHERE id = ?").get(connection.id)!.config_json)))
      .toMatchObject({ mcpServerMetadata: { description: "Inspect deployment logs", instructions: "Old account guidance." } });
    const input = catalogWorkflowInput();
    const runtimeEnv = withWorkspaceRuntimeDatabase(createTestEnv({ ...env,
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(testWorkstreamObjectStore()),
    }), WORKSPACE_ID);
    const selected = await __integrationTesting.loadHarnessTools(runtimeEnv, input);
    const plugin = selected.plugins.find((candidate) => candidate.connectorType === "custom_mcp")!;
    expect(plugin.description).toBe("Inspect deployment logs");
    // The server can update its instructions between catalog construction and activation.
    server.description = "Inspect current Worker logs";
    server.instructions = "Choose the exact Worker before querying logs.";
    const prompts: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const request = providerRequestView<{ messages: Array<{ role: string; content: string | Array<{ text?: string }> }> }>(JSON.parse(String(init?.body)));
      const content = request.messages.find((message) => message.role === "system")!.content;
      prompts.push(typeof content === "string" ? content : content.map((part) => part.text ?? "").join("\n"));
      const load = !restored && prompts.length === 1;
      const delta = load ? { tool_calls: [{ index: 0, id: "load-mcp", type: "function",
        function: { name: "load_plugin", arguments: JSON.stringify({ pluginId: plugin.modelId }) } }] } : { content: "Ready." };
      return responsesStreamResponse([{ choices: [{ delta, finish_reason: load ? "tool_calls" : "stop" }] }]);
    };
    expect(await runHarness({
      config: { apiKey: "test-key", primaryModel: "google/gemini-2.5-flash-lite", fetch: fetcher,
        maxIterations: 4, maxToolCalls: 3, maxWallClockMs: 120_000, toolTimeoutMs: 30_000, maxWebResults: 4 },
      workspaceId: WORKSPACE_ID, workstreamId: input.parentId, loopId: input.loopId, harnessRunId: input.harnessRunId,
      executionPrincipal: input.executionPrincipal, systemPrompt: "Investigate the selected deployment.",
      messages: [{ role: "user", content: "Use Engineering." }], corePlugins: [], plugins: [plugin],
      activationHints: restored ? [plugin.canonicalId] : [], reauthorizePlugin: () => "authorized", onEvent: () => {},
    })).toMatchObject({ status: "completed" });
    if (!restored) {
      expect(prompts[0]).toContain("Inspect deployment logs");
      expect(prompts[0]).not.toContain("Old account guidance.");
      expect(prompts[0]).not.toContain("Choose the exact Worker before querying logs.");
    }
    expect(prompts.at(-1)).toContain("# Active Plugin Instructions");
    expect(prompts.at(-1)).toContain("Choose the exact Worker before querying logs.");
    expect(prompts.at(-1)).not.toContain("Old account guidance.");
    const catalog = await __integrationTesting.loadAutomationCreatorPluginCatalog(runtimeEnv, WORKSPACE_ID, USER_ID);
    expect(catalog[0]).toMatchObject({ description: "Inspect current Worker logs" });
    expect(catalog[0]!.systemMessage).toContain("Choose the exact Worker before querying logs.");
    delete server.description;
    delete server.instructions;
    await new ConnectionService(env, auth).getCustomMcpSettings(connection.id);
    const refreshed = await __integrationTesting.loadHarnessTools(runtimeEnv, input);
    expect(refreshed.plugins.find((candidate) => candidate.connectorType === "custom_mcp")).toMatchObject({
      description: "Available tools: search_docs: Search the corpus",
    });
    expect(refreshed.plugins.find((candidate) => candidate.connectorType === "custom_mcp")!.systemMessage)
      .not.toContain("Choose the exact Worker before querying logs.");
  });

  it("identifies existing named servers in run and Sidekick catalogs without changing their tool prefixes", async () => {
    const { auth, database, env } = fixture();
    stubMcpServer([READ_TOOL]);
    const service = new ConnectionService(env, auth);
    const connections = [];
    for (const [index, name] of ["Cloudflare Observability", "Rally Engineering"].entries()) {
      const { connection } = await service.createCustomMcp({
        displayName: name, scope: "workspace", serverUrl: `https://mcp${index}.example.test/mcp`,
        requestHeaders: { "X-Api-Key": "secret-value" }, toolPolicy: "all_tools",
      });
      connections.push(connection);
    }
    const input: WorkstreamWorkflowInput = {
      region: "global", workspaceId: WORKSPACE_ID, parentKind: "workstream",
      parentId: asWorkstreamId("00000000-0000-4000-8000-000000000004"),
      loopId: "custom-mcp-named-catalog", harnessRunId: asHarnessRunId("00000000-0000-4000-8000-000000000005"),
      triggerMessageId: null, activityId: null, executionPrincipal: { type: "user", userId: USER_ID }, reason: "test",
    };
    const runtimeEnv = withWorkspaceRuntimeDatabase(createTestEnv({ ...env,
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(testWorkstreamObjectStore()),
    }), WORKSPACE_ID);
    const selected = await __integrationTesting.loadHarnessTools(runtimeEnv, input);
    const plugins = selected.plugins.filter((plugin) => plugin.connectorType === "custom_mcp");
    expect(plugins.map((plugin) => ({ id: plugin.modelId, wire: plugin.shortWireName }))).toEqual([
      { id: "plugin_mcp_cloudflare_observability_1", wire: "custom_mcp" },
      { id: "plugin_mcp_rally_engineering_2", wire: "custom_mcp_2" },
    ]);
    const engineering = plugins[1]!;
    expect(selected.frozenConnections.get(engineering.canonicalId)).toMatchObject({
      connectionId: connections[1]!.id, credentialModelPluginId: "plugin_custom_mcp_2",
    });
    const tools = await engineering.loadTools!();
    expect(tools.map((tool) => tool.definition.name)).toEqual(["search_docs"]);
    const catalog = await __integrationTesting.loadAutomationCreatorPluginCatalog(runtimeEnv, WORKSPACE_ID, USER_ID);
    expect(catalog.map((plugin) => plugin.pluginId)).toEqual([
      "plugin_mcp_cloudflare_observability_1", "plugin_mcp_rally_engineering_2",
    ]);
    expect(executeAutomationCreatorDiscoveryTool("plugins_search", { query: "Rally Engineering" }, catalog))
      .toMatchObject({ plugins: [{ pluginId: "plugin_mcp_rally_engineering_2" }] });
    expect(database.prepare("SELECT model_plugin_id FROM connector_connections ORDER BY created_at").all())
      .toEqual([{ model_plugin_id: "plugin_custom_mcp" }, { model_plugin_id: "plugin_custom_mcp_2" }]);
  });

  it("stores a header-authenticated server only once it answers, and reports its live catalog", async () => {
    const { auth, database, env } = fixture();
    const requests: Array<{ url: string; apiKey: string | null }> = [];
    stubMcpServer([READ_TOOL, WRITE_TOOL], requests);
    const service = new ConnectionService(env, auth);

    const { connection } = await service.createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "read_only_tools",
    });

    expect(connection).toMatchObject({
      connectorType: "custom_mcp",
      displayName: "Acme docs",
      scope: "workspace",
      grantedCapabilities: ["custom_mcp.tools"],
      settingsKind: "custom_mcp_tools",
      status: "healthy",
    });
    expect(requests.every((request) => request.url === SERVER_URL)).toBe(true);
    expect(requests[0]?.apiKey).toBe("secret-value");

    const row = database.prepare(
      "SELECT config_json, encrypted_credentials, credential_iv, provider_account_id, model_plugin_id FROM connector_connections WHERE id = ?",
    ).get(connection.id) as {
      config_json: string;
      encrypted_credentials: string;
      credential_iv: string;
      provider_account_id: string;
      model_plugin_id: string;
    };
    expect(JSON.parse(row.config_json)).toMatchObject({
      serverUrl: SERVER_URL,
      authMode: "headers",
      toolPolicy: "read_only_tools",
      mcpServerMetadata: { description: "Available tools: search_docs: Search the corpus" },
    });
    expect(row.provider_account_id).toBe(SERVER_URL);
    expect(row.model_plugin_id).toBe("plugin_custom_mcp");
    // The headers are a credential: encrypted at rest, bound to the connection,
    // and never returned to a client.
    await expect(decryptString(
      row.encrypted_credentials,
      row.credential_iv,
      CREDENTIAL_KEY,
      connection.id,
    )).resolves.toBe(JSON.stringify({ authMode: "headers", requestHeaders: { "X-Api-Key": "secret-value" } }));

    const settings = await service.getCustomMcpSettings(connection.id);
    expect(settings).toMatchObject({
      serverUrl: SERVER_URL,
      authMode: "headers",
      toolPolicy: "read_only_tools",
      toolPolicyEditable: true,
      toolsUnavailable: null,
    });
    expect(settings.tools).toEqual([
      { name: "search_docs", description: "Search the corpus", readOnly: true, destructive: false, available: true },
      { name: "publish_doc", description: "Publish a document", readOnly: false, destructive: false, available: false },
    ]);
  });

  it("leaves nothing behind when the server cannot be used", async () => {
    const { auth, database, env } = fixture();
    vi.stubGlobal("fetch", async () => new Response("no", { status: 502 }));
    const service = new ConnectionService(env, auth);

    await expect(service.createCustomMcp({
      displayName: "Broken",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    })).rejects.toMatchObject({ status: 422, code: "custom_mcp_unreachable" });

    // A row that stays would hold its plugin name, appear in Connections, and
    // fail every run that loaded it.
    expect(database.prepare("SELECT count(*) AS count FROM connector_connections").get())
      .toEqual({ count: 0 });
  });

  it("ends a stalled tool count with the existing Settings inventory deadline", async () => {
    vi.useFakeTimers();
    const { auth, env } = fixture();
    stubMcpServer([READ_TOOL]);
    const providerFetch = globalThis.fetch;
    let stall = false;
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal("fetch", (target: string | URL | Request, init?: RequestInit) => {
      if (!stall || init?.method === "DELETE") return providerFetch(target, init);
      started();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const service = new ConnectionService(env, auth);
    const { connection } = await service.createCustomMcp({
      displayName: "Acme docs", scope: "workspace", serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" }, toolPolicy: "all_tools",
    });
    stall = true;
    const caller = new AbortController();
    let outcome: unknown;
    const pending = service.getToolCount(connection.id, caller.signal)
      .then((value) => { outcome = value; }, (error: unknown) => { outcome = error; });
    await providerStarted;
    await vi.advanceTimersByTimeAsync(20_000);
    try {
      expect(outcome).toMatchObject({ name: "TimeoutError" });
    } finally {
      caller.abort();
      await pending;
    }
  });

  it.each(["personal", "workspace"] as const)("counts static tools from granted capabilities for a %s connection", async (scope) => {
    const { auth, env, database } = fixture();
    env.GOOGLE_CONNECTOR_OAUTH_CLIENT_ID = "test-client";
    env.GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET = "test-secret";
    stubMcpServer([READ_TOOL]);
    const service = new ConnectionService(env, auth);
    const { connection } = await service.createCustomMcp({
      displayName: "Google", scope, serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" }, toolPolicy: "all_tools",
    });
    database.prepare("UPDATE connector_connections SET connector_type = 'google', granted_scopes_json = ? WHERE id = ?")
      .run(JSON.stringify(["gmail.read"]), connection.id);
    // Eight authored `gmail.read` tools plus search and draft-list continuation
    // tools generated on activation.
    expect(await service.getToolCount(connection.id, new AbortController().signal)).toEqual({ count: 10 });
    database.prepare("UPDATE connector_connections SET granted_scopes_json = ? WHERE id = ?")
      .run(JSON.stringify(["gmail.send"]), connection.id);
    expect(await service.getToolCount(connection.id, new AbortController().signal)).toEqual({ count: 2 });
  });

  it("refuses a tool count when connection prefixes make remote tool names collide", async () => {
    const { auth, env } = fixture();
    const inventory = [READ_TOOL];
    stubMcpServer(inventory);
    const service = new ConnectionService(env, auth);
    const { connection } = await service.createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    });
    // The provider can change its inventory after connection setup. These names
    // differ within 64 characters, but collide once Rally prefixes their wire names.
    inventory.splice(0, inventory.length,
      { ...READ_TOOL, name: `${"a".repeat(60)}x` },
      { ...READ_TOOL, name: `${"a".repeat(60)}y` },
    );

    await expect(service.getToolCount(connection.id, new AbortController().signal))
      .rejects.toMatchObject({
        code: "provider_error",
        message: expect.stringContaining("collide after model-facing normalization"),
      });
  });

  it("narrows a workspace connection's tools when the policy changes, and refuses the toggle on a personal one", async () => {
    const { auth, database, env } = fixture();
    stubMcpServer([READ_TOOL, WRITE_TOOL]);
    const service = new ConnectionService(env, auth);

    const workspace = await service.createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    });
    expect((await service.getCustomMcpSettings(workspace.connection.id)).tools
      .filter((tool) => tool.available)
      .map((tool) => tool.name)).toEqual(["search_docs", "publish_doc"]);

    expect(await service.getToolCount(workspace.connection.id, new AbortController().signal)).toEqual({ count: 2 });
    const updated = await service.updateCustomMcpToolPolicy(workspace.connection.id, "read_only_tools");
    expect(await service.getToolCount(workspace.connection.id, new AbortController().signal)).toEqual({ count: 1 });
    expect(updated.toolPolicy).toBe("read_only_tools");
    expect(updated.tools.filter((tool) => tool.available).map((tool) => tool.name)).toEqual(["search_docs"]);
    expect((await service.getCustomMcpSettings(workspace.connection.id)).toolPolicy).toBe("read_only_tools");

    const personal = await service.createCustomMcp({
      displayName: "My docs",
      scope: "personal",
      serverUrl: "https://personal.example.test/mcp",
      requestHeaders: { "X-Api-Key": "personal-value" },
      toolPolicy: "read_only_tools",
    });
    const personalSettings = await service.getCustomMcpSettings(personal.connection.id);
    expect(personalSettings).toMatchObject({ toolPolicy: "all_tools", toolPolicyEditable: false });
    // Stored as `all_tools`, not merely reported as it: the adapter reads the
    // same field for every scope, so a personal row that kept the requested
    // value would narrow the owner's own tools with no way to widen them again.
    const personalRow = database.prepare(
      "SELECT config_json FROM connector_connections WHERE id = ?",
    ).get(personal.connection.id) as { config_json: string };
    expect(JSON.parse(personalRow.config_json)).toMatchObject({ toolPolicy: "all_tools" });
    await expect(service.updateCustomMcpToolPolicy(personal.connection.id, "read_only_tools"))
      .rejects.toMatchObject({ status: 422, code: "custom_mcp_policy_unsupported" });
  });

  it("refuses a read-only connection to a server that marks nothing read-only", async () => {
    const { auth, database, env } = fixture();
    // The server advertises a tool, so counting the raw catalog would accept
    // this. The policy leaves nothing to call, and every activation would fail.
    stubMcpServer([WRITE_TOOL]);
    const service = new ConnectionService(env, auth);

    await expect(service.createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "read_only_tools",
    })).rejects.toMatchObject({
      status: 422,
      code: "custom_mcp_unreachable",
      // The message a person can act on: choose "All tools". The generic
      // empty-catalog wording would leave them guessing at their own server.
      message: expect.stringContaining("marks none of its tools read-only"),
    });
    expect(database.prepare("SELECT count(*) AS count FROM connector_connections").get())
      .toEqual({ count: 0 });

    // The same server is usable with the policy that can reach it.
    await expect(service.createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    })).resolves.toMatchObject({ connection: { displayName: "Acme docs" } });
  });

  it("refuses a policy change that would leave the connection able to call nothing", async () => {
    const { auth, env } = fixture();
    stubMcpServer([WRITE_TOOL]);
    const service = new ConnectionService(env, auth);
    const { connection } = await service.createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    });

    // Narrowing this to read-only would leave the plugin unloadable, which
    // creation already refuses; arriving there by a settings change is the
    // same outcome with nothing to tell the person why.
    await expect(service.updateCustomMcpToolPolicy(connection.id, "read_only_tools"))
      .rejects.toMatchObject({ status: 422, code: "custom_mcp_policy_admits_nothing" });
    expect((await service.getCustomMcpSettings(connection.id)).toolPolicy).toBe("all_tools");

    // A server that cannot be reached is not evidence about the policy, so it
    // does not block the change.
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 503 }));
    await expect(service.updateCustomMcpToolPolicy(connection.id, "read_only_tools"))
      .resolves.toMatchObject({ toolPolicy: "read_only_tools" });
  });

  it("does not offer a member a policy control their change would be refused by", async () => {
    const { auth, env } = fixture();
    stubMcpServer([READ_TOOL, WRITE_TOOL]);
    const { connection } = await new ConnectionService(env, auth).createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    });
    const memberService = new ConnectionService(env, {
      sessionId: "session",
      userId: MEMBER_ID,
      workspaceId: WORKSPACE_ID,
      region: "global",
      role: "member",
    });

    // A member may read the catalog — knowing what the workspace can call is
    // theirs to know — but the control they would be 403'd on is not offered.
    const settings = await memberService.getCustomMcpSettings(connection.id);
    expect(settings).toMatchObject({ toolPolicy: "all_tools", toolPolicyEditable: false });
    expect(settings.tools.map((tool) => tool.name)).toEqual(["search_docs", "publish_doc"]);
    await expect(memberService.updateCustomMcpToolPolicy(connection.id, "read_only_tools"))
      .rejects.toMatchObject({ status: 403, code: "workspace_admin_required" });
  });

  it("keeps a workspace server an administrator's decision", async () => {
    const { env } = fixture();
    stubMcpServer([READ_TOOL]);
    const memberService = new ConnectionService(env, {
      sessionId: "session",
      userId: MEMBER_ID,
      workspaceId: WORKSPACE_ID,
      region: "global",
      role: "member",
    });

    await expect(memberService.createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    })).rejects.toMatchObject({ status: 403, code: "workspace_admin_required" });

    // Their own connection is theirs to make.
    await expect(memberService.createCustomMcp({
      displayName: "My docs",
      scope: "personal",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    })).resolves.toMatchObject({ connection: { scope: "personal" } });
  });

  it("reports an unreachable server as an unreadable catalog rather than a failed screen", async () => {
    const { auth, env } = fixture();
    stubMcpServer([READ_TOOL]);
    const service = new ConnectionService(env, auth);
    const { connection } = await service.createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    });

    vi.stubGlobal("fetch", async () => new Response("gone", { status: 503 }));
    const settings = await service.getCustomMcpSettings(connection.id);
    expect(settings).toMatchObject({ serverUrl: SERVER_URL, toolPolicy: "all_tools", tools: [] });
    expect(settings.toolsUnavailable).toMatch(/503/u);
  });
});

/** One Streamable HTTP MCP server, answering initialize, list, and shutdown. */
function stubMcpServer(
  tools: readonly Record<string, unknown>[],
  requests: Array<{ url: string; apiKey: string | null }> = [],
  server: { description?: string; instructions?: string } = {},
): void {
  vi.stubGlobal("fetch", async (target: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof target === "string" ? target : target instanceof URL ? target.href : target.url);
    const headers = new Headers(init?.headers);
    requests.push({ url: url.href, apiKey: headers.get("x-api-key") });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    const id = request.id as number;
    const result = request.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "Example", version: "1", description: server.description },
          instructions: server.instructions }
      : { tools };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      headers: { "content-type": "application/json" },
    });
  });
}

function catalogWorkflowInput(): WorkstreamWorkflowInput {
  return { region: "global", workspaceId: WORKSPACE_ID, parentKind: "workstream",
    parentId: asWorkstreamId("00000000-0000-4000-8000-000000000004"), loopId: "custom-mcp-metadata",
    harnessRunId: asHarnessRunId("00000000-0000-4000-8000-000000000005"),
    triggerMessageId: null, activityId: null, executionPrincipal: { type: "user", userId: USER_ID }, reason: "test" };
}

/**
 * The regional database is the checked-in migrations, and `connector_connections`
 * lives where production keeps it: in a real `WorkspaceDO` built from its own
 * migration ledger. `database` is that object's store. Only the MCP server and
 * the socket publish are doubled.
 */
function fixture() {
  const regional = migratedSqliteDatabase();
  databases.push(regional);
  const at = "2026-09-26T00:00:00.000Z";
  const insertUser = regional.prepare(`INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  insertUser.run(USER_ID, "custom-mcp-owner", "owner@example.test", "Workspace Owner", at, at);
  insertUser.run(MEMBER_ID, "custom-mcp-member", "member@example.test", "Workspace Member", at, at);
  regional.prepare(`INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES (?, 'Custom MCP', 'custom-mcp', 'global', ?, ?, ?)`).run(WORKSPACE_ID, USER_ID, at, at);
  regional.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES (?, ?, 'owner', 'active', ?)`).run(WORKSPACE_ID, USER_ID, at);
  const workspace = createTestWorkspaceDO({
    workspaceId: WORKSPACE_ID,
    regionalDatabase: regional,
    register: (created) => { databases.push(created); },
  });
  const stub = {
    ...workspaceObjectRpcs(workspace.instance, ["executeRuntimeSql", "sidekickReadExecutionDelegation"]),
    publishSync: async () => 0,
  };
  const workspaceObjects: Env["WORKSPACE_DOS"] = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => stub,
    jurisdiction: (): Env["WORKSPACE_DOS"] => workspaceObjects,
  });
  const database = workspace.objectDatabase;
  const auth: AuthContext = {
    sessionId: "session",
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    region: "global",
    role: "owner",
  };
  return {
    workspace,
    database,
    auth,
    stub,
    env: createTestEnv({
      DB: sqliteD1(regional),
      AVALON_REGION: "global",
      PUBLIC_API_BASE_URL: "https://api.example.test",
      CONNECTOR_CREDENTIALS_KEY: CREDENTIAL_KEY,
      CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
      WORKSPACE_DOS: workspaceObjects,
    }),
  };
}
