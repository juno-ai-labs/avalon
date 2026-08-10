import { describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { AutomationService } from "../src/services/automation-service";

const auth: AuthContext = {
  sessionId: "session-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  region: "global",
  role: "member",
};

function createInput(
  trigger: Parameters<AutomationService["create"]>[0]["draft"]["triggers"][number],
  defaultPluginIds: string[],
): Parameters<AutomationService["create"]>[0] {
  return {
    draft: {
      name: "Activity automation",
      description: "Respond to connected activity.",
      overview: "Watch connected activity and respond.",
      instructions: "Handle matching activity.",
      triggers: [trigger],
      requiredCapabilities: [],
      expectedOutputs: [],
      defaultBehavior: {},
      recommendedPlugins: [],
      memoryTables: [],
      suggestedScope: "personal",
      followUpQuestion: null,
      elicitation: null,
      ready: true,
    },
    scope: "personal",
    defaultPluginIds,
    resourceIds: [],
    deliveryTargets: [],
  };
}

describe("automation activity connector bindings", () => {
  it("rejects an activity trigger with no selected connector", async () => {
    const prepare = vi.fn();
    const service = new AutomationService({ DB: { prepare } } as unknown as Env, auth);

    await expect(service.create(createInput({
      type: "connector_activity",
      connectorType: "github",
      eventTypes: ["pull_request.updated"],
      deterministicFilters: {},
    }, []))).rejects.toMatchObject({
      status: 422,
      code: "activity_trigger_connection_required",
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects an activity trigger bound only to a different connector type", async () => {
    const first = vi.fn().mockResolvedValue({
      id: "connection-github",
      connector_type: "github",
      scope: "workspace",
      owner_user_id: null,
      status: "healthy",
    });
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const service = new AutomationService({ DB: { prepare } } as unknown as Env, auth);

    await expect(service.create(createInput({
      type: "semantic_activity",
      connectorType: "linear",
      deterministicPrefilter: {},
      condition: "A priority issue is blocked",
    }, ["plugin_github"]))).rejects.toMatchObject({
      status: 422,
      code: "activity_trigger_connection_required",
    });
    expect(bind).toHaveBeenCalledWith("workspace-1", "plugin_github");
  });
});
