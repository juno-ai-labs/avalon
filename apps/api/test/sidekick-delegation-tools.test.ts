import { describe, expect, it } from "vitest";
import { validateToolArguments } from "@rally/agent-harness";
import { WorkstreamWorkflowInputSchema } from "@rally/contracts";
import { __integrationTesting } from "../src/services/integrations";
import { createTestEnv } from "./helpers/cloudflare-test";

const input = WorkstreamWorkflowInputSchema.parse({
  region: "global", workspaceId: "00000000-0000-7000-8000-00000000dd00",
  parentKind: "workstream", parentId: "00000000-0000-7000-8000-00000000dd01", substreamId: "0",
  loopId: "delegation-tool-test", harnessRunId: "00000000-0000-7000-8000-00000000dd02",
  triggerMessageId: "00000000-0000-7000-8000-00000000dd03", activityId: null,
  executionPrincipal: { type: "user", userId: "00000000-0000-7000-8000-00000000dd04" }, reason: "user_message",
});

function plugin(authoring: boolean, autonomous = false) {
  return __integrationTesting.createAvalonAutomationsPlugin(createTestEnv({}),
    { ...input, parentKind: authoring ? "automation" : "workstream", ...(autonomous ? { triggerMessageId: null, backgroundAgent: true } : {}) }, new Set(), (tool) => [tool]);
}

describe("Sidekick delegation plugin presentations", () => {
  it("keeps the existing room recommendations and adds only the delegation subset with stable wire names", () => {
    const room = plugin(false);
    const authoring = plugin(true);
    const delegation = ["my_delegations_list", "delegates_list", "set_delegation"];
    expect(room.modelId).toBe("rally_skill_recommendations");
    expect(room.shortWireName).toBe("");
    expect(room.tools.map((tool) => tool.definition.name)).toEqual([
      "list_skill_recommendations", "recommend_skill", "unrecommend_skill", ...delegation.map((name) => `sidekick_${name}`),
    ]);
    expect(authoring.modelId).toBe("rally_sidekicks");
    expect(authoring.shortWireName).toBe("sidekick");
    expect(authoring.tools.slice(-3).map((tool) => tool.definition.name)).toEqual(delegation);
    expect(room.systemMessage).toContain("sidekick_my_delegations_list");
    expect(room.systemMessage).toContain("sidekick_delegates_list");
    expect(room.systemMessage).toContain("sidekick_set_delegation");
    expect(room.systemMessage).toContain("separate sidekicks_list and create_sidekick");
    expect(authoring.systemMessage).toContain("This is available during autonomous work too");
    expect(authoring.systemMessage).toContain("sidekick_set_delegation");
    expect(authoring.systemMessage).toContain("sidekick_delegates_list");
    expect(room.searchAliases).toContain("delegation");
  });

  it("exposes delegation tools during autonomous work", () => {
    for (const authoring of [true, false]) {
      expect(plugin(authoring, true).tools.some((tool) => tool.definition.capability.startsWith("rally.sidekick.delegation."))).toBe(true);
    }
  });

  it("advertises and enforces identical strict schemas with an explicit target user", () => {
    const mutation = plugin(false).tools.find((tool) => tool.definition.name === "sidekick_set_delegation")!;
    expect(mutation.definition.mode).toBe("write");
    expect(mutation.definition.idempotency).toBe("record_before_execute");
    expect(mutation.serial).toBe(true);
    const valid = { sidekickId: input.parentId, userId: "00000000-0000-7000-8000-00000000dd05", allowed: true };
    expect(validateToolArguments(valid, mutation.definition.inputSchema)).toBeNull();
    expect(mutation.validateInput?.(valid)).toBeNull();
    for (const field of ["actorUserId", "connectionId", "consent", "source", "expectedRevision", "force"]) {
      const invalid = { ...valid, [field]: "forged" };
      expect(validateToolArguments(invalid, mutation.definition.inputSchema)).not.toBeNull();
      expect(mutation.validateInput?.(invalid)).not.toBeNull();
    }
    for (const invalid of [{ sidekickId: input.parentId }, { allowed: true }, { ...valid, sidekickId: "not-a-uuid" }]) {
      expect(validateToolArguments(invalid, mutation.definition.inputSchema)).not.toBeNull();
      expect(mutation.validateInput?.(invalid)).not.toBeNull();
    }
  });
});
