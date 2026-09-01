import {
  AutomationAgentSnapshotSchema,
  AutomationSetEvaluatorRulesMutationSchema,
} from "@rally/contracts";
import { describe, expect, it } from "vitest";

import { AutomationMemoryToolRequestSchema } from "../src/durable-objects/automation-agent-memory";
import { InitializeWorkstreamObjectInputSchema } from "../src/durable-objects/workstream-object-product";
import { SlackEventRpcInputSchema } from "../src/lib/rpc-contracts";

describe("Zod v3 required opaque fields", () => {
  it.each([
    ["work stream execution principal", InitializeWorkstreamObjectInputSchema.pick({ executionPrincipal: true })],
    ["automation memory arguments", AutomationMemoryToolRequestSchema.pick({ args: true })],
    ["Slack RPC payload", SlackEventRpcInputSchema.pick({ payload: true })],
    ["automation evaluator rules", AutomationSetEvaluatorRulesMutationSchema.pick({ evaluatorRules: true })],
  ])("rejects a missing %s", (_name, schema) => {
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("keeps a pending elicitation payload required", () => {
    const pendingElicitationSchema = AutomationAgentSnapshotSchema.shape.pendingElicitation.unwrap();
    expect(pendingElicitationSchema.pick({ payload: true }).safeParse({}).success).toBe(false);
  });
});
