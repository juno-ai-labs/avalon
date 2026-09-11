import { describe, expect, it } from "vitest";

import { connectorActivityTriggerDescriptors } from "../src/lib/connector-activity-triggers";
import { createTestConnectorRegistry } from "./helpers/connector-registry";

const registry = createTestConnectorRegistry();

describe("connector activity trigger descriptors", () => {
  it("gives a connection no triggers on a scope its connector cannot deliver activity on", () => {
    const granola = registry.get("granola");

    // Granola's webhook endpoint is bought once, against the workspace API
    // key. A personal connection is MCP OAuth: it reads notes on request and
    // subscribes to nothing, so every trigger the manifest declares is one no
    // event on this connection could ever match.
    expect(connectorActivityTriggerDescriptors(granola, null, "personal")).toEqual([]);
    expect(connectorActivityTriggerDescriptors(granola, null, "workspace")
      .map((trigger) => trigger.eventType)).toContain("note.generated");
  });

  it("keeps every trigger of a connector that delivers on both scopes", () => {
    // The default: a connector that declares no narrower activity scopes
    // answers the same on either, so this subtraction is opt-in rather than
    // something every connector now has to restate.
    const slack = registry.get("slack");
    const personal = connectorActivityTriggerDescriptors(slack, null, "personal");

    expect(personal.length).toBeGreaterThan(0);
    expect(personal).toEqual(connectorActivityTriggerDescriptors(slack, null, "workspace"));
  });

  it("still reads a generic webhook's configured event types as its triggers", () => {
    const webhook = registry.get("generic_webhook");
    const configured = JSON.stringify({ eventTypes: ["order.created"] });

    expect(connectorActivityTriggerDescriptors(webhook, configured, "workspace")
      .map((trigger) => trigger.eventType)).toEqual(["order.created"]);
  });
});
