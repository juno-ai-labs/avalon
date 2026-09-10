import { describe, expect, it } from "vitest";
import { evaluateExternalEventPredicate, validateDraftEvaluatorRules } from "../src/services/external-event-evaluator";

const personId = "11111111-1111-4111-8111-111111111111";

describe("external event evaluator", () => {
  it("evaluates a typed AND group without coercion and treats missing negative leaves as false", () => {
    // One rule is one AND group: "A or B" is authored as two rules, so there is
    // no OR to evaluate here.
    const predicate = {
      kind: "all" as const,
      allOf: [
        { kind: "string" as const, attribute: "messageText", operator: "contains" as const, value: "foobar" },
        { kind: "person_id_array" as const, attribute: "participantPersonIds", operator: "has" as const, value: personId },
      ],
    };

    expect(evaluateExternalEventPredicate(predicate, {
      messageText: "prefix foobar suffix",
      participantPersonIds: [personId],
    })).toBe(true);
    expect(evaluateExternalEventPredicate(predicate, {
      messageText: "prefix Foobar suffix",
      participantPersonIds: [personId],
    })).toBe(false);
    expect(evaluateExternalEventPredicate({
      kind: "all",
      allOf: [{ kind: "string", attribute: "missing", operator: "not_equals", value: "x" }],
    }, {})).toBe(false);
    expect(evaluateExternalEventPredicate({
      kind: "all",
      allOf: [{ kind: "presence", attribute: "missing", operator: "not_exists" }],
    }, {})).toBe(true);
    // The unconditional rule: every event of the watched type matches.
    expect(evaluateExternalEventPredicate({ kind: "always" }, {})).toBe(true);
  });

  it("validates authoring rules against the inspected event manifest", () => {
    const rules = {
      schemaVersion: 1 as const,
      evaluators: [{
        evaluatorKey: "slack_foobar",
        source: {
          sourceBindingKey: "slack",
          suggestedSourcePluginId: "plugin_slack",
          event: { kind: "event_family" as const, eventFamily: "slack.message.created" },
          resourceId: "22222222-2222-4222-8222-222222222222",
        },
        when: {
          kind: "all" as const,
          allOf: [{
            kind: "string" as const,
            attribute: "messageText",
            operator: "contains" as const,
            value: "foobar",
          }],
        },
      }],
    };
    const inspectedPlugins = new Map([["plugin_slack", {
      pluginId: "plugin_slack",
      eventFamilies: { "slack.message.created": ["slack.message.posted", "slack.message.replied"] },
      activityTriggers: ["slack.message.posted", "slack.message.replied"].map((eventType) => ({
        eventType,
        label: eventType,
        description: eventType,
        eventFamilies: ["slack.message.created"],
        filterFields: [{
          key: "messageText",
          label: "Message text",
          description: "Bounded message text",
          valueType: "string" as const,
          operators: ["contains" as const],
          sensitive: true,
        }],
        resourceRelationships: [{ relationship: "channel" as const, resourceType: "slack_channel" }],
        digestible: true,
      })),
    }]]);
    const resources = new Map([["22222222-2222-4222-8222-222222222222", {
      pluginId: "plugin_slack",
      sourceBindingKey: "slack",
      resourceType: "slack_channel",
    }]]);

    expect(validateDraftEvaluatorRules(rules, {
      inspectedPlugins,
      resources,
      personIds: new Set(),
    })[0]?.expandedEventTypes).toEqual(["slack.message.posted", "slack.message.replied"]);

    expect(() => validateDraftEvaluatorRules({
      ...rules,
      evaluators: [{
        ...rules.evaluators[0],
        when: { kind: "all", allOf: [{
          kind: "number",
          attribute: "messageText",
          operator: "equals",
          value: 1,
        }] },
      }],
    }, { inspectedPlugins, resources, personIds: new Set() })).toThrow("sidekick_evaluator_invalid");
  });
});
