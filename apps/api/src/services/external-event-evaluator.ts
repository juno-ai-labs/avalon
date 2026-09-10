import {
  AutomationSetEvaluatorRulesInputV1Schema,
  ConnectorActivityTriggerDescriptorV2Schema,
  ExternalEventPredicateV1Schema,
  type AutomationSetEvaluatorRulesInputV1,
  type ConnectorActivityTriggerDescriptorV2,
  type DraftExternalEventEvaluatorV1,
  type ExternalEventPredicateLeafV1,
  type ExternalEventPredicateV1,
} from "@rally/contracts";
import { z } from "zod";

export type ExternalEventContextValue = string | number | boolean | readonly string[];
export type ExternalEventEvaluationContext = Readonly<Record<string, ExternalEventContextValue>>;

const PERSON_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * The only runtime matcher for external-event automations and resource watches.
 *
 * It is intentionally small and total: the strict schemas have already made
 * illegal operator/value pairs unrepresentable, and this function never calls
 * a provider or model. Missing values fail closed for every non-presence leaf.
 */
export function evaluateExternalEventPredicate(
  rawPredicate: unknown,
  context: ExternalEventEvaluationContext,
): boolean {
  const predicate = ExternalEventPredicateV1Schema.parse(rawPredicate);
  if (predicate.kind === "always") return true;
  return predicate.allOf.every((leaf) => evaluateLeaf(leaf, context));
}

function evaluateLeaf(
  leaf: ExternalEventPredicateLeafV1,
  context: ExternalEventEvaluationContext,
): boolean {
  const present = Object.hasOwn(context, leaf.attribute);
  if (leaf.kind === "presence") {
    return leaf.operator === "exists" ? present : !present;
  }
  if (!present) return false;
  const actual = context[leaf.attribute]!;

  switch (leaf.kind) {
    case "string":
      if (typeof actual !== "string") return false;
      switch (leaf.operator) {
        case "equals": return actual === leaf.value;
        case "not_equals": return actual !== leaf.value;
        case "contains": return actual.includes(leaf.value);
        case "starts_with": return actual.startsWith(leaf.value);
        case "ends_with": return actual.endsWith(leaf.value);
        case "in": return leaf.value.includes(actual);
        case "not_in": return !leaf.value.includes(actual);
      }
      return false;
    case "number":
      if (typeof actual !== "number" || !Number.isFinite(actual)) return false;
      switch (leaf.operator) {
        case "equals": return actual === leaf.value;
        case "not_equals": return actual !== leaf.value;
        case "greater_than": return actual > leaf.value;
        case "less_than": return actual < leaf.value;
        case "greater_than_or_equals": return actual >= leaf.value;
        case "less_than_or_equals": return actual <= leaf.value;
        case "in": return leaf.value.includes(actual);
        case "not_in": return !leaf.value.includes(actual);
      }
      return false;
    case "boolean":
      if (typeof actual !== "boolean") return false;
      return leaf.operator === "equals" ? actual === leaf.value : actual !== leaf.value;
    case "person_id":
      if (typeof actual !== "string" || !PERSON_ID_PATTERN.test(actual)) return false;
      return leaf.operator === "equals" ? actual === leaf.value : actual !== leaf.value;
    case "person_id_array":
    case "string_array": {
      if (!isStringArray(actual)) return false;
      const desired = Array.isArray(leaf.value) ? leaf.value : [leaf.value];
      switch (leaf.operator) {
        case "has": return actual.includes(desired[0]!);
        case "has_any": return desired.some((value) => actual.includes(value));
        case "has_all": return desired.every((value) => actual.includes(value));
        case "has_none": return desired.every((value) => !actual.includes(value));
      }
      return false;
    }
  }
  // Every case above returns, so this is only reachable if a stored rule names
  // an operator this build does not know — a rule written by a later
  // deployment and replayed here. Falling out of the switch would return
  // `undefined`, which the callers' `some`/`every` happen to coerce to false;
  // saying it outright is what keeps that from depending on the caller.
  return false;
}

function isStringArray(value: ExternalEventContextValue): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export interface InspectedAutomationPluginManifest {
  pluginId: string;
  activityTriggers: readonly ConnectorActivityTriggerDescriptorV2[];
  eventFamilies: Readonly<Record<string, readonly string[]>>;
}

export interface EvaluatorResolutionScope {
  inspectedPlugins: ReadonlyMap<string, InspectedAutomationPluginManifest>;
  personIds: ReadonlySet<string>;
  resources: ReadonlyMap<string, { pluginId: string; sourceBindingKey: string; resourceType: string }>;
}

export interface ValidatedDraftEvaluator {
  evaluator: DraftExternalEventEvaluatorV1;
  expandedEventTypes: readonly string[];
}

/**
 * Second-stage parser for model-authored rules.
 *
 * The provider schema can prove structure. This boundary proves meaning against
 * the exact manifests, people and resources inspected in this compiler run.
 */
export function validateDraftEvaluatorRules(
  rawInput: unknown,
  scope: EvaluatorResolutionScope,
): readonly ValidatedDraftEvaluator[] {
  const input = AutomationSetEvaluatorRulesInputV1Schema.parse(rawInput);
  return input.evaluators.map((evaluator, index) => {
    const manifest = scope.inspectedPlugins.get(evaluator.source.suggestedSourcePluginId);
    if (!manifest) {
      throw evaluatorIssue(index, ["source", "suggestedSourcePluginId"], "sidekick_plugin_not_inspected");
    }
    const expandedEventTypes = expandEventTypes(evaluator, manifest, index);
    if (evaluator.source.resourceId) {
      const resource = scope.resources.get(evaluator.source.resourceId);
      if (
        !resource
        || resource.pluginId !== evaluator.source.suggestedSourcePluginId
        || resource.sourceBindingKey !== evaluator.source.sourceBindingKey
      ) {
        throw evaluatorIssue(index, ["source", "resourceId"], "sidekick_resource_not_found");
      }
    }
    for (const eventType of expandedEventTypes) {
      const descriptor = manifest.activityTriggers.find((candidate) => candidate.eventType === eventType);
      if (!descriptor) {
        throw evaluatorIssue(index, ["source", "event"], "sidekick_evaluator_invalid");
      }
      const selectedResource = evaluator.source.resourceId
        ? scope.resources.get(evaluator.source.resourceId)
        : undefined;
      if (
        selectedResource
        && !descriptor.resourceRelationships.some(
          (relationship) => relationship.resourceType === selectedResource.resourceType,
        )
      ) {
        throw evaluatorIssue(index, ["source", "resourceId"], "sidekick_evaluator_resource_relationship_invalid");
      }
      validatePredicate(evaluator.when, descriptor, scope.personIds, index);
    }
    return { evaluator, expandedEventTypes };
  });
}

function expandEventTypes(
  evaluator: AutomationSetEvaluatorRulesInputV1["evaluators"][number],
  manifest: InspectedAutomationPluginManifest,
  index: number,
): readonly string[] {
  if (evaluator.source.event.kind === "event_type") {
    return [evaluator.source.event.eventType];
  }
  const eventTypes = manifest.eventFamilies[evaluator.source.event.eventFamily];
  if (!eventTypes || eventTypes.length === 0 || new Set(eventTypes).size !== eventTypes.length) {
    throw evaluatorIssue(index, ["source", "event", "eventFamily"], "sidekick_evaluator_invalid");
  }
  return eventTypes;
}

function validatePredicate(
  predicate: ExternalEventPredicateV1,
  rawDescriptor: ConnectorActivityTriggerDescriptorV2,
  personIds: ReadonlySet<string>,
  evaluatorIndex: number,
): void {
  const descriptor = ConnectorActivityTriggerDescriptorV2Schema.parse(rawDescriptor);
  if (predicate.kind === "always") return;
  for (const [leafIndex, leaf] of predicate.allOf.entries()) {
    const path = ["when", "allOf", leafIndex] as const;
    // An open descriptor names no fields: the caller's payload keys are the
    // vocabulary, and a leaf on a key the event lacks is simply a miss.
    // A dotted key on an open descriptor would compile and never match: the
    // event context indexes metadata by its bare keys.
    if (descriptor.openFilterFields === true && leaf.attribute.includes(".")) {
      throw evaluatorIssue(evaluatorIndex, [...path, "attribute"], "sidekick_evaluator_invalid");
    }
    const field = descriptor.openFilterFields === true
      ? null
      : descriptor.filterFields.find((candidate) => candidate.key === leaf.attribute) ?? undefined;
    if (field === undefined || (field !== null && !field.operators.includes(leaf.operator))) {
      throw evaluatorIssue(evaluatorIndex, [...path, "attribute"], "sidekick_evaluator_invalid");
    }
    if (field !== null && leaf.kind !== "presence" && leaf.kind !== field.valueType) {
      throw evaluatorIssue(evaluatorIndex, [...path, "kind"], "sidekick_evaluator_invalid");
    }
    if (leaf.kind === "person_id" || leaf.kind === "person_id_array") {
      const values = Array.isArray(leaf.value) ? leaf.value : [leaf.value];
      if (values.some((personId) => !personIds.has(personId))) {
        throw evaluatorIssue(evaluatorIndex, [...path, "value"], "sidekick_person_not_found");
      }
    }
  }
}

function evaluatorIssue(index: number, path: readonly PropertyKey[], message: string): z.ZodError {
  return new z.ZodError([{
    code: "custom",
    path: ["evaluators", index, ...path],
    message,
  }]);
}
