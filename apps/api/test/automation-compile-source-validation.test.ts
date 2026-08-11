import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import type * as IntegrationsModule from "../src/services/integrations";

const compileAutomationDraft = vi.hoisted(() => vi.fn());

vi.mock("../src/services/integrations", async (importOriginal) => ({
  ...await importOriginal<typeof IntegrationsModule>(),
  compileAutomationDraft,
}));

import { AutomationService } from "../src/services/automation-service";

const auth: AuthContext = {
  sessionId: "session-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  region: "global",
  role: "member",
};

describe("automation compile activity-source validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("turns an unavailable model-suggested source into a follow-up draft", async () => {
    compileAutomationDraft.mockResolvedValue({
      name: "GitHub follow-up",
      description: "Respond when an issue opens.",
      overview: "Starts from new GitHub issues.",
      instructions: "Review the issue and prepare a response.",
      triggers: [{
        type: "connector_activity",
        connectorType: "github",
        sourceBindingKey: "github_source",
        suggestedSourcePluginId: "plugin_github_unhealthy",
        eventTypes: ["github.issue.opened"],
        deterministicFilters: { repository: "acme/widget" },
      }],
      requiredCapabilities: [],
      expectedOutputs: [],
      defaultBehavior: {},
      recommendedPlugins: [],
      memoryTables: [],
      suggestedScope: "personal",
      suggestedDelivery: "avalon_only" as const,
      followUpQuestion: null,
      elicitation: null,
      ready: true,
    });
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => sql.includes("FROM users u JOIN workspaces")
          ? { user_timezone: "America/Los_Angeles", workspace_timezone: "UTC" }
          : null),
      })),
    }));
    const service = new AutomationService({ DB: { prepare } } as unknown as Env, auth);

    const result = await service.compile({
      messages: [{ role: "user", content: "When a GitHub issue opens, prepare a response." }],
    }, "request-1");

    expect(result).toMatchObject({
      ready: false,
      elicitation: null,
      followUpQuestion: expect.stringContaining("unavailable or unhealthy"),
    });
  });
});
