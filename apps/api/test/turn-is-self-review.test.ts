import { asAutomationId, asHarnessRunId, asSubstreamId, asUserId, asWorkspaceId, type WorkstreamWorkflowInput } from "@rally/contracts";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { __integrationTesting } from "../src/services/integrations";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";

const SIDEKICK = "00000000-0000-4000-8000-0000000000a1";

function input(extra: Partial<WorkstreamWorkflowInput>): WorkstreamWorkflowInput {
  return {
    region: "global", workspaceId: asWorkspaceId("00000000-0000-4000-8000-0000000000a2"), parentKind: "automation", parentId: SIDEKICK,
    loopId: `workstream:${SIDEKICK}:substream:0:loop`, harnessRunId: asHarnessRunId("00000000-0000-4000-8000-0000000000a3"),
    triggerMessageId: null, activityId: null, executionPrincipal: { type: "user", userId: asUserId("00000000-0000-4000-8000-0000000000a4") },
    reason: "agent_message", ...extra,
  };
}

/** An environment whose Organization object may not be reached: asking it is the defect. */
function unreachable(): Env {
  return createTestEnv({
    WORKSPACE_DOS: createCloudflareTestBinding<DurableObjectNamespace>({
      idFromName: () => { throw new Error("the wizard transcript was read"); },
      get: () => { throw new Error("the wizard transcript was read"); },
    }),
  });
}

describe("turnIsSelfReview", () => {
  it("is the review's when its own reason says so, without reading anything", async () => {
    await expect(__integrationTesting.turnIsSelfReview(unreachable(), input({ reason: "sidekick_review" }))).resolves.toBe(true);
  });

  it("never asks the wizard's transcript about a run or a background agent of the same Sidekick", async () => {
    const run = input({
      substreamId: asSubstreamId("00000000-0000-4000-8000-0000000000a5"),
      automationRun: { schemaVersion: 1, automationId: asAutomationId(SIDEKICK), runId: "00000000-0000-4000-8000-0000000000a5",
        definitionRevision: 1, trigger: { kind: "manual", requestedByUserId: asUserId("00000000-0000-4000-8000-0000000000a4") } },
    });
    await expect(__integrationTesting.turnIsSelfReview(unreachable(), run)).resolves.toBe(false);
    await expect(__integrationTesting.turnIsSelfReview(unreachable(),
      input({ substreamId: asSubstreamId("00000000-0000-4000-8000-0000000000a6"), backgroundAgent: true }))).resolves.toBe(false);
  });
});
