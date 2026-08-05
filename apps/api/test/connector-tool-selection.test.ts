import type { WorkstreamWorkflowInput } from "@avalon/contracts";
import { runHarness, type HarnessEvent, type HarnessToolContext } from "@avalon/agent-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { __integrationTesting } from "../src/services/integrations";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000002";
const HARNESS_RUN_ID = "00000000-0000-4000-8000-000000000003";
const USER_ID = "00000000-0000-4000-8000-000000000004";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000005";
const WORKSPACE_CONNECTION_ID = "00000000-0000-4000-8000-000000000006";
const OWNER_CONNECTION_ID = "00000000-0000-4000-8000-000000000007";
const OTHER_CONNECTION_ID = "00000000-0000-4000-8000-000000000008";
const SUBSCRIPTION_ID = "00000000-0000-4000-8000-000000000009";
const WEB_MONITOR_CONNECTION_ID = "00000000-0000-4000-8000-000000000010";
const OTHER_WORKSPACE_CONNECTION_ID = "00000000-0000-4000-8000-000000000011";
const CHILD_HARNESS_RUN_ID = "00000000-0000-4000-8000-000000000012";

const GOOGLE_WORKSPACE_CAPABILITIES = [
  "drive.read",
  "docs.read",
  "docs.write",
  "sheets.read",
  "sheets.write",
] as const;

const GOOGLE_WORKSPACE_TOOLS = [
  "google.drive.search",
  "google.drive.get_metadata",
  "google.drive.download",
  "google.drive.export",
  "google.docs.read_document",
  "google.docs.create_document",
  "google.docs.append_text",
  "google.docs.replace_text",
  "google.sheets.read_spreadsheet",
  "google.sheets.read_values",
  "google.sheets.create_spreadsheet",
  "google.sheets.update_values",
  "google.sheets.append_values",
] as const;

const GOOGLE_MAIL_CALENDAR_CAPABILITIES = [
  "gmail.read",
  "gmail.draft",
  "gmail.send",
  "calendar.read",
  "calendar.write",
] as const;

interface ConnectionRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  connector_type: "google" | "web_monitor";
  scope: "personal" | "workspace";
  owner_user_id: string | null;
  granted_scopes_json: string;
  status: "healthy" | "error";
  created_at: string;
  model_plugin_id?: string;
  encrypted_credentials?: string;
  credential_iv?: string;
}

class ToolSelectionDatabase {
  readonly binding: D1Database;
  readonly connections: ConnectionRow[];
  memberStatus = "active";

  constructor(
    connections: ConnectionRow[],
    readonly automationBindings: Array<{ capability: string; connection_id: string }> = [],
    readonly attachedConnectionIds: string[] = [],
  ) {
    const counts = new Map<string, number>();
    this.connections = connections.map((row) => {
      const base = row.connector_type === "web_monitor" ? "plugin_web_monitor" : "plugin_google";
      const key = `${row.workspace_id}:${base}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      row.model_plugin_id ??= count === 1 ? base : `${base}_${count}`;
      return row;
    });
    this.binding = {
      prepare: (sql: string) => new ToolSelectionStatement(this, sql) as unknown as D1PreparedStatement,
    } as unknown as D1Database;
  }
}

class ToolSelectionStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: ToolSelectionDatabase,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): ToolSelectionStatement {
    this.values = values;
    return this;
  }

  async all<T>(): Promise<D1Result<T>> {
    const sql = this.sql.replace(/\s+/gu, " ").trim();
    let results: unknown[];
    if (sql.includes("json_each(s.connector_bindings_json)")) {
      expect(this.values).toEqual([SUBSCRIPTION_ID, WORKSPACE_ID]);
      results = this.database.automationBindings;
    } else if (sql.includes("FROM workstream_resources wr")) {
      expect(this.values).toEqual([WORKSTREAM_ID, WORKSPACE_ID]);
      results = this.database.attachedConnectionIds.map((connection_id) => ({ connection_id }));
    } else if (sql.includes("FROM connector_connections")) {
      if (sql.includes("(scope = 'workspace' OR (scope = 'personal'")) {
        expect(this.values).toEqual([WORKSPACE_ID, USER_ID]);
        results = this.database.connections.filter((row) =>
          row.workspace_id === WORKSPACE_ID && row.status === "healthy" &&
          (row.scope === "workspace" || row.owner_user_id === USER_ID)
        );
      } else {
        expect(this.values).toEqual([WORKSPACE_ID]);
        results = this.database.connections;
      }
    } else {
      throw new Error(`Unexpected tool-selection query: ${sql}`);
    }
    return { success: true, results } as unknown as D1Result<T>;
  }

  async first<T>(): Promise<T | null> {
    const sql = this.sql.replace(/\s+/gu, " ").trim();
    if (sql.includes("FROM workspace_members wm")) {
      expect(this.values).toEqual([WORKSPACE_ID, USER_ID]);
      return { status: this.database.memberStatus } as T;
    }
    if (sql.includes("FROM workstreams") && sql.includes("automation_subscription_id")) {
      expect(this.values).toEqual([WORKSTREAM_ID, WORKSPACE_ID]);
      return {
        archived_at: null,
        automation_subscription_id: null,
        automation_run_id: null,
      } as T;
    }
    if (sql.includes("SELECT default_plugins_json FROM automation_subscriptions")) {
      expect(this.values).toEqual([SUBSCRIPTION_ID, WORKSPACE_ID]);
      const pluginIds = [...new Set(this.database.automationBindings.map((binding) => {
        const row = this.database.connections.find((connectionRow) => connectionRow.id === binding.connection_id);
        return row?.model_plugin_id;
      }).filter((pluginId): pluginId is string => Boolean(pluginId)))];
      return { default_plugins_json: JSON.stringify(pluginIds) } as T;
    }
    if (sql.includes("FROM connector_connections") && sql.includes("WHERE id = ? AND workspace_id = ?")) {
      const [connectionId, workspaceId] = this.values;
      return (this.database.connections.find((row) =>
        row.id === connectionId && row.workspace_id === workspaceId
      ) ?? null) as T | null;
    }
    if (sql.includes("SELECT id FROM workspaces")) {
      return { id: WORKSPACE_ID } as T;
    }
    throw new Error(`Unexpected tool-selection first query: ${sql}`);
  }
}

function connection(
  id: string,
  scope: "personal" | "workspace",
  ownerUserId: string | null,
  capabilities: readonly string[] = GOOGLE_WORKSPACE_CAPABILITIES,
  createdAt = "2026-08-01T00:00:00.000Z",
  workspaceId = WORKSPACE_ID,
  connectorType: ConnectionRow["connector_type"] = "google",
): ConnectionRow {
  return {
    id,
    workspace_id: workspaceId,
    connector_type: connectorType,
    scope,
    owner_user_id: ownerUserId,
    granted_scopes_json: JSON.stringify(capabilities),
    cursor_json: "{}",
    config_json: JSON.stringify(connectorType === "web_monitor"
      ? { url: "https://example.com/workspace-fixture", intervalSeconds: 3600, region: "global" }
      : {}),
    status: "healthy",
    created_at: createdAt,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function env(database: ToolSelectionDatabase): Env {
  return {
    DB: database.binding,
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    GOOGLE_CONNECTOR_OAUTH_CLIENT_ID: "google-connector-client",
    GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET: "google-connector-secret",
    CONNECTOR_CREDENTIALS_KEY: "must-not-be-used-after-revocation",
    AVALON_REGION: "global",
  } as Env;
}

function workflowInput(automationSubscriptionId: string | null = null): WorkstreamWorkflowInput {
  return {
    region: "global",
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    harnessRunId: HARNESS_RUN_ID,
    triggerMessageId: null,
    automationSubscriptionId,
    activityId: null,
    executionPrincipal: { type: "user", userId: USER_ID },
    reason: automationSubscriptionId ? "Automation test" : "Ad-hoc test",
  };
}

function googleToolNames(tools: Awaited<ReturnType<typeof __integrationTesting.loadHarnessTools>>["tools"]): string[] {
  return tools
    .map((tool) => tool.definition.name)
    .filter((name) => name.startsWith("google."));
}

function pluginConnectionIds(
  selected: Awaited<ReturnType<typeof __integrationTesting.loadHarnessTools>>,
): string[] {
  return selected.plugins.map((plugin) => plugin.canonicalId.slice("connection:".length));
}

function childWorkflowInput(parent = workflowInput()): WorkstreamWorkflowInput {
  return {
    ...parent,
    harnessRunId: CHILD_HARNESS_RUN_ID,
    reason: "sub_agent",
  };
}

describe("connector tools selected for harness runs", () => {
  it("gives the automation architect executable connector tools with live authorization checks", async () => {
    const database = new ToolSelectionDatabase([
      connection(
        WEB_MONITOR_CONNECTION_ID,
        "workspace",
        null,
        ["web.read"],
        "2026-08-01T00:00:01.000Z",
        WORKSPACE_ID,
        "web_monitor",
      ),
    ]);
    const fetcher = vi.fn(async () => new Response("<main>Avalon status is healthy.</main>", {
      headers: { "content-type": "text/html" },
    }));
    vi.stubGlobal("fetch", fetcher);

    const catalog = await __integrationTesting.loadAutomationCreatorPluginCatalog(
      env(database),
      WORKSPACE_ID,
      USER_ID,
    );
    const plugin = catalog.find((entry) => entry.pluginId === "plugin_web_monitor");
    const tool = plugin?.tools.find((entry) => entry.name === "web_monitor_fetch");
    expect(tool).toMatchObject({
      canonicalName: "web_monitor.fetch",
      capability: "web.read",
      mode: "read",
      idempotency: "safe",
    });

    const context: HarnessToolContext = {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      harnessRunId: HARNESS_RUN_ID,
      toolCallId: "automation-creator-tool-1",
      executionPrincipal: { type: "user", userId: USER_ID },
      signal: new AbortController().signal,
    };
    await expect(tool!.execute!({}, context)).resolves.toMatchObject({
      summary: "Fetched example.com",
      output: { readableText: "Avalon status is healthy." },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    database.memberStatus = "removed";
    await expect(tool!.execute!({}, context)).rejects.toThrow(/active workspace member/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("resolves durable receipt policy from canonical identity, never a provider wire alias", async () => {
    const database = new ToolSelectionDatabase([
      connection(WORKSPACE_CONNECTION_ID, "workspace", null),
      connection(
        WEB_MONITOR_CONNECTION_ID,
        "workspace",
        null,
        ["web.read"],
        "2026-08-01T00:00:01.000Z",
        WORKSPACE_ID,
        "web_monitor",
      ),
    ]);
    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());

    const listPolicy = __integrationTesting.resolveHarnessToolReceiptPolicy({
      pluginId: "avalon:discovery",
      canonicalToolName: "list_connector_plugins",
      capability: "avalon.plugins.list",
      mode: "read",
      idempotency: "safe",
    }, selected);
    const loadPolicy = __integrationTesting.resolveHarnessToolReceiptPolicy({
      pluginId: "avalon:discovery",
      canonicalToolName: "load_plugin",
      capability: "avalon.plugins.load",
      mode: "read",
      idempotency: "safe",
    }, selected);
    const timePolicy = __integrationTesting.resolveHarnessToolReceiptPolicy({
      pluginId: "avalon:time",
      canonicalToolName: "avalon.current_time",
      capability: "time.read",
      mode: "read",
      idempotency: "safe",
    }, selected);
    const workstreamPolicy = __integrationTesting.resolveHarnessToolReceiptPolicy({
      pluginId: "avalon:workstream",
      canonicalToolName: "avalon.read_workstream",
      capability: "workstream.read",
      mode: "read",
      idempotency: "safe",
    }, selected);
    const monitorPluginId = `connection:${WEB_MONITOR_CONNECTION_ID}`;
    const monitorPolicy = __integrationTesting.resolveHarnessToolReceiptPolicy({
      pluginId: monitorPluginId,
      canonicalToolName: "web_monitor.fetch",
      capability: "web.read",
      mode: "read",
      idempotency: "safe",
    }, selected);

    expect(listPolicy).toMatchObject({ connectionId: null, definition: { mode: "read", idempotency: "safe" } });
    expect(loadPolicy).toMatchObject({ connectionId: null, definition: { mode: "read", idempotency: "safe" } });
    expect(timePolicy).toMatchObject({ connectionId: null, definition: { mode: "read", idempotency: "safe" } });
    expect(workstreamPolicy).toMatchObject({ connectionId: null, definition: { mode: "read", idempotency: "safe" } });
    expect(monitorPolicy).toMatchObject({
      pluginId: monitorPluginId,
      connectionId: WEB_MONITOR_CONNECTION_ID,
      definition: { name: "web_monitor.fetch", mode: "read", idempotency: "safe" },
    });
    expect(__integrationTesting.storedToolPolicyMatches(JSON.stringify({
      pluginId: monitorPolicy.pluginId,
      canonicalToolName: monitorPolicy.definition.name,
      capability: monitorPolicy.definition.capability,
      mode: monitorPolicy.definition.mode,
      idempotency: monitorPolicy.definition.idempotency,
      connectionId: monitorPolicy.connectionId,
      toolSurfaceHash: monitorPolicy.toolSurfaceHash,
    }), monitorPolicy)).toBe(true);
    expect(__integrationTesting.storedToolPolicyMatches(JSON.stringify({
      pluginId: monitorPolicy.pluginId,
      canonicalToolName: monitorPolicy.definition.name,
      capability: monitorPolicy.definition.capability,
      mode: "write",
      idempotency: "record_before_execute",
      connectionId: monitorPolicy.connectionId,
      toolSurfaceHash: monitorPolicy.toolSurfaceHash,
    }), monitorPolicy)).toBe(false);
    expect(() => __integrationTesting.resolveHarnessToolReceiptPolicy({
      pluginId: monitorPluginId,
      canonicalToolName: "web_monitor.fetch",
      capability: "web.read",
      mode: "write",
      idempotency: "record_before_execute",
    }, selected)).toThrow("outside this run scope");
  });

  it("installs one durable read-only sub-agent tool into the root core surface", async () => {
    const database = new ToolSelectionDatabase([]);
    const parentInput = workflowInput();
    const selected = await __integrationTesting.loadHarnessTools(env(database), parentInput);

    const tool = __integrationTesting.installInlineChildAgentTool({
      env: env(database),
      input: parentInput,
      parentLease: () => ({
        attemptId: "attempt-parent",
        owner: "owner-parent",
        attemptNumber: 1,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      }),
      parentSignal: new AbortController().signal,
      runAuthoritySnapshot: {
        automationRunId: null,
        automationTemplateVersionId: null,
        triggerType: null,
      },
      harnessTools: selected,
      activeCredentialPluginIds: new Set(),
    });

    expect(tool.definition).toMatchObject({
      name: "avalon.run_subagent",
      capability: "subagent.run",
      mode: "read",
      idempotency: "safe",
    });
    expect(selected.coreTools.filter(({ definition }) =>
      definition.name === "avalon.run_subagent"
    )).toHaveLength(1);
    expect(selected.corePlugins.map((plugin) => plugin.canonicalId)).toEqual([
      "avalon:time",
      "avalon:workstream",
    ]);
    expect(selected.corePlugins.find((plugin) =>
      plugin.canonicalId === "avalon:workstream"
    )?.tools.filter(({ definition }) => definition.name === "avalon.run_subagent")).toHaveLength(1);
    expect(selected.tools.filter(({ definition }) =>
      definition.name === "avalon.run_subagent"
    )).toHaveLength(1);
    expect(selected.modeByTool.get("avalon.run_subagent")).toBe("read");
    expect(selected.idempotencyByTool.get("avalon.run_subagent")).toBe("safe");
  });

  it("builds a non-recursive read-only child surface from only inherited active plugins", async () => {
    const database = new ToolSelectionDatabase([
      connection(WORKSPACE_CONNECTION_ID, "workspace", null),
      connection(OWNER_CONNECTION_ID, "personal", USER_ID),
    ]);
    const parentInput = workflowInput();
    const runtimeEnv = {
      ...env(database),
      FIRECRAWL_API_KEY: "firecrawl-test-key",
    } as Env;
    const parentTools = await __integrationTesting.loadHarnessTools(runtimeEnv, parentInput);
    expect(parentTools.plugins).toHaveLength(2);
    expect(parentTools.plugins.flatMap((plugin) => plugin.tools)
      .some((tool) => tool.definition.mode === "write")).toBe(true);

    const childTools = await __integrationTesting.createInlineChildHarnessSurface({
      env: runtimeEnv,
      parentInput,
      childInput: childWorkflowInput(parentInput),
      parentHarnessTools: parentTools,
      selectedPluginIds: [`connection:${WORKSPACE_CONNECTION_ID}`],
      assertChildOwned: async () => undefined,
    });

    expect(childTools.plugins.map((plugin) => plugin.canonicalId)).toEqual([
      `connection:${WORKSPACE_CONNECTION_ID}`,
    ]);
    expect(childTools.plugins[0]).toMatchObject({ preload: true, explicit: true });
    expect(childTools.tools.every((tool) => tool.definition.mode === "read")).toBe(true);
    expect(childTools.plugins[0]?.tools.map((tool) => tool.definition.name)).toEqual([
      "google.drive.search",
      "google.drive.get_metadata",
      "google.drive.download",
      "google.drive.export",
      "google.docs.read_document",
      "google.sheets.read_spreadsheet",
      "google.sheets.read_values",
    ]);
    expect(childTools.coreTools.map((tool) => tool.definition.name)).toEqual([
      "avalon.current_time",
      "avalon.read_workstream",
      "avalon.web_search",
      "avalon.web_fetch",
      "avalon.read_resource",
    ]);
    expect(childTools.corePlugins.map((plugin) => plugin.canonicalId)).toEqual([
      "avalon:time",
      "avalon:workstream",
    ]);
    expect(childTools.tools.map((tool) => tool.definition.name)).not.toContain("avalon.run_subagent");
    expect(childTools.frozenConnections.has(`connection:${OWNER_CONNECTION_ID}`)).toBe(false);
    expect(childTools.frozenConnections.has(`connection:${WORKSPACE_CONNECTION_ID}`)).toBe(true);
  });

  it("does not give an inbound-email child an outbound Firecrawl channel", async () => {
    const database = new ToolSelectionDatabase([]);
    const parentInput = workflowInput();
    parentInput.reason = "inbound_email";
    const runtimeEnv = {
      ...env(database),
      FIRECRAWL_API_KEY: "firecrawl-test-key",
    } as Env;
    const parentTools = await __integrationTesting.loadHarnessTools(runtimeEnv, parentInput);

    const childTools = await __integrationTesting.createInlineChildHarnessSurface({
      env: runtimeEnv,
      parentInput,
      childInput: childWorkflowInput(parentInput),
      parentHarnessTools: parentTools,
      selectedPluginIds: [],
      assertChildOwned: async () => undefined,
    });

    expect(childTools.coreTools.map((tool) => tool.definition.name)).toEqual([
      "avalon.current_time",
      "avalon.read_workstream",
      "avalon.read_resource",
    ]);
    expect(childTools.tools.map((tool) => tool.definition.name)).not.toContain("avalon.web_search");
    expect(childTools.tools.map((tool) => tool.definition.name)).not.toContain("avalon.web_fetch");
  });

  it("does not add plugin, schema, or result ceilings to child runs", () => {
    const defaultLimits = __integrationTesting.childRunLimits(env(new ToolSelectionDatabase([])));

    expect(defaultLimits).not.toHaveProperty("maxActivePlugins");
    expect(defaultLimits).not.toHaveProperty("maxToolSchemaBytes");
    expect(defaultLimits).not.toHaveProperty("maxToolResultBytes");
  });

  it("rejects a child request for a credential plugin not already active in the parent", async () => {
    const database = new ToolSelectionDatabase([
      connection(WORKSPACE_CONNECTION_ID, "workspace", null),
      connection(OWNER_CONNECTION_ID, "personal", USER_ID),
    ]);
    const parentInput = workflowInput();
    const selected = await __integrationTesting.loadHarnessTools(env(database), parentInput);
    const tool = __integrationTesting.installInlineChildAgentTool({
      env: env(database),
      input: parentInput,
      parentLease: () => ({
        attemptId: "attempt-parent",
        owner: "owner-parent",
        attemptNumber: 1,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      }),
      parentSignal: new AbortController().signal,
      runAuthoritySnapshot: {
        automationRunId: null,
        automationTemplateVersionId: null,
        triggerType: null,
      },
      harnessTools: selected,
      activeCredentialPluginIds: new Set([`connection:${WORKSPACE_CONNECTION_ID}`]),
    });

    await expect(tool.execute(
      {
        objective: "Read the private plan",
        pluginIds: ["plugin_google_2"],
      },
      {
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        harnessRunId: HARNESS_RUN_ID,
        toolCallId: "tool-inactive-child-plugin",
        executionPrincipal: { type: "user", userId: USER_ID },
        signal: new AbortController().signal,
      },
    )).rejects.toThrow("only inherit connector plugins already activated");
  });

  it("executes a workspace tool as the workspace principal and omits another workspace's connection", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
      "workspace-only fixture",
      { status: 200, headers: { "content-type": "text/plain" } },
    ));
    vi.stubGlobal("fetch", fetcher);
    const database = new ToolSelectionDatabase([
      connection(
        WEB_MONITOR_CONNECTION_ID,
        "workspace",
        null,
        ["web.read"],
        "2026-08-01T00:00:00.000Z",
        WORKSPACE_ID,
        "web_monitor",
      ),
      connection(
        OTHER_WORKSPACE_CONNECTION_ID,
        "workspace",
        null,
        ["drive.read"],
        "2026-08-01T00:00:01.000Z",
        OTHER_WORKSPACE_ID,
      ),
    ]);

    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());

    expect(selected.connectionByTool.get("web_monitor.fetch")).toBe(WEB_MONITOR_CONNECTION_ID);
    expect(new Set(selected.connectionByTool.values())).not.toContain(OTHER_WORKSPACE_CONNECTION_ID);
    expect(googleToolNames(selected.tools)).toEqual([]);

    const tool = selected.tools.find(({ definition }) => definition.name === "web_monitor.fetch");
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      {},
      {
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        harnessRunId: HARNESS_RUN_ID,
        toolCallId: "tool-web-monitor-fetch",
        executionPrincipal: { type: "user", userId: USER_ID },
        signal: new AbortController().signal,
      },
    );

    expect(result.summary).toBe("Fetched example.com");
    expect(result.output).toMatchObject({ readableText: "workspace-only fixture" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("exposes every granted read and write tool from a workspace connection to an ad-hoc workstream", async () => {
    const database = new ToolSelectionDatabase([
      connection(WORKSPACE_CONNECTION_ID, "workspace", null),
    ]);

    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());

    expect(googleToolNames(selected.tools)).toEqual(GOOGLE_WORKSPACE_TOOLS);
    expect(new Set(selected.connectionByTool.values())).toEqual(new Set([WORKSPACE_CONNECTION_ID]));
    expect(pluginConnectionIds(selected)).toEqual([WORKSPACE_CONNECTION_ID]);
    expect(selected.plugins[0]?.tools.map((tool) => tool.definition.name)).toEqual(GOOGLE_WORKSPACE_TOOLS);
    expect(selected.modeByTool.get("google.drive.search")).toBe("read");
    expect(selected.modeByTool.get("google.docs.create_document")).toBe("write");
    expect(selected.modeByTool.get("google.sheets.update_values")).toBe("write");
  });

  it("exposes a personal connection only to its owning user", async () => {
    const database = new ToolSelectionDatabase([
      connection(OTHER_CONNECTION_ID, "personal", OTHER_USER_ID, GOOGLE_WORKSPACE_CAPABILITIES, "2026-07-01T00:00:00.000Z"),
      connection(OWNER_CONNECTION_ID, "personal", USER_ID, GOOGLE_WORKSPACE_CAPABILITIES, "2026-08-01T00:00:00.000Z"),
    ]);

    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());

    expect(googleToolNames(selected.tools)).toEqual(GOOGLE_WORKSPACE_TOOLS);
    expect(new Set(selected.connectionByTool.values())).toEqual(new Set([OWNER_CONNECTION_ID]));
  });

  it("retains each eligible credential as a separate plugin while preferring personal identity in the diagnostic view", async () => {
    const database = new ToolSelectionDatabase([
      connection(WORKSPACE_CONNECTION_ID, "workspace", null, GOOGLE_WORKSPACE_CAPABILITIES, "2026-07-01T00:00:00.000Z"),
      connection(OWNER_CONNECTION_ID, "personal", USER_ID, GOOGLE_WORKSPACE_CAPABILITIES, "2026-08-01T00:00:00.000Z"),
    ]);

    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());

    expect(googleToolNames(selected.tools)).toEqual(GOOGLE_WORKSPACE_TOOLS);
    expect(new Set(pluginConnectionIds(selected))).toEqual(new Set([OWNER_CONNECTION_ID, WORKSPACE_CONNECTION_ID]));
    expect(selected.connectionByTool.get("google.drive.search")).toBe(OWNER_CONNECTION_ID);
  });

  it("advertises every Google credential as a distinct capability-specific loadable plugin", async () => {
    const database = new ToolSelectionDatabase([
      connection(
        OWNER_CONNECTION_ID,
        "personal",
        USER_ID,
        GOOGLE_MAIL_CALENDAR_CAPABILITIES,
        "2026-07-01T00:00:00.000Z",
      ),
      connection(
        WORKSPACE_CONNECTION_ID,
        "workspace",
        null,
        GOOGLE_WORKSPACE_CAPABILITIES,
        "2026-08-01T00:00:00.000Z",
      ),
    ]);

    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());
    const mail = selected.plugins.find((plugin) => plugin.canonicalId === `connection:${OWNER_CONNECTION_ID}`);
    const drive = selected.plugins.find((plugin) => plugin.canonicalId === `connection:${WORKSPACE_CONNECTION_ID}`);

    expect(mail).toMatchObject({
      modelId: "plugin_google",
      displayName: "Google Mail + Calendar",
      preload: false,
      explicit: false,
    });
    expect(mail?.description).toContain("email, inbox, mail");
    expect(mail?.searchAliases).toEqual(expect.arrayContaining(["gmail", "email", "inbox", "calendar"]));
    expect(mail?.systemMessage).toContain("use the Gmail search tool first");
    expect(mail?.systemMessage).toContain("do not substitute public web search");
    expect(mail?.systemMessage).not.toContain("Drive search");
    expect(mail?.tools.map((tool) => tool.definition.name)).toEqual([
      "google.gmail.search",
      "google.gmail.read_thread",
      "google.gmail.read_message",
      "google.gmail.create_draft",
      "google.gmail.send",
      "google.calendar.list_calendars",
      "google.calendar.list_events",
      "google.calendar.read_event",
      "google.calendar.create_event",
      "google.calendar.update_event",
    ]);

    expect(drive).toMatchObject({
      modelId: "plugin_google_2",
      displayName: "Google Drive + Docs + Sheets",
    });
    expect(drive?.description).toContain("file, document, spreadsheet");
    expect(drive?.searchAliases).toEqual(expect.arrayContaining(["drive", "files", "docs", "sheets"]));
    expect(drive?.systemMessage).toContain("use the Drive search tool");
    expect(drive?.systemMessage).toContain("do not substitute public web search");
    expect(drive?.systemMessage).not.toContain("Gmail search");
    expect(drive?.tools.map((tool) => tool.definition.name)).toEqual(GOOGLE_WORKSPACE_TOOLS);
  });

  it("preloads an explicitly attached workspace identity without dropping another eligible personal plugin", async () => {
    const database = new ToolSelectionDatabase([
      connection(OWNER_CONNECTION_ID, "personal", USER_ID),
      connection(WORKSPACE_CONNECTION_ID, "workspace", null),
    ], [], [WORKSPACE_CONNECTION_ID]);

    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());

    expect(new Set(pluginConnectionIds(selected))).toEqual(new Set([OWNER_CONNECTION_ID, WORKSPACE_CONNECTION_ID]));
    expect(selected.connectionByTool.get("google.drive.search")).toBe(WORKSPACE_CONNECTION_ID);
    expect(selected.plugins.find((plugin) => plugin.canonicalId === `connection:${WORKSPACE_CONNECTION_ID}`)).toMatchObject({
      preload: true,
      explicit: true,
    });
  });

  it("uses automation plugin defaults as preload hints without narrowing granted tools", async () => {
    const database = new ToolSelectionDatabase(
      [connection(WORKSPACE_CONNECTION_ID, "workspace", null)],
      [
        { capability: "drive.read", connection_id: WORKSPACE_CONNECTION_ID },
        { capability: "docs.write", connection_id: WORKSPACE_CONNECTION_ID },
      ],
    );

    const selected = await __integrationTesting.loadHarnessTools(
      env(database),
      workflowInput(SUBSCRIPTION_ID),
    );

    expect(googleToolNames(selected.tools)).toEqual(GOOGLE_WORKSPACE_TOOLS);
    expect(new Set(selected.connectionByTool.values())).toEqual(new Set([WORKSPACE_CONNECTION_ID]));
    expect(selected.plugins[0]).toMatchObject({
      canonicalId: `connection:${WORKSPACE_CONNECTION_ID}`,
      preload: true,
      explicit: true,
    });
  });

  it("preloads every granted capability from a workstream-attached connection during an automation", async () => {
    const database = new ToolSelectionDatabase(
      [connection(WORKSPACE_CONNECTION_ID, "workspace", null)],
      [],
      [WORKSPACE_CONNECTION_ID],
    );

    const selected = await __integrationTesting.loadHarnessTools(
      env(database),
      workflowInput(SUBSCRIPTION_ID),
    );

    expect(googleToolNames(selected.tools)).toEqual(GOOGLE_WORKSPACE_TOOLS);
    expect(selected.plugins).toHaveLength(1);
    expect(selected.plugins[0]).toMatchObject({
      canonicalId: `connection:${WORKSPACE_CONNECTION_ID}`,
      modelId: "plugin_google",
      shortWireName: "google",
      preload: true,
      explicit: true,
    });
  });

  it("keeps connector reads but removes connector writes from inbound-email automations", async () => {
    const database = new ToolSelectionDatabase(
      [connection(WORKSPACE_CONNECTION_ID, "workspace", null)],
      [
        { capability: "drive.read", connection_id: WORKSPACE_CONNECTION_ID },
        { capability: "docs.read", connection_id: WORKSPACE_CONNECTION_ID },
        { capability: "docs.write", connection_id: WORKSPACE_CONNECTION_ID },
        { capability: "sheets.write", connection_id: WORKSPACE_CONNECTION_ID },
      ],
    );
    const input = workflowInput(SUBSCRIPTION_ID);
    input.reason = "inbound_email";

    const selected = await __integrationTesting.loadHarnessTools(env(database), input);

    expect(googleToolNames(selected.tools)).toEqual([
      "google.drive.search",
      "google.drive.get_metadata",
      "google.drive.download",
      "google.drive.export",
      "google.docs.read_document",
      "google.sheets.read_spreadsheet",
      "google.sheets.read_values",
    ]);
    expect(selected.tools
      .filter((tool) => tool.definition.name.startsWith("google."))
      .every((tool) => tool.definition.mode === "read"))
      .toBe(true);
    expect(selected.modeByTool.has("google.docs.create_document")).toBe(false);
    expect(selected.connectionByTool.has("google.sheets.update_values")).toBe(false);
  });

  it.each([
    {
      authority: "workspace membership",
      revoke: (database: ToolSelectionDatabase, row: ConnectionRow) => {
        database.memberStatus = "removed";
        void row;
      },
      message: "User is not an active workspace member",
    },
    {
      authority: "personal connection ownership",
      revoke: (_database: ToolSelectionDatabase, row: ConnectionRow) => {
        row.owner_user_id = OTHER_USER_ID;
      },
      message: "Connector is no longer healthy or authorized for this run",
    },
    {
      authority: "capability grant",
      revoke: (_database: ToolSelectionDatabase, row: ConnectionRow) => {
        row.granted_scopes_json = "[]";
      },
      message: "Connector capability was revoked",
    },
    {
      authority: "connection health",
      revoke: (_database: ToolSelectionDatabase, row: ConnectionRow) => {
        row.status = "error";
      },
      message: "Connector is no longer healthy or authorized for this run",
    },
  ])("blocks credential access when $authority changes between model selection and tool execution", async ({
    revoke,
    message,
  }) => {
    const row = connection(OWNER_CONNECTION_ID, "personal", USER_ID, ["drive.read"]);
    // Deliberately invalid ciphertext: reaching decryption would produce a
    // crypto failure instead of the member-safe authorization failure below.
    row.encrypted_credentials = "credential-ciphertext-must-not-be-read";
    row.credential_iv = "credential-iv-must-not-be-read";
    const database = new ToolSelectionDatabase([row]);
    const providerFetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", providerFetch);
    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());
    const plugin = selected.plugins[0]!;
    const wireToolName = "google_drive_search";
    const events: HarnessEvent[] = [];
    let modelTurn = 0;
    const modelFetch = vi.fn<typeof globalThis.fetch>(async () => {
      modelTurn += 1;
      if (modelTurn === 1) {
        // The run scope and active plugin were already authorized before this
        // response. Mutating now proves the tool boundary independently checks
        // the durable authority before credentials can be decrypted.
        revoke(database, row);
        return authorityStreamResponse([{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "provider-authority-read",
                type: "function",
                function: { name: wireToolName, arguments: JSON.stringify({ query: "quarterly plan" }) },
              }],
            },
            finish_reason: "tool_calls",
          }],
        }]);
      }
      return authorityStreamResponse([{
        choices: [{ delta: { content: "Authorization changed; tool was not executed." }, finish_reason: "stop" }],
      }]);
    });

    const outcome = await runHarness({
      config: {
        apiKey: "test-key",
        primaryModel: "google/gemini-2.5-flash-lite",
        fetch: modelFetch,
        maxIterations: 3,
        maxToolCalls: 2,
        maxWallClockMs: 1_000,
        toolTimeoutMs: 100,
        maxWebResults: 4,
      },
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      harnessRunId: HARNESS_RUN_ID,
      executionPrincipal: { type: "user", userId: USER_ID },
      systemPrompt: "Use only currently authorized connector tools.",
      messages: [{ role: "user", content: "Search my Drive." }],
      corePlugins: [],
      plugins: selected.plugins,
      activationHints: [plugin.canonicalId],
      // Connector execution performs the authoritative database check. This
      // callback remains true so Bind keeps the frozen plugin active long
      // enough to exercise that exact boundary.
      reauthorizePlugin: () => true,
      onEvent: (event) => { events.push(event); },
    });

    expect(outcome).toMatchObject({
      status: "completed",
      content: "Authorization changed; tool was not executed.",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_failed",
      pluginId: plugin.canonicalId,
      error: message,
      phase: "execution",
      outcome: "definitive_failure",
    }));
    expect(events.some((event) => event.type === "tool_completed")).toBe(false);
    expect(providerFetch).not.toHaveBeenCalled();
  });
});

function authorityStreamResponse(events: unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
