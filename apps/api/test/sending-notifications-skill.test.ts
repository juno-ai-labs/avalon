import { BUILT_IN_SKILLS, createSkillRuntime } from "@rally/agent-harness";
import { describe, expect, it } from "vitest";

import { NOTIFICATIONS_PLUGIN_ID } from "../src/services/notification-tools";

async function catalogFor(plugins: string[]) {
  const runtime = await createSkillRuntime({ skills: BUILT_IN_SKILLS, eligiblePlugins: plugins });
  return runtime.summaries.map((summary) => summary.name);
}

describe("sending-notifications skill", () => {
  it("is in the catalog of a run that holds the notifications plugin, and of no other", async () => {
    // The plugin's own id: a skill owned by a misspelled or renamed id leaves
    // every catalog without an error.
    expect(await catalogFor([NOTIFICATIONS_PLUGIN_ID])).toContain("sending-notifications");
    // Owned at all: a skill with no owner would be offered to every run.
    expect(await catalogFor([])).not.toContain("sending-notifications");
  });
});
