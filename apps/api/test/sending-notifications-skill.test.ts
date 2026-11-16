import { BUILT_IN_SKILLS, createSkillRuntime } from "@rally/agent-harness";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import { describe, expect, it } from "vitest";

import { createNotificationsPlugin } from "../src/services/notification-tools";

const input = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  parentKind: "canvas",
  parentId: "00000000-0000-4000-8000-000000000002",
  loopId: "workstream:00000000-0000-4000-8000-000000000002:substream:0:loop",
  harnessRunId: "00000000-0000-4000-8000-000000000003",
  region: "global",
  reason: "human_message",
  executionPrincipal: { type: "user", userId: "00000000-0000-4000-8000-000000000000" },
} as WorkstreamWorkflowInput;

async function catalogFor(plugins: string[]) {
  const runtime = await createSkillRuntime({ skills: BUILT_IN_SKILLS, eligiblePlugins: plugins });
  return runtime.summaries.map((summary) => summary.name);
}

describe("sending-notifications skill", () => {
  it("is in the catalog of a run that holds the notifications plugin, and of no other", async () => {
    // The plugin's own id, from the plugin the loop is given: a skill owned by
    // a misspelled or renamed id leaves every catalog without an error.
    const plugin = createNotificationsPlugin(input, {
      canvasNotices: async () => ({ outcome: "refused", code: "unused" }),
      turnIsSelfReview: async () => false,
    });
    expect(await catalogFor([plugin.canonicalId])).toContain("sending-notifications");
    expect(await catalogFor([])).not.toContain("sending-notifications");
  });
});
