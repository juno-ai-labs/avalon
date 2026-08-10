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
  activitySourcePluginIds: Record<string, string> = {},
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
    activitySourcePluginIds,
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

  it("rejects invented events and undeclared filters for an exact source slot", async () => {
    const first = vi.fn().mockResolvedValue({
      id: "connection-google",
      connector_type: "google",
      scope: "workspace",
      owner_user_id: null,
      status: "healthy",
    });
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const env = {
      DB: { prepare },
      PUBLIC_API_BASE_URL: "https://api.example.com",
      GOOGLE_CONNECTOR_OAUTH_CLIENT_ID: "client",
      GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET: "secret",
    } as unknown as Env;
    const service = new AutomationService(env, auth);
    const baseTrigger = {
      type: "connector_activity" as const,
      connectorType: "google",
      sourceBindingKey: "google_source",
      suggestedSourcePluginId: "plugin_google",
      deterministicFilters: {},
    };

    await expect(service.create(createInput({
      ...baseTrigger,
      eventTypes: ["drive.file_teleported"],
    }, [], { google_source: "plugin_google" }))).rejects.toMatchObject({
      status: 422,
      code: "unknown_activity_event",
    });

    await expect(service.create(createInput({
      ...baseTrigger,
      eventTypes: ["drive.file_changed"],
      deterministicFilters: { unsupported: true },
    }, [], { google_source: "plugin_google" }))).rejects.toMatchObject({
      status: 422,
      code: "invalid_activity_filter",
    });
    expect(bind).toHaveBeenCalledWith("workspace-1", "plugin_google");
  });
});
