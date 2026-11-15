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

  it("is a wake-up's turn exactly when the turn that scheduled it was a person's", () => {
    expect(drivenByPerson({ reason: "scheduled_wakeup", scheduledWakeupId: "w", wakeupScheduledByPerson: true })).toBe(true);
    expect(drivenByPerson({ reason: "scheduled_wakeup", scheduledWakeupId: "w", wakeupScheduledByPerson: false })).toBe(false);
    // A wake-up scheduled before the column is read as a person's, as it always was.
    expect(drivenByPerson({ reason: "scheduled_wakeup", scheduledWakeupId: "w" })).toBe(true);
  });

  it("keeps a run's wake-up a run's, whoever scheduled it", () => {
    expect(drivenByPerson({ reason: "scheduled_wakeup", scheduledWakeupId: "w", wakeupScheduledByPerson: true, automationRun: RUN })).toBe(false);
  });
});
