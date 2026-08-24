import { asUserId, asWorkspaceId } from "@rally/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/env";
import type * as IntegrationsModule from "../src/services/integrations";

const compileAutomationDraft = vi.hoisted(() => vi.fn());

vi.mock("../src/services/integrations", async (importOriginal) => ({
  ...await importOriginal<typeof IntegrationsModule>(),
  compileAutomationDraft,
}));

import { AutomationService } from "../src/services/automation-service";
import { createTestEnv } from "./helpers/cloudflare-test";

const auth: AuthContext = {
  sessionId: "session-1",
  userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904"),
  workspaceId: asWorkspaceId("668953d2-25f2-44fd-8d72-1e8cf024a277"),
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
      followUpQuestion: null,
      elicitation: null,
      ready: true,
    });
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => sql.includes("AS user_timezone")
          ? { user_timezone: "America/Los_Angeles", workspace_timezone: "UTC" }
          : null),
      })),
    }));
    const batch = vi.fn(async () => []);
    const service = new AutomationService(createTestEnv({ DB: { prepare, batch } }), auth);

    const result = await service.compile({
      messages: [{ role: "user", content: "When a GitHub issue opens, prepare a response." }],
    }, "request-1");

    expect(result.draft).toMatchObject({
      ready: false,
      elicitation: null,
      followUpQuestion: expect.stringContaining("unavailable"),
    });
    // The turn is still a draft worth keeping: the source could not be bound,
    // which is the very thing the person comes back to the conversation to fix.
    expect(prepare.mock.calls.map(([sql]) => sql).join("\n")).toContain("INSERT INTO automation_subscriptions");
    expect(batch).toHaveBeenCalledOnce();
  });
});
