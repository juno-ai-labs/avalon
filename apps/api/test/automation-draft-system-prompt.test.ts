import { renderWorkstreamSystemPrompt } from "@avalon/agent-harness";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env, HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { automationRoutes } from "../src/routes/automations";
import { renderAutomationDraftSystemPrompt } from "../src/services/automation-draft-system-prompt";

const draft = {
  name: "Deployment failure monitor",
  description: "Alert on repeated deployment failures.",
  overview: "Watches deployment workflow runs on main.",
  instructions: "Track consecutive failures per deployment workflow and alert after more than two in a row.",
  triggers: [{
    type: "connector_activity" as const,
    connectorType: "github",
    sourceBindingKey: "github",
    suggestedSourcePluginId: "plugin_github",
    eventTypes: ["github.workflow_run.completed"],
    deterministicFilters: { branch: "main" },
  }],
  requiredCapabilities: [],
  expectedOutputs: ["A Slack alert in #general"],
  defaultBehavior: { channel: "#general" },
  recommendedPlugins: [],
  memoryTables: [{
    name: "deployment_failures",
    description: "Consecutive failures per deployment workflow.",
    usageInstructions: "Read the row before alerting, then write the new count.",
    columns: [
      { name: "workflow", description: "The workflow name.", type: "string" as const, required: true, searchable: true },
      { name: "failures", description: "Consecutive failures.", type: "integer" as const, required: true, searchable: false },
    ],
    keyColumns: ["workflow"],
  }],
  suggestedScope: "personal" as const,
  followUpQuestion: null,
  elicitation: null,
  ready: true,
};

function testApp(): Hono<HonoAppEnv> {
  const app = new Hono<HonoAppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "request-system-prompt-1");
    c.set("auth", {
      sessionId: "session-1",
      userId: "00000000-0000-7000-8000-000000000001",
      workspaceId: "00000000-0000-7000-8000-000000000002",
      region: "global",
      role: "owner",
    });
    await next();
  });
  app.route("/automations", automationRoutes);
  // The same handler the Worker mounts, so a rejected body is asserted at the
  // status a caller would actually see rather than as an unhandled throw.
  app.onError(errorHandler);
  return app;
}

afterEach(() => vi.restoreAllMocks());

describe("automation draft system prompt", () => {
  it("renders the prompt a run would start from, from the values creation would persist", () => {
    const prompt = renderAutomationDraftSystemPrompt({ draft, scope: "personal" });
    const context = JSON.parse(prompt.slice(prompt.indexOf("{"))) as Record<string, unknown>;

    // The run's work stream takes its title and objective from the automation,
    // and a new automation is created at version 1 with no overrides.
    expect(context).toMatchObject({
      workstream: { title: draft.name, objective: draft.description },
      executionAuthority: "user",
      automation: {
        name: draft.name,
        versionNumber: 1,
        instructions: draft.instructions,
        expectedOutputs: draft.expectedOutputs,
        defaultBehavior: draft.defaultBehavior,
        overrides: {},
      },
    });
    // The policy above the context is the same text a run receives, not a copy.
    expect(prompt.startsWith(renderWorkstreamSystemPrompt({ title: "x", objective: "y" }).split("\n\n# Authorized task context")[0]!)).toBe(true);
  });

  it("names the durable tables without inventing identifiers they do not have yet", () => {
    const prompt = renderAutomationDraftSystemPrompt({ draft, scope: "personal" });
    const context = JSON.parse(prompt.slice(prompt.indexOf("{"))) as {
      automation: { durableTables: Array<{ memoryTableId: string; name: string; keyColumns: string[]; columns: Array<{ memoryTableColumnId: string; name: string }> }> };
    };
    const [table] = context.automation.durableTables;

    expect(table).toMatchObject({ name: "deployment_failures", scopeKind: "automation", keyColumns: ["workflow"] });
    expect(table!.columns.map((column) => column.name)).toEqual(["workflow", "failures"]);
    // A minted-looking id would be a value someone could try to look up, and a
    // fresh one per request would change the prompt on every open.
    expect(table!.memoryTableId).toBe("(assigned when this automation is created)");
    expect(table!.columns.every((column) => column.memoryTableColumnId === "(assigned when this automation is created)")).toBe(true);
    expect(renderAutomationDraftSystemPrompt({ draft, scope: "personal" })).toBe(prompt);
  });

  it("follows Runs as, so the workspace-authority policy appears only for a workspace automation", () => {
    expect(renderAutomationDraftSystemPrompt({ draft, scope: "personal" }))
      .not.toContain("# Workspace execution authority");
    const workspacePrompt = renderAutomationDraftSystemPrompt({ draft, scope: "workspace" });
    expect(workspacePrompt).toContain("# Workspace execution authority");
    expect(workspacePrompt).toContain('"executionAuthority": "workspace"');
  });

  it("serves the prompt over the route without reading or writing anything", async () => {
    const response = await testApp().request("/automations/draft/system-prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft, scope: "personal" }),
      // No `env` is passed: a preview that touched D1 would fail here.
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      systemPrompt: renderAutomationDraftSystemPrompt({ draft, scope: "personal" }),
    });
  });

  it("refuses a draft that is not a draft", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await testApp().request(
      "/automations/draft/system-prompt",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft: { ...draft, instructions: "" }, scope: "personal" }),
      },
      // Only the error handler's logger reads it; the route itself never does.
      {} as Env,
    );

    expect(response.status).toBe(400);
    expect(consoleWarn).toHaveBeenCalled();
  });
});
