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

const { personalSystemPromptFor } = __integrationTesting;

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

describe("personal system prompt", () => {
  const read = (userId: string) => (userId === OWNER ? "Answer in French." : "");

  it.each([
    "opening_message",
    "human_message",
    "elicitation_answer",
    "manual_retry",
    "slack_workspace_message",
  ])("carries the member's text on a turn they started (%s)", (reason) => {
    expect(personalSystemPromptFor(workflowInput(reason), read)).toContain(
      "<personal_system_prompt>\nAnswer in French.\n</personal_system_prompt>",
    );
  });

  it.each([
    "scheduled_digest",
    "scheduled_wakeup",
    "inbound_email",
    "connector_activity",
    "demo_seed",
  ])("leaves it out of a run that acts as the member without them acting (%s)", (reason) => {
    expect(personalSystemPromptFor(workflowInput(reason), read)).toBe("");
  });

  it("leaves it out of a background agent working under the member's principal", () => {
    expect(personalSystemPromptFor({ ...workflowInput("human_message"), backgroundAgent: true }, read)).toBe("");
  });

  it("leaves it out of a Sidekick run acting as the member", () => {
    expect(personalSystemPromptFor({ ...workflowInput("human_message"), parentKind: "automation" }, read)).toBe("");
  });
});
