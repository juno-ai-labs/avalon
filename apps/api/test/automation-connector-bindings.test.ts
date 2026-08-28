import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { AutomationDraft } from "@rally/contracts";
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

/**
 * A publishable recipe carrying one trigger.
 *
 * Publishing is the surviving path through the activity-binding
 * validators — AutomationAgent owns creating and editing an automation —
 * and it derives its source selection from each trigger's
 * `suggestedSourcePluginId`, so the slot is bound by the draft rather
 * than by a separate argument.
 */
function publishInput(trigger: AutomationDraft["triggers"][number]): {
  name: string;
  description: string;
  draft: AutomationDraft;
} {
  return {
    name: "Activity automation",
    description: "Respond to connected activity.",
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
  };
}

describe("automation activity connector bindings", () => {
  it("rejects invented events and undeclared filters for an exact source slot", async () => {
    const first = vi.fn().mockResolvedValue({
      id: "connection-google",
      connector_type: "google",
      scope: "personal",
      owner_user_id: "d6d77053-92bc-4af6-8332-8bea8c4c6904",
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

    await expect(service.publishTemplate(publishInput({
      ...baseTrigger,
      eventTypes: ["drive.file_teleported"],
    }))).rejects.toMatchObject({
      status: 422,
      code: "unknown_activity_event",
    });

    await expect(service.publishTemplate(publishInput({
      ...baseTrigger,
      eventTypes: ["drive.file_changed"],
      deterministicFilters: { unsupported: true },
    }))).rejects.toMatchObject({
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

    await expect(service.publishTemplate(publishInput({
      type: "semantic_activity",
      connectorType: "google",
      sourceBindingKey: "google_source",
      suggestedSourcePluginId: "plugin_google",
      deterministicPrefilter: {},
      condition: "The activity needs attention.",
    }))).rejects.toMatchObject({
      status: 422,
      code: "activity_trigger_event_required",
    });
  });
});
