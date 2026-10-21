import {
  asHarnessRunId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type WorkstreamWorkflowInput,
} from "@rally/contracts";
import { describe, expect, it } from "vitest";

import { __integrationTesting } from "../src/services/integrations";

const { principalSystemSectionFor } = __integrationTesting;

const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-000000000101");
const OWNER = asUserId("00000000-0000-7000-8000-000000000102");
const WORKSTREAM = asWorkstreamId("00000000-0000-7000-8000-000000000103");
const RUN = asHarnessRunId("00000000-0000-7000-8000-000000000104");
const MESSAGE = "00000000-0000-7000-8000-000000000105";

function workflowInput(reason: string): WorkstreamWorkflowInput {
  return {
    region: "global",
    workspaceId: WORKSPACE,
    parentKind: "workstream",
    parentId: WORKSTREAM,
    substreamId: asSubstreamId("0"),
    loopId: `workstream:${WORKSTREAM}:substream:0:loop`,
    harnessRunId: RUN,
    triggerMessageId: MESSAGE,
    activityId: null,
    executionPrincipal: { type: "user", userId: OWNER },
    reason,
  };
}

describe("principal system section", () => {
  it("is empty, changing no byte of the prefix, when the conversation holds no digest copy", () => {
    expect(principalSystemSectionFor(workflowInput("human_message"), {
      memoryDigest: () => null,
    })).toBe("");
    expect(principalSystemSectionFor(workflowInput("human_message"), undefined)).toBe("");
  });
});
