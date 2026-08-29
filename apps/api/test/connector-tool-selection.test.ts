import { asHarnessRunId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import { runHarness, type HarnessEvent } from "@rally/agent-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { __integrationTesting } from "../src/services/integrations";
import { createMemoryTableTools } from "../src/services/memory-table-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";
import {
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
} from "./helpers/durable-authority";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000001");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-4000-8000-000000000002");
const HARNESS_RUN_ID = asHarnessRunId("00000000-0000-4000-8000-000000000003");
const USER_ID = asUserId("00000000-0000-4000-8000-000000000004");
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000005";
const WORKSPACE_CONNECTION_ID = "00000000-0000-4000-8000-000000000006";
const OWNER_CONNECTION_ID = "00000000-0000-4000-8000-000000000007";
const OTHER_CONNECTION_ID = "00000000-0000-4000-8000-000000000008";
const SUBSCRIPTION_ID = "00000000-0000-4000-8000-000000000009";
const CHILD_HARNESS_RUN_ID = asHarnessRunId("00000000-0000-4000-8000-000000000012");

const GOOGLE_WORKSPACE_CAPABILITIES = [
  "drive.read",
  "docs.read",
  "docs.write",
  "sheets.read",
  "sheets.write",
] as const;

const GOOGLE_WORKSPACE_TOOLS = [
  "drive.search",
  "drive.get_metadata",
  "drive.download",
  "drive.export",
  "docs.read_document",
  "docs.create_document",
  "docs.append_text",
  "docs.replace_text",
  "sheets.read_spreadsheet",
  "sheets.read_values",
  "sheets.create_spreadsheet",
  "sheets.update_values",
  "sheets.append_values",
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
  connector_type: "google";
  scope: "personal" | "workspace";
  owner_user_id: string | null;
  granted_scopes_json: string;
  status: "healthy" | "error" | "needs_reconnect" | "disabled";
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
      const base = "plugin_google";
      const key = `${row.workspace_id}:${base}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      row.model_plugin_id ??= count === 1 ? base : `${base}_${count}`;
      return row;
    });
    this.binding = createTestD1Database({
      prepare: (sql: string) => createTestD1PreparedStatement(new ToolSelectionStatement(this, sql)),
    });
    // Which resources this work stream has attached is the object's answer now,
    // and which connection owns each of them is the workspace's. The fixture
    // still names connections, because that is what these tests are about; one
    // attached resource stands for each, seeded where the port will read it.
    seedWorkstreamObjectRoot(this.objectStore, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    });
    for (const connectionId of this.attachedConnectionIds) {
      this.objectStore.prepare(
        `INSERT INTO workstream_resource_links
           (resource_id, attached_by_user_id, watch_enabled, relationship_type,
            resource_json, attached_at, updated_at)
         VALUES (?, NULL, 0, 'attachment', '{}', 1, 1)`,
      ).run(resourceFor(connectionId));
    }
  }

  readonly objectStore = testWorkstreamObjectStore();
  readonly agents = testSubstreamAgentsBinding(this.objectStore);
}

/** The one resource standing in for an attached connection. */
function resourceFor(connectionId: string): string {
  return `resource-for-${connectionId}`;
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
    } else if (sql.includes("SELECT DISTINCT connection_id FROM resources")) {
      const requested = new Set(this.values.slice(1).map(String));
      results = this.database.attachedConnectionIds
        .filter((connectionId) => requested.has(resourceFor(connectionId)))
        .map((connection_id) => ({ connection_id }));
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
    return createTestD1Result<T>({ success: true, results });
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
): ConnectionRow {
  return {
    id,
    workspace_id: workspaceId,
    connector_type: "google",
    scope,
    owner_user_id: ownerUserId,
    granted_scopes_json: JSON.stringify(capabilities),
    cursor_json: "{}",
    config_json: "{}",
    status: "healthy",
    created_at: createdAt,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function env(database: ToolSelectionDatabase): Env {
  return createTestEnv({
    DB: database.binding,
    SUBSTREAM_AGENTS: database.agents,
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    GOOGLE_CONNECTOR_OAUTH_CLIENT_ID: "google-connector-client",
    GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET: "google-connector-secret",
    CONNECTOR_CREDENTIALS_KEY: "must-not-be-used-after-revocation",
    AVALON_REGION: "global",
  });
}

function workflowInput(automationSubscriptionId: string | null = null): WorkstreamWorkflowInput {
  return {
    region: "global",
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    loopId: `workstream:${WORKSTREAM_ID}:substream:0:loop`,
    harnessRunId: HARNESS_RUN_ID,
    triggerMessageId: null,
    automationSubscriptionId,
    activityId: null,
    executionPrincipal: { type: "user", userId: USER_ID },
    reason: automationSubscriptionId ? "Automation test" : "Ad-hoc test",
  };
}

/**
 * Check every `<wire name> {json}` call in a plugin message against the input
 * schema of the tool it names, returning one description per mismatch.
 *
 * A worked example is documentation the model executes, so it decays exactly
 * like code and silently: renaming a parameter or a result key leaves the
 * example compiling, passing a substring assertion, and teaching a call that
 * now fails.
 */
function workedExampleCallsAgainstSchemas(
  plugin: {
    modelId: string;
    systemMessage?: string | undefined;
    tools: Awaited<ReturnType<typeof __integrationTesting.loadHarnessTools>>["tools"];
  },
): string[] {
  const { tools } = plugin;
  const systemMessage = plugin.systemMessage ?? "";
  // Derived, not assumed: a second credential of the same provider is
  // `google_2_…`, and hardcoding the first one's prefix made this check
  // silently validate nothing for every plugin but the first.
  const wirePrefix = plugin.modelId.replace(/^plugin_/u, "");
  const schemas = new Map(tools.map((tool) => {
    const schema = tool.definition.inputSchema as { properties?: Record<string, unknown> };
    return [
      `${wirePrefix}_${tool.definition.name.replace(".", "_")}`,
      new Set(Object.keys(schema.properties ?? {})),
    ];
  }));
  const problems: string[] = [];
  let found = 0;
  for (const match of systemMessage.matchAll(/`(google[a-z0-9_]*) (\{.*?\})`/gu)) {
    const [, wireName, json] = match;
    const properties = schemas.get(wireName!);
    if (!properties) {
      problems.push(`${wireName} is not a tool on this plugin`);
      continue;
    }
    found += 1;
    for (const key of Object.keys(JSON.parse(json!) as Record<string, unknown>)) {
      if (!properties.has(key)) problems.push(`${wireName} has no ${key} parameter`);
    }
  }
  if (found === 0) problems.push("no worked example calls were found to check");
  return problems;
}

function googleToolNames(tools: Awaited<ReturnType<typeof __integrationTesting.loadHarnessTools>>["tools"]): string[] {
  return tools
    .map((tool) => tool.definition.name)
    .filter((name) => (GOOGLE_WORKSPACE_TOOLS as readonly string[]).includes(name));
}

function pluginConnectionIds(
  selected: Awaited<ReturnType<typeof __integrationTesting.loadHarnessTools>>,
): string[] {
  return selected.plugins
    .filter((plugin) => plugin.canonicalId.startsWith("connection:"))
    .map((plugin) => plugin.canonicalId.slice("connection:".length));
}

function childWorkflowInput(parent = workflowInput()): WorkstreamWorkflowInput {
  return {
    ...parent,
    harnessRunId: CHILD_HARNESS_RUN_ID,
    reason: "sub_agent",
  };
}

describe("connector tools selected for harness runs", () => {
  it("resolves durable receipt policy from canonical identity, never a provider wire alias", async () => {
    const database = new ToolSelectionDatabase([
      connection(WORKSPACE_CONNECTION_ID, "workspace", null),
    ]);
    const selected = await __integrationTesting.loadHarnessTools(createTestEnv({
      ...env(database),
      FIRECRAWL_API_KEY: "firecrawl-test-key",
    }), workflowInput());

    const listPolicy = __integrationTesting.resolveHarnessToolReceiptPolicy({
      pluginId: "rally:discovery",
      canonicalToolName: "list_plugins",
      capability: "rally.plugins.list",
      mode: "read",
      idempotency: "safe",
    }, selected);
    const loadPolicy = __integrationTesting.resolveHarnessToolReceiptPolicy({
      pluginId: "rally:discovery",
      canonicalToolName: "load_plugin",
      capability: "rally.plugins.load",
      mode: "read",
      idempotency: "safe",
    }, selected);
    const timePolicy = __integrationTesting.resolveHarnessToolReceiptPolicy({
      pluginId: "rally:core",
      canonicalToolName: "current_time",
      capability: "time.read",
      mode: "read",
      idempotency: "safe",
    }, selected);
    const workstreamPolicy = __integrationTesting.resolveHarnessToolReceiptPolicy({
      pluginId: "rally:workstream",
      canonicalToolName: "list_resources",
      capability: "workstream.resources.list",
      mode: "read",
      idempotency: "safe",
    }, selected);
    const webPolicy = __integrationTesting.resolveHarnessToolReceiptPolicy({
      pluginId: "rally:web",
      canonicalToolName: "search",
      capability: "web.search",
      mode: "read",
      idempotency: "safe",
    }, selected);
    const googlePluginId = `connection:${WORKSPACE_CONNECTION_ID}`;
    const googlePolicy = __integrationTesting.resolveHarnessToolReceiptPolicy({
      pluginId: googlePluginId,
      canonicalToolName: "drive.search",
      capability: "drive.read",
      mode: "read",
      idempotency: "safe",
    }, selected);

    expect(listPolicy).toMatchObject({ connectionId: null, definition: { mode: "read", idempotency: "safe" } });
    expect(loadPolicy).toMatchObject({ connectionId: null, definition: { mode: "read", idempotency: "safe" } });
    expect(timePolicy).toMatchObject({ connectionId: null, definition: { mode: "read", idempotency: "safe" } });
    expect(workstreamPolicy).toMatchObject({
      pluginId: "rally:workstream",
      connectionId: null,
      toolSurfaceHash: expect.any(String),
      definition: { name: "list_resources", mode: "read", idempotency: "safe" },
    });
    expect(webPolicy).toMatchObject({
      pluginId: "rally:web",
      connectionId: null,
      toolSurfaceHash: expect.any(String),
      definition: { name: "search", mode: "read", idempotency: "safe" },
    });
    expect(googlePolicy).toMatchObject({
      pluginId: googlePluginId,
      connectionId: WORKSPACE_CONNECTION_ID,
      definition: { name: "drive.search", mode: "read", idempotency: "safe" },
      legacyReceiptIdentity: {
        canonicalToolName: "google.drive.search",
        toolSurfaceHash: expect.any(String),
      },
    });
    expect(__integrationTesting.storedToolPolicyMatches(JSON.stringify({
      pluginId: googlePolicy.pluginId,
      canonicalToolName: googlePolicy.definition.name,
      capability: googlePolicy.definition.capability,
      mode: googlePolicy.definition.mode,
      idempotency: googlePolicy.definition.idempotency,
      connectionId: googlePolicy.connectionId,
      toolSurfaceHash: googlePolicy.toolSurfaceHash,
    }), googlePolicy)).toBe(true);
    expect(__integrationTesting.storedToolPolicyMatches(JSON.stringify({
      pluginId: googlePolicy.pluginId,
      canonicalToolName: googlePolicy.legacyReceiptIdentity?.canonicalToolName,
      capability: googlePolicy.definition.capability,
      mode: googlePolicy.definition.mode,
      idempotency: googlePolicy.definition.idempotency,
      connectionId: googlePolicy.connectionId,
      toolSurfaceHash: googlePolicy.legacyReceiptIdentity?.toolSurfaceHash,
    }), googlePolicy)).toBe(true);
    expect(__integrationTesting.storedToolPolicyMatches(JSON.stringify({
      pluginId: googlePolicy.pluginId,
      canonicalToolName: googlePolicy.legacyReceiptIdentity?.canonicalToolName,
      capability: googlePolicy.definition.capability,
      mode: googlePolicy.definition.mode,
      idempotency: googlePolicy.definition.idempotency,
      connectionId: googlePolicy.connectionId,
      toolSurfaceHash: googlePolicy.toolSurfaceHash,
    }), googlePolicy)).toBe(false);
    expect(__integrationTesting.storedToolPolicyMatches(JSON.stringify({
      pluginId: googlePolicy.pluginId,
      canonicalToolName: googlePolicy.definition.name,
      capability: googlePolicy.definition.capability,
      mode: "write",
      idempotency: "record_before_execute",
      connectionId: googlePolicy.connectionId,
      toolSurfaceHash: googlePolicy.toolSurfaceHash,
    }), googlePolicy)).toBe(false);
    expect(() => __integrationTesting.resolveHarnessToolReceiptPolicy({
      pluginId: googlePluginId,
      canonicalToolName: "drive.search",
      capability: "drive.read",
      mode: "write",
      idempotency: "record_before_execute",
    }, selected)).toThrow("outside this run scope");
  });

  it("installs one durable read-only sub-agent tool into the root core surface", async () => {
    const database = new ToolSelectionDatabase([]);
    const parentInput = workflowInput();
    const selected = await __integrationTesting.loadHarnessTools(env(database), parentInput);

    const tool = await __integrationTesting.installInlineChildAgentTool({
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
      name: "run_subagent",
      capability: "subagent.run",
      mode: "read",
      idempotency: "safe",
    });
    expect(selected.coreTools.filter(({ definition }) =>
      definition.name === "run_subagent"
    )).toHaveLength(1);
    expect(selected.corePlugins.map((plugin) => plugin.canonicalId)).toEqual([
      "rally:core",
      "rally:tables",
      "rally:memory",
    ]);
    expect(selected.corePlugins.find((plugin) => plugin.canonicalId === "rally:core")
      ?.tools.map(({ definition }) => definition.name)).toEqual([
        "current_time",
        "request_elicitation",
      ]);
    expect(selected.plugins.find((plugin) =>
      plugin.canonicalId === "rally:workstream"
    )?.tools.filter(({ definition }) => definition.name === "run_subagent")).toHaveLength(1);
    expect(selected.plugins.find((plugin) =>
      plugin.canonicalId === "rally:workstream"
    )).toMatchObject({
      modelId: "rally_workstream",
      shortWireName: "workstream",
      preload: true,
      explicit: true,
    });
    expect(selected.plugins.find((plugin) =>
      plugin.canonicalId === "rally:workstream"
    )?.tools.map(({ definition }) => definition.name)).toEqual(expect.arrayContaining([
      "list_resources",
      "read_resource",
      "search_resource",
      "run_subagent",
    ]));
    expect(selected.tools.filter(({ definition }) =>
      definition.name === "run_subagent"
    )).toHaveLength(1);
    expect(selected.modeByTool.get("workstream_run_subagent")).toBe("read");
    expect(selected.idempotencyByTool.get("workstream_run_subagent")).toBe("safe");
  });

  it("builds a non-recursive read-only child surface from only inherited active plugins", async () => {
    const database = new ToolSelectionDatabase([
      connection(WORKSPACE_CONNECTION_ID, "workspace", null),
      connection(OWNER_CONNECTION_ID, "personal", USER_ID),
    ]);
    const parentInput = workflowInput();
    const runtimeEnv = createTestEnv({
      ...env(database),
      FIRECRAWL_API_KEY: "firecrawl-test-key",
    });
    const parentTools = await __integrationTesting.loadHarnessTools(runtimeEnv, parentInput);
    expect(parentTools.plugins).toHaveLength(4);
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
      "rally:workstream",
      "rally:web",
      `connection:${WORKSPACE_CONNECTION_ID}`,
    ]);
    expect(childTools.plugins[0]).toMatchObject({ preload: true, explicit: true });
    expect(childTools.plugins[1]).toMatchObject({ preload: false, explicit: false });
    expect(childTools.plugins[2]).toMatchObject({ preload: true, explicit: true });
    expect(childTools.tools.every((tool) => tool.definition.mode === "read")).toBe(true);
    expect(childTools.plugins[2]?.tools.map((tool) => tool.definition.name)).toEqual([
      "drive.search",
      "drive.get_metadata",
      "drive.download",
      "drive.export",
      "docs.read_document",
      "sheets.read_spreadsheet",
      "sheets.read_values",
    ]);
    expect(childTools.coreTools.map((tool) => tool.definition.name)).toEqual([
      "list_resources",
      "read_resource",
      "search",
      "fetch",
      "search_resource",
      "view_resource",
      "summarize_resource",
      "current_time",
    ]);
    expect(childTools.coreTools.some((tool) => tool.definition.capability.startsWith("memory.")))
      .toBe(false);
    expect(childTools.corePlugins.map((plugin) => plugin.canonicalId)).toEqual([
      "rally:core",
    ]);
    expect(childTools.tools.map((tool) => tool.definition.name)).not.toContain("run_subagent");
    expect(childTools.frozenConnections.has(`connection:${OWNER_CONNECTION_ID}`)).toBe(false);
    expect(childTools.frozenConnections.has(`connection:${WORKSPACE_CONNECTION_ID}`)).toBe(true);
    expect(__integrationTesting.eligibleConnectionCapabilityMap(
      childTools.plugins,
      childTools.frozenConnections,
    )).toEqual({
      [WORKSPACE_CONNECTION_ID]: childTools.plugins[2]?.tools.map((tool) =>
        tool.definition.capability),
    });
  });

  it("inherits tools committed into a deferred parent plugin after activation", async () => {
    const database = new ToolSelectionDatabase([
      connection(WORKSPACE_CONNECTION_ID, "workspace", null),
    ]);
    const parentInput = workflowInput();
    const runtimeEnv = env(database);
    const parentTools = await __integrationTesting.loadHarnessTools(runtimeEnv, parentInput);
    const pluginId = `connection:${WORKSPACE_CONNECTION_ID}`;
    const parentPlugin = parentTools.plugins.find((plugin) => plugin.canonicalId === pluginId);
    if (!parentPlugin) throw new Error("expected workspace plugin");
    const discoveredReadTool = parentPlugin.tools.find((tool) => tool.definition.name === "drive.search");
    if (!discoveredReadTool) throw new Error("expected a read tool fixture");
    const hostArray = parentPlugin.tools;
    hostArray.splice(0);

    expect(__integrationTesting.installDynamicPluginTools(hostArray, [discoveredReadTool])).toBe(hostArray);
    const childTools = await __integrationTesting.createInlineChildHarnessSurface({
      env: runtimeEnv,
      parentInput,
      childInput: childWorkflowInput(parentInput),
      parentHarnessTools: parentTools,
      selectedPluginIds: [pluginId],
      assertChildOwned: async () => undefined,
    });

    expect(childTools.plugins.find((plugin) => plugin.canonicalId === pluginId)
      ?.tools.map((tool) => tool.definition.name)).toEqual(["drive.search"]);
  });

  it("does not give an inbound-email child an outbound Firecrawl channel", async () => {
    const database = new ToolSelectionDatabase([]);
    const parentInput = workflowInput();
    parentInput.reason = "inbound_email";
    const runtimeEnv = createTestEnv({
      ...env(database),
      FIRECRAWL_API_KEY: "firecrawl-test-key",
    });
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
      "list_resources",
      "read_resource",
      "search_resource",
      "view_resource",
      "summarize_resource",
      "current_time",
    ]);
    expect(childTools.tools.map((tool) => tool.definition.name)).not.toContain("search");
    expect(childTools.tools.map((tool) => tool.definition.name)).not.toContain("fetch");
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
    const tool = await __integrationTesting.installInlineChildAgentTool({
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

  it("exposes every granted read and write tool from a workspace connection to an ad-hoc workstream", async () => {
    const database = new ToolSelectionDatabase([
      connection(WORKSPACE_CONNECTION_ID, "workspace", null),
    ]);

    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());

    expect(googleToolNames(selected.tools)).toEqual(GOOGLE_WORKSPACE_TOOLS);
    expect(new Set(selected.connectionByTool.values())).toEqual(new Set([WORKSPACE_CONNECTION_ID]));
    expect(pluginConnectionIds(selected)).toEqual([WORKSPACE_CONNECTION_ID]);
    expect(selected.plugins.find((plugin) =>
      plugin.canonicalId === `connection:${WORKSPACE_CONNECTION_ID}`
    )?.tools.map((tool) => tool.definition.name)).toEqual(GOOGLE_WORKSPACE_TOOLS);
    expect(selected.modeByTool.get("google_drive_search")).toBe("read");
    expect(selected.modeByTool.get("google_docs_create_document")).toBe("write");
    expect(selected.modeByTool.get("google_sheets_update_values")).toBe("write");
    const tables = __integrationTesting.createWorkstreamCorePlugins(
      createMemoryTableTools(env(database), workflowInput()),
    ).find((plugin) => plugin.canonicalId === "rally:tables");
    expect(tables?.systemMessage).toContain("query those exact row IDs again");
    expect(tables?.systemMessage).toContain("table_insert_rows");
    expect(tables?.systemMessage).not.toMatch(/\binsert_rows\b(?!\s+can)/u);
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
    expect(selected.connectionByTool.get("drive.search")).toBe(OWNER_CONNECTION_ID);
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
    // The plugin message carries only Gmail mechanics; not inventing an address
    // is platform policy and lives in the work-stream system prompt.
    expect(mail?.systemMessage).toContain("Resolve an unknown recipient address");
    expect(mail?.systemMessage).toContain("rather than inferring it from a signature or a header");
    expect(mail?.systemMessage).not.toContain("plausible placeholder");
    // Worked examples name this connection's own tools, and only the ones its
    // grants can actually call.
    expect(mail?.systemMessage).toContain("Worked examples:");
    expect(mail?.systemMessage).toContain("google_gmail_find_contacts {\"name\"");
    expect(mail?.systemMessage).toContain("google_calendar_update_event");
    // Every argument a worked example demonstrates has to exist on the tool it
    // names. Asserting on substrings alone let an example keep teaching
    // `attendeeEmails` after that parameter was removed from the update schema.
    expect(workedExampleCallsAgainstSchemas({
      modelId: mail!.modelId,
      systemMessage: mail!.systemMessage,
      tools: mail!.tools,
    })).toEqual([]);
    expect(mail?.tools.map((tool) => tool.definition.name)).toEqual([
      "gmail.read_profile",
      "gmail.search",
      "gmail.find_contacts",
      "gmail.read_thread",
      "gmail.read_message",
      "gmail.create_draft",
      "gmail.send",
      "calendar.list_calendars",
      "calendar.list_events",
      "calendar.read_event",
      "calendar.create_event",
      "calendar.update_event",
    ]);
    const updateEvent = mail?.tools.find((tool) => tool.definition.name === "calendar.update_event");
    expect(updateEvent?.validateInput?.({ eventId: "event-1" })).toBeInstanceOf(Error);
    expect(updateEvent?.validateInput?.({ eventId: "event-1", summary: "Updated" })).toBeNull();

    // The files plugin's examples are checked against its schemas too, so an
    // example cannot outlive the parameter it demonstrates.
    expect(drive?.systemMessage).toContain("Worked examples:");
    expect(drive?.systemMessage).toContain("writableByRally");
    expect(workedExampleCallsAgainstSchemas({
      modelId: drive!.modelId,
      systemMessage: drive!.systemMessage,
      tools: drive!.tools,
    })).toEqual([]);
    expect(drive).toMatchObject({
      modelId: "plugin_google_2",
      displayName: "Google Drive + Docs + Sheets",
    });
    expect(drive?.description).toContain("file, document, spreadsheet");
    expect(drive?.searchAliases).toEqual(expect.arrayContaining(["drive", "files", "docs", "sheets"]));
    expect(drive?.systemMessage).toContain("use the Drive search tool");
    expect(drive?.systemMessage).toContain("do not substitute public web search");
    expect(drive?.systemMessage).toContain("writableByRally=true");
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
    expect(selected.connectionByTool.get("drive.search")).toBe(WORKSPACE_CONNECTION_ID);
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

    const automationInput = workflowInput(SUBSCRIPTION_ID);
    automationInput.automationRunContext = { defaultPluginIds: ["plugin_google"] } as never;
    const selected = await __integrationTesting.loadHarnessTools(env(database), automationInput);

    expect(googleToolNames(selected.tools)).toEqual(GOOGLE_WORKSPACE_TOOLS);
    expect(new Set(selected.connectionByTool.values())).toEqual(new Set([WORKSPACE_CONNECTION_ID]));
    expect(selected.plugins.find((plugin) =>
      plugin.canonicalId === `connection:${WORKSPACE_CONNECTION_ID}`
    )).toMatchObject({
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
    expect(selected.plugins.filter((plugin) => plugin.canonicalId.startsWith("connection:"))).toHaveLength(1);
    expect(selected.plugins.find((plugin) =>
      plugin.canonicalId === `connection:${WORKSPACE_CONNECTION_ID}`
    )).toMatchObject({
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
      "drive.search",
      "drive.get_metadata",
      "drive.download",
      "drive.export",
      "docs.read_document",
      "sheets.read_spreadsheet",
      "sheets.read_values",
    ]);
    expect(selected.tools
      .filter((tool) => (GOOGLE_WORKSPACE_TOOLS as readonly string[]).includes(tool.definition.name))
      .every((tool) => tool.definition.mode === "read"))
      .toBe(true);
    expect(selected.modeByTool.has("google_docs_create_document")).toBe(false);
    expect(selected.connectionByTool.has("google_sheets_update_values")).toBe(false);
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
      message: "Connector is no longer authorized for this run",
    },
    {
      authority: "capability grant",
      revoke: (_database: ToolSelectionDatabase, row: ConnectionRow) => {
        row.granted_scopes_json = "[]";
      },
      message: "Connector capability was revoked",
    },
    {
      // A person disabling a connection mid-run is a decision, and it is the
      // one status value that still closes the door. `error` and
      // `needs_reconnect` no longer do: they are beliefs about a past moment,
      // and the provider is what says whether the credential still works.
      authority: "connection disablement",
      revoke: (_database: ToolSelectionDatabase, row: ConnectionRow) => {
        row.status = "disabled";
      },
      message: "Connector is no longer authorized for this run",
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
    const plugin = selected.plugins.find((candidate) =>
      candidate.canonicalId === `connection:${OWNER_CONNECTION_ID}`
    )!;
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
        // A real Bind run deadline, not a test budget — wide so a starved
        // scheduler cannot abort the scripted run (see
        // model-protocol-transcript.test.ts for the incident shape).
        maxWallClockMs: 10_000,
        toolTimeoutMs: 100,
        maxWebResults: 4,
      },
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      loopId: `workstream:${WORKSTREAM_ID}:substream:0:loop`,
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
      reauthorizePlugin: () => "authorized",
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
