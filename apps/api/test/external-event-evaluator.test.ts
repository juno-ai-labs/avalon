import { describe, expect, it } from "vitest";
import { ExternalEventEvaluatorV1Schema, ExternalEventPredicateV1Schema } from "@rally/contracts";
import { evaluateExternalEventPredicate, validateDraftEvaluatorRules } from "../src/services/external-event-evaluator";

const personId = "11111111-1111-4111-8111-111111111111";

describe("external event evaluator", () => {
  it("still matches a stored rule that spells `matching` as the pre-rename `all`", () => {
    // Rows written before the rename are in production in SidekickDO's
    // `definition_revisions.evaluator_rules_json` and WorkspaceDO's
    // `workspace_external_event_registrations.evaluator_json`, and
    // `matchExternalEventDestinations` parses the latter on the delivery path
    // of every incoming event. A stored `all` that stopped parsing would throw
    // mid-match, and every Sidekick registered before the rename would stop
    // waking.
    const stored = {
      kind: "all",
      allOf: [{ kind: "string", attribute: "service", operator: "equals", value: "checkout" }],
    };

    // One canonical value reaches every reader: nothing downstream branches on
    // the legacy spelling, so nothing downstream may be handed it.
    expect(ExternalEventPredicateV1Schema.parse(stored)).toEqual({
      kind: "matching",
      allOf: [{ kind: "string", attribute: "service", operator: "equals", value: "checkout" }],
    });

    // The leaves still decide the answer — a parse that admitted the row but
    // dropped its conditions would match everything.
    expect(evaluateExternalEventPredicate(stored, { service: "checkout" })).toBe(true);
    expect(evaluateExternalEventPredicate(stored, { service: "billing" })).toBe(false);

    // The exact parse the hot delivery path makes, over the whole stored row.
    expect(ExternalEventEvaluatorV1Schema.parse({
      evaluatorId: "22222222-2222-4222-8222-222222222222",
      source: {
        connectorType: "generic_webhook",
        connectionId: "33333333-3333-4333-8333-333333333333",
        eventType: "deploy.finished",
      },
      when: stored,
    }).when).toMatchObject({ kind: "matching" });
  });

  it("evaluates a typed AND group without coercion and treats missing negative leaves as false", () => {
    // One rule is one AND group: "A or B" is authored as two rules, so there is
    // no OR to evaluate here.
    const predicate = {
      kind: "matching" as const,
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
      kind: "matching",
      allOf: [{ kind: "string", attribute: "missing", operator: "not_equals", value: "x" }],
    }, {})).toBe(false);
    expect(evaluateExternalEventPredicate({
      kind: "matching",
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
          kind: "matching" as const,
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
        when: { kind: "matching", allOf: [{
          kind: "number",
          attribute: "messageText",
          operator: "equals",
          value: 1,
        }] },
      }],
    }, { inspectedPlugins, resources, personIds: new Set() })).toThrow("sidekick_evaluator_invalid");

    // The resource half of the same boundary, and the branch every other
    // caller of `automationTriggersAdmitResourceType` defers to. A Slack
    // message is *about* a channel and nothing else, so an id resolved to a
    // message — the thing the event produced — is refused rather than admitted
    // as a narrower rule that would never match.
    expect(() => validateDraftEvaluatorRules(rules, {
      inspectedPlugins,
      resources: new Map([["22222222-2222-4222-8222-222222222222", {
        pluginId: "plugin_slack",
        sourceBindingKey: "slack",
        resourceType: "slack_message",
      }]]),
      personIds: new Set(),
    })).toThrow("sidekick_evaluator_resource_relationship_invalid");
  });
});
