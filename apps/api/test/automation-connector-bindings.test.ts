import { asUserId, asWorkspaceId } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/env";
import { AutomationService } from "../src/services/automation-service";
import { createTestEnv } from "./helpers/cloudflare-test";

const auth: AuthContext = {
  sessionId: "session-1",
  userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904"),
  workspaceId: asWorkspaceId("668953d2-25f2-44fd-8d72-1e8cf024a277"),
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
      requestedDelivery: [],
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
  it("does not revalidate grandfathered slotless activity metadata during instruction edits", async () => {
    const row = {
      id: "automation-1",
      workspace_id: "668953d2-25f2-44fd-8d72-1e8cf024a277",
      scope: "personal",
      owner_user_id: "d6d77053-92bc-4af6-8332-8bea8c4c6904",
      template_id: "template-1",
      template_version_id: "version-1",
      template_owner_user_id: "d6d77053-92bc-4af6-8332-8bea8c4c6904",
      latest_version_number: 1,
      overview: "Legacy automation",
      instructions: "Old instructions",
      trigger_definitions_json: JSON.stringify([{
        type: "connector_activity",
        connectorType: "github",
        eventTypes: ["legacy.provider.event"],
        deterministicFilters: { legacyMetadata: "kept" },
      }]),
      required_capabilities_json: "[]",
      expected_outputs_json: "[]",
      default_behavior_json: "{}",
      recommended_plugins_json: "[]",
      memory_tables_json: "[]",
      default_plugins_json: "[]",
      activity_trigger_bindings_json: "{}",
    };
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => sql.includes("FROM automation_subscriptions s JOIN automation_templates") ? row : null),
      })),
    }));
    const batch = vi.fn(async () => []);
    const service = new AutomationService(createTestEnv({ DB: { prepare, batch } }), auth);
    vi.spyOn(service, "get").mockResolvedValue({ id: "automation-1" } as never);

    await expect(service.update("automation-1", {
      instructions: "New instructions",
      activitySourcePluginIds: {},
    })).resolves.toEqual({ id: "automation-1" });
    expect(batch).toHaveBeenCalledOnce();
    expect(prepare.mock.calls.some(([sql]) => String(sql).includes("FROM connector_connections"))).toBe(false);
  });

  it("rejects an activity trigger with no selected connector", async () => {
    const prepare = vi.fn();
    const service = new AutomationService(createTestEnv({ DB: { prepare } }), auth);

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
    const service = new AutomationService(createTestEnv({ DB: { prepare } }), auth);

    await expect(service.create(createInput({
      type: "semantic_activity",
      connectorType: "linear",
      deterministicPrefilter: {},
      condition: "A priority issue is blocked",
    }, ["plugin_github"]))).rejects.toMatchObject({
      status: 422,
      code: "activity_trigger_connection_required",
    });
    expect(bind).toHaveBeenCalledWith("668953d2-25f2-44fd-8d72-1e8cf024a277", "plugin_github");
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
    const env = createTestEnv({
      DB: { prepare },
      PUBLIC_API_BASE_URL: "https://api.example.com",
      GOOGLE_CONNECTOR_OAUTH_CLIENT_ID: "client",
      GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET: "secret",
    });
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
    expect(bind).toHaveBeenCalledWith("668953d2-25f2-44fd-8d72-1e8cf024a277", "plugin_google");
  });

  it("requires source-bound semantic triggers to declare one exact event", async () => {
    const first = vi.fn().mockResolvedValue({
      id: "connection-google",
      connector_type: "google",
      scope: "personal",
      owner_user_id: "d6d77053-92bc-4af6-8332-8bea8c4c6904",
      status: "healthy",
    });
    const bind = vi.fn(() => ({ first }));
    const service = new AutomationService(createTestEnv({
      DB: { prepare: vi.fn(() => ({ bind })) },
      PUBLIC_API_BASE_URL: "https://api.example.com",
      GOOGLE_CONNECTOR_OAUTH_CLIENT_ID: "client",
      GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET: "secret",
    }), auth);

    await expect(service.create(createInput({
      type: "semantic_activity",
      connectorType: "google",
      sourceBindingKey: "google_source",
      suggestedSourcePluginId: "plugin_google",
      deterministicPrefilter: {},
      condition: "The activity needs attention.",
    }, [], { google_source: "plugin_google" }))).rejects.toMatchObject({
      status: 422,
      code: "activity_trigger_event_required",
    });
  });
});
