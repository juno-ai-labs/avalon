import { describe, expect, it } from "vitest";

import { artifactDataReader } from "../src/services/workstream-artifact-data-wiring";

const run = { automationId: "a" };
const member = { type: "user", userId: "member" };
const coordinator = { type: "user", userId: "coordinator" };

describe("who a run reads a site's data as", () => {
  it("reads as the member a run runs as", () => {
    expect(artifactDataReader({ executionPrincipal: member })).toBe("member");
  });

  it("reads every row in an unattended Sidekick run and the agents it starts", () => {
    expect(artifactDataReader({ executionPrincipal: coordinator, automationRun: run })).toBeNull();
    expect(artifactDataReader({
      executionPrincipal: coordinator,
      automationDelegation: { runId: "r", stopGeneration: 0 },
    })).toBeNull();
  });

  it("reads every row for an Organization principal", () => {
    expect(artifactDataReader({ executionPrincipal: { type: "workspace" } })).toBeNull();
  });
});
