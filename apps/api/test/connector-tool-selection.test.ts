import type { WorkstreamWorkflowInput } from "@avalon/contracts";
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

interface ConnectionRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  connector_type: "google" | "web_monitor";
  scope: "personal" | "workspace";
  owner_user_id: string | null;
  granted_scopes_json: string;
  status: "healthy";
  created_at: string;
}

class ToolSelectionDatabase {
  readonly binding: D1Database;

  constructor(
    readonly connections: ConnectionRow[],
    readonly automationBindings: Array<{ capability: string; connection_id: string }> = [],
    readonly attachedConnectionIds: string[] = [],
  ) {
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
      expect(this.values).toEqual([WORKSPACE_ID]);
      results = this.database.connections;
    } else {
      throw new Error(`Unexpected tool-selection query: ${sql}`);
    }
    return { success: true, results } as unknown as D1Result<T>;
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
  return {
    DB: database.binding,
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    GOOGLE_OAUTH_CLIENT_ID: "google-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
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

describe("connector tools selected for harness runs", () => {
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
      { url: "https://example.com/workspace-fixture" },
      {
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        harnessRunId: HARNESS_RUN_ID,
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
    expect([...selected.connectionByTool.values()]).toEqual(
      Array.from({ length: GOOGLE_WORKSPACE_TOOLS.length }, () => WORKSPACE_CONNECTION_ID),
    );
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

  it("limits automation tools to capabilities explicitly bound to a connection", async () => {
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

    expect(googleToolNames(selected.tools)).toEqual([
      "google.drive.search",
      "google.drive.get_metadata",
      "google.drive.download",
      "google.drive.export",
      "google.docs.create_document",
      "google.docs.append_text",
      "google.docs.replace_text",
    ]);
    expect(googleToolNames(selected.tools)).not.toContain("google.docs.read_document");
    expect(googleToolNames(selected.tools)).not.toContain("google.sheets.read_values");
    expect(new Set(selected.connectionByTool.values())).toEqual(new Set([WORKSPACE_CONNECTION_ID]));
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
    ]);
    expect(selected.tools
      .filter((tool) => tool.definition.name.startsWith("google."))
      .every((tool) => tool.definition.mode === "read"))
      .toBe(true);
    expect(selected.modeByTool.has("google.docs.create_document")).toBe(false);
    expect(selected.connectionByTool.has("google.sheets.update_values")).toBe(false);
  });
});
