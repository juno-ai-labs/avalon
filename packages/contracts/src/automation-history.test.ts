import { describe, expect, it } from "vitest";
import { TriggerDefinitionSchema } from "./index";
import { AutomationActivationV1Schema, AutomationRunTriggerV1Schema } from "./automation-agent";

describe("retired run provenance", () => {
  it("decodes old runs and activations without admitting their retired trigger as configuration", () => {
    expect(TriggerDefinitionSchema.safeParse({ type: "inbound_email" }).success).toBe(false);
    expect(AutomationRunTriggerV1Schema.parse({ kind: "inbound_email", receiptId: "00000000-0000-7000-8000-000000000001", occurredAt: 1 }))
      .toEqual({ kind: "inbound_email", receiptId: "00000000-0000-7000-8000-000000000001", occurredAt: 1 });
    const activation = AutomationActivationV1Schema.parse({ type: "automation_activation", schemaVersion: 1,
      automationId: "00000000-0000-7000-8000-000000000002", automationName: "Earlier Sidekick",
      runId: "00000000-0000-7000-8000-000000000003", deliveryId: "past-post", trigger: { kind: "inbound_email" }, occurredAt: 1 });
    expect(activation.automationId).toBe("00000000-0000-7000-8000-000000000002");
    expect(activation.trigger?.kind).toBe("inbound_email");
  });
});
