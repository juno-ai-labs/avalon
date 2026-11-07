import { describe, expect, it } from "vitest";
import { validateToolArguments } from "@rally/agent-harness";
import { WorkstreamWorkflowInputSchema } from "@rally/contracts";
import { __integrationTesting } from "../src/services/integrations";
import { createTestEnv } from "./helpers/cloudflare-test";

const input = WorkstreamWorkflowInputSchema.parse({
  region: "global", workspaceId: "00000000-0000-7000-8000-00000000dd00",
  parentKind: "automation", parentId: "00000000-0000-7000-8000-00000000dd01", substreamId: "0",
  loopId: "delegation-tool-test", harnessRunId: "00000000-0000-7000-8000-00000000dd02",
  triggerMessageId: "00000000-0000-7000-8000-00000000dd03", activityId: null,
  executionPrincipal: { type: "user", userId: "00000000-0000-7000-8000-00000000dd04" }, reason: "user_message",
});

// Only a Sidekick's authoring conversation builds this plugin: the Thread
// presentation (`rally_sidekick_delegation`) left with Threads in 2316993, and
// a Canvas chat's delegation tools are covered in connector-tool-selection.test.ts.
function plugin(autonomous = false) {
  return __integrationTesting.createAvalonAutomationsPlugin(createTestEnv({}),
    { ...input, ...(autonomous ? { triggerMessageId: null, backgroundAgent: true } : {}) }, new Set(), (tool) => [tool]);
}

describe("Sidekick delegation plugin presentations", () => {
  it("gives authoring the delegation tools with stable wire names", () => {
    const authoring = plugin();
    expect(authoring.modelId).toBe("rally_sidekicks");
    expect(authoring.shortWireName).toBe("sidekick");
    expect(authoring.tools.slice(-3).map((tool) => tool.definition.name))
      .toEqual(["my_delegations_list", "delegates_list", "set_delegation"]);
    expect(authoring.systemMessage).toContain("This is available during autonomous work too");
    expect(authoring.systemMessage).toContain("sidekick_set_delegation");
    expect(authoring.systemMessage).toContain("sidekick_delegates_list");
  });

  it("exposes delegation tools during autonomous work", () => {
    expect(plugin(true).tools.some((tool) => tool.definition.capability.startsWith("rally.sidekick.delegation."))).toBe(true);
  });

  it("advertises and enforces identical strict schemas with an explicit target user", () => {
    const mutation = plugin().tools.find((tool) => tool.definition.name === "set_delegation")!;
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
