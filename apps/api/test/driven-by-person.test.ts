import { AgentExchangeSchema, agentIdForAddress, asAutomationId, asSubstreamId, asUserId } from "@rally/contracts";
import { describe, expect, it } from "vitest";

import { drivenByPerson } from "../src/lib/driven-by-person";

const RUN = {
  schemaVersion: 1 as const,
  automationId: asAutomationId("00000000-0000-4000-8000-000000000001"),
  runId: "00000000-0000-4000-8000-000000000002",
  definitionRevision: 1,
  trigger: { kind: "manual" as const, requestedByUserId: asUserId("00000000-0000-4000-8000-000000000003") },
};
const SENDER = agentIdForAddress({ parentKind: "canvas", parentId: "00000000-0000-4000-8000-000000000004", substreamId: asSubstreamId("0") });
const EXCHANGE = AgentExchangeSchema.parse({ teamId: SENDER, senderAgentId: SENDER, messageId: "00000000-0000-4000-8000-000000000005" });

describe("drivenByPerson", () => {
  it("is a person's turn when a person typed it", () => {
    expect(drivenByPerson({ reason: "human_message" })).toBe(true);
  });

  it("is not a person's turn when content or Rally started it", () => {
    expect(drivenByPerson({ reason: "schedule", automationRun: RUN })).toBe(false);
    expect(drivenByPerson({ reason: "human_message", automationDelegation: { runId: RUN.runId, stopGeneration: 0 } })).toBe(false);
    expect(drivenByPerson({ reason: "agent_message", backgroundAgent: true })).toBe(false);
    expect(drivenByPerson({ reason: "agent_message", agentExchange: EXCHANGE })).toBe(false);
    expect(drivenByPerson({ reason: "sidekick_review" })).toBe(false);
  });

  it("is a person's turn for a wake-up in a Chat or a wizard, and not for a run's wake-up", () => {
    expect(drivenByPerson({ reason: "scheduled_wakeup" })).toBe(true);
    expect(drivenByPerson({ reason: "scheduled_wakeup", automationRun: RUN })).toBe(false);
  });
});
