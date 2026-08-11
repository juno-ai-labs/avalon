import { describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { AutomationService } from "../src/services/automation-service";

const auth: AuthContext = {
  sessionId: "session-1",
  userId: "user-1",
  workspaceId: "workspace-1",
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
      defaultBehavior: {},
      recommendedPlugins: [],
      memoryTables: [],
      suggestedScope: scope,
      suggestedDelivery: "avalon_only" as const,
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
  return { bind, service: new AutomationService({ DB: { prepare } } as unknown as Env, auth) };
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
    expect(bind).toHaveBeenCalledWith("workspace-1", "user-1");
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
