import { describe, expect, it } from "vitest";

import {
  isSentinelAutomationResourceId,
  withoutUnusableAutomationResourceIds,
} from "./automation-evaluators";

const triggers = {
  plugin_notion: [
    { eventType: "notion.page.created", eventFamilies: ["pages"], resourceRelationships: [{ relationship: "page", resourceType: "notion_page" }] },
  ],
  plugin_webhook: [
    { eventType: "deploy.finished", eventFamilies: [], resourceRelationships: [] },
  ],
} as const;
const lookup = (pluginId: string) => (triggers as Record<string, readonly unknown[]>)[pluginId] as never;

function rule(pluginId: string, event: Record<string, unknown>, resourceId?: unknown) {
  return {
    schemaVersion: 1,
    evaluators: [{
      evaluatorKey: "k",
      source: {
        sourceBindingKey: "b",
        suggestedSourcePluginId: pluginId,
        ...(resourceId === undefined ? {} : { resourceId }),
        event,
      },
      when: { kind: "always" },
    }],
  };
}
function sourceOf(value: unknown): Record<string, unknown> {
  return (value as { evaluators: Array<{ source: Record<string, unknown> }> }).evaluators[0]!.source;
}

describe("a resource id that means none", () => {
  it("is the nil or max UUID in any version and variant dress, or nothing at all", () => {
    for (const value of [
      "",
      "  ",
      "00000000-0000-0000-0000-000000000000",
      "00000000-0000-4000-8000-000000000000",
      "00000000-0000-1000-8000-000000000000",
      "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
      42,
      null,
    ]) {
      expect(isSentinelAutomationResourceId(value), String(value)).toBe(true);
    }
    for (const value of [
      "3d1f8c2a-5b6e-4c7d-8e9f-0a1b2c3d4e5f",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-00000000000",
    ]) {
      expect(isSentinelAutomationResourceId(value), value).toBe(false);
    }
  });
});

describe("dropping a resource id a rule cannot use", () => {
  it("drops a sentinel on any trigger", () => {
    const stripped = withoutUnusableAutomationResourceIds(
      rule("plugin_notion", { kind: "event_type", eventType: "notion.page.created" }, "00000000-0000-4000-8000-000000000000"),
      lookup,
    );
    expect(sourceOf(stripped)).not.toHaveProperty("resourceId");
  });

  it("drops a real-looking id on a trigger with no resource relationship", () => {
    const stripped = withoutUnusableAutomationResourceIds(
      rule("plugin_webhook", { kind: "event_type", eventType: "deploy.finished" }, "3d1f8c2a-5b6e-4c7d-8e9f-0a1b2c3d4e5f"),
      lookup,
    );
    expect(sourceOf(stripped)).not.toHaveProperty("resourceId");
  });

  it("keeps a real-looking id on a trigger that can be about one resource", () => {
    const kept = withoutUnusableAutomationResourceIds(
      rule("plugin_notion", { kind: "event_family", eventFamily: "pages" }, "3d1f8c2a-5b6e-4c7d-8e9f-0a1b2c3d4e5f"),
      lookup,
    );
    expect(sourceOf(kept)).toHaveProperty("resourceId", "3d1f8c2a-5b6e-4c7d-8e9f-0a1b2c3d4e5f");
  });

  it("leaves an unknown plugin or event alone for the validator to describe", () => {
    const unknownPlugin = rule("plugin_nowhere", { kind: "event_type", eventType: "x" }, "3d1f8c2a-5b6e-4c7d-8e9f-0a1b2c3d4e5f");
    expect(sourceOf(withoutUnusableAutomationResourceIds(unknownPlugin, lookup))).toHaveProperty("resourceId");
    const unknownEvent = rule("plugin_notion", { kind: "event_type", eventType: "notion.nothing" }, "3d1f8c2a-5b6e-4c7d-8e9f-0a1b2c3d4e5f");
    expect(sourceOf(withoutUnusableAutomationResourceIds(unknownEvent, lookup))).toHaveProperty("resourceId");
    expect(withoutUnusableAutomationResourceIds("not rules", lookup)).toBe("not rules");
    expect(withoutUnusableAutomationResourceIds({ evaluators: "nope" }, lookup)).toEqual({ evaluators: "nope" });
  });
});

describe("a filter field's operators when its manifest names none", () => {
  it("follow the value type, so an array field can be used at all", async () => {
    const { ConnectorActivityFilterFieldSchema } = await import("./index");
    const field = (valueType: string) => ConnectorActivityFilterFieldSchema.parse({
      key: "changedFields",
      label: "Changed fields",
      description: "Fields reported as changed.",
      valueType,
    });

    // The predicate leaf for an array admits only the set operators, so an
    // array field defaulting to equals was declared, inspected, and unusable.
    expect(field("string_array").operators).toEqual(["has_any", "has_all", "has_none"]);
    expect(field("person_id_array").operators).toEqual(["has_any", "has_all", "has_none"]);
    expect(field("string").operators).toEqual(["equals"]);
    expect(field("number").operators).toEqual(["equals"]);
    expect(ConnectorActivityFilterFieldSchema.parse({
      key: "labels",
      label: "Labels",
      description: "Labels.",
      valueType: "string_array",
      operators: ["has"],
    }).operators).toEqual(["has"]);
  });
});
