import { describe, expect, it } from "vitest";
import { startedWorkOpportunityTelemetryEnvelope } from "../src/routes/work-opportunities";
import { createTestEnv } from "./helpers/cloudflare-test";

describe("suggested-work telemetry", () => {
  it.each(["menu_bar", "workspace_home"] as const)(
    "builds an authoritative successful-start event for %s",
    (surface) => {
      const opportunityId = "018f22f2-4c22-7abc-8def-0123456789ac";
      const event = startedWorkOpportunityTelemetryEnvelope(
        createTestEnv({ AVALON_REGION: "global" }), surface, opportunityId,
      );

      expect(event).toMatchObject({
        eventId: opportunityId,
        name: "suggested_work_started",
        source: "api",
        category: "product",
        identityScope: "workspace-user",
        context: { operationId: opportunityId, region: "global" },
        properties: { surface },
      });
    },
  );
});
