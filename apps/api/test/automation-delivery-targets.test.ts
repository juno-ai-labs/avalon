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
  role: "owner",
};

function createInput(
  scope: "personal" | "workspace",
  deliveryTargets: Parameters<AutomationService["create"]>[0]["deliveryTargets"],
): Parameters<AutomationService["create"]>[0] {
  return {
    draft: {
      name: "Daily briefing",
      description: "Summarizes the day ahead.",
      overview: "Runs every morning.",
      instructions: "Prepare the briefing.",
      triggers: [],
      requiredCapabilities: [],
      expectedOutputs: [],
      requestedDelivery: [],
      defaultBehavior: {},
      recommendedPlugins: [],
      memoryTables: [],
      suggestedScope: scope,
      followUpQuestion: null,
      elicitation: null,
      ready: true,
    },
    scope,
    defaultPluginIds: [],
    activitySourcePluginIds: {},
    resourceIds: [],
    deliveryTargets,
  };
}

function serviceWith(first: () => Promise<unknown>): { service: AutomationService; bind: ReturnType<typeof vi.fn> } {
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  return { bind, service: new AutomationService(createTestEnv({ DB: { prepare } }), auth) };
}

describe("automation delivery targets", () => {
  it("rejects delivery outside Avalon for a workspace automation", async () => {
    const { service } = serviceWith(async () => null);

    await expect(service.create(createInput("workspace", [{ type: "email" }]))).rejects.toMatchObject({
      status: 422,
      code: "personal_automation_required",
    });
  });

  it("freezes the owner's account email as the delivery address", async () => {
    const { service, bind } = serviceWith(async () => ({ email: "owner@example.com" }));

    // The insert path needs bindings this stub does not provide, so the run
    // fails after resolution; the resolved address is what this asserts.
    await expect(service.create(createInput("personal", [{ type: "email" }]))).rejects.toBeDefined();
    expect(bind).toHaveBeenCalledWith("668953d2-25f2-44fd-8d72-1e8cf024a277", "d6d77053-92bc-4af6-8332-8bea8c4c6904");
  });

  it("rejects email delivery when the account has no address", async () => {
    const { service } = serviceWith(async () => ({ email: "  " }));

    await expect(service.create(createInput("personal", [{ type: "email" }]))).rejects.toMatchObject({
      status: 422,
      code: "email_delivery_unavailable",
    });
  });

  it("rejects a destination the owner has not linked", async () => {
    const { service } = serviceWith(async () => null);

    await expect(service.create(createInput("personal", [{
      type: "slack_agent_dm",
      connectionId: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b7910",
    }]))).rejects.toMatchObject({
      status: 422,
      code: "delivery_target_unavailable",
    });
  });
});
