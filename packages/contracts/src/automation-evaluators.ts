import { RegionSchema } from "@rally/contracts/regions";
import { z } from "zod";
import {
  ActivitySourceBindingKeySchema,
  IdSchema,
  ModelPluginIdSchema,
} from "./identifiers";

const NonEmptyStringSchema = z.string().min(1);
const NonEmptyStringArraySchema = z.array(NonEmptyStringSchema).min(1);
const FiniteNumberSchema = z.number().finite();
const FiniteNumberArraySchema = z.array(FiniteNumberSchema).min(1);
const PersonIdSchema = IdSchema.brand<"PersonId">();

/**
 * Every connector whose activity a rule may name.
 *
 * Kept in step with the connector registry by
 * `apps/api/test/connector-activity-trigger-vocabulary.test.ts`, which is the
 * nearest place that can see both the manifests and this list. Nothing else
 * links them: this list is a second spelling of the registry's membership, and
 * it silently drifted once — `fireflies` was added as a connector and not
 * here, so every Fireflies Sidekick was accepted, showed as published, and
 * then had its registration projection rejected at this field on a hop where
 * the rejection was unreadable. It never fired, and nothing said why.
 */
export const ConnectorTypeSchema = z.enum([
  "google",
  "generic_webhook",
  "github",
  "ashby",
  "canva",
  "fireflies",
  "granola",
  "linear",
  "notion",
  "slack",
  "x",
]);

export const ExternalEventStringOperatorSchema = z.enum([
  "equals",
  "not_equals",
  "contains",
  "starts_with",
  "ends_with",
]);
export const ExternalEventStringSetOperatorSchema = z.enum(["in", "not_in"]);
export const ExternalEventNumberOperatorSchema = z.enum([
  "equals",
  "not_equals",
  "greater_than",
  "less_than",
  "greater_than_or_equals",
  "less_than_or_equals",
]);
export const ExternalEventArraySetOperatorSchema = z.enum(["has_any", "has_all", "has_none"]);
export const ExternalEventPresenceOperatorSchema = z.enum(["exists", "not_exists"]);
export const ExternalEventOperatorSchema = z.union([
  ExternalEventStringOperatorSchema,
  ExternalEventStringSetOperatorSchema,
  ExternalEventNumberOperatorSchema,
  z.enum(["has"]),
  ExternalEventArraySetOperatorSchema,
  ExternalEventPresenceOperatorSchema,
]);

const StringLeafSchema = z.union([
  z.strictObject({
    kind: z.literal("string"),
    attribute: NonEmptyStringSchema,
    operator: ExternalEventStringOperatorSchema,
    value: NonEmptyStringSchema,
  }),
  z.strictObject({
    kind: z.literal("string"),
    attribute: NonEmptyStringSchema,
    operator: ExternalEventStringSetOperatorSchema,
    value: NonEmptyStringArraySchema,
  }),
]);

const NumberLeafSchema = z.union([
  z.strictObject({
    kind: z.literal("number"),
    attribute: NonEmptyStringSchema,
    operator: ExternalEventNumberOperatorSchema,
    value: FiniteNumberSchema,
  }),
  z.strictObject({
    kind: z.literal("number"),
    attribute: NonEmptyStringSchema,
    operator: ExternalEventStringSetOperatorSchema,
    value: FiniteNumberArraySchema,
  }),
]);

export const ExternalEventPredicateLeafV1Schema = z.union([
  StringLeafSchema,
  NumberLeafSchema,
  z.strictObject({
    kind: z.literal("boolean"),
    attribute: NonEmptyStringSchema,
    operator: z.enum(["equals", "not_equals"]),
    value: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("person_id"),
    attribute: NonEmptyStringSchema,
    operator: z.enum(["equals", "not_equals"]),
    value: PersonIdSchema,
  }),
  z.strictObject({
    kind: z.literal("person_id_array"),
    attribute: NonEmptyStringSchema,
    operator: z.literal("has"),
    value: PersonIdSchema,
  }),
  z.strictObject({
    kind: z.literal("person_id_array"),
    attribute: NonEmptyStringSchema,
    operator: ExternalEventArraySetOperatorSchema,
    value: z.array(PersonIdSchema).min(1),
  }),
  z.strictObject({
    kind: z.literal("string_array"),
    attribute: NonEmptyStringSchema,
    operator: z.literal("has"),
    value: NonEmptyStringSchema,
  }),
  z.strictObject({
    kind: z.literal("string_array"),
    attribute: NonEmptyStringSchema,
    operator: ExternalEventArraySetOperatorSchema,
    value: NonEmptyStringArraySchema,
  }),
  z.strictObject({
    kind: z.literal("presence"),
    attribute: NonEmptyStringSchema,
    operator: ExternalEventPresenceOperatorSchema,
  }),
]);

/**
 * One rule is one AND group. There is no OR inside a rule: a draft that needs
 * "A or B" writes two rules, which is also how they are stored and matched, one
 * registration each.
 *
 * This is the **stored** spelling, and `all` is deliberately unchanged. Three
 * columns hold it — `definition_revisions.evaluator_rules_json` and
 * `automation.evaluator_projection_json` on SidekickDO, and
 * `workspace_external_event_registrations.evaluator_json` on WorkspaceDO, the
 * last parsed by `matchExternalEventDestinations` on the delivery path of every
 * incoming event and the middle one replayed by the `sidekick_publication`
 * alarm and by `resumeFromPause`. Worker versions are deployed gradually and
 * can be rolled back ([api-worker-deployment.md](../../../docs/api-worker-deployment.md)),
 * so a version serving beside or after this one must be able to read anything
 * this one writes. Renaming the discriminant *here* would write rows the
 * previous version cannot parse, and that failure is not a degraded read — it
 * throws mid-match, and every event-driven Sidekick stops waking.
 *
 * The rename that this spelling reads as ambiguous is therefore confined to the
 * model's side of the boundary; see `ModelFacingExternalEventPredicateV1Schema`.
 */
export const ExternalEventPredicateV1Schema = z.union([
  z.strictObject({ kind: z.literal("always") }),
  z.strictObject({
    kind: z.literal("all"),
    allOf: z.array(ExternalEventPredicateLeafV1Schema).min(1),
  }),
]);

/**
 * What the drafting model writes, and the one place `matching` exists.
 *
 * `all` and `always` sit next to each other in a grammar the model authors
 * through `set_evaluator_rules`, and read as near-synonyms: `all` means "every
 * one of these leaves holds", `always` means "every event of this type". The
 * ambiguity landed in authored rules rather than in review comments, so the
 * conjunction is `matching` on the side the model reads.
 *
 * It is a `transform` and not a second stored spelling, which is what keeps the
 * two apart in the only two places that matter. `z.toJSONSchema(…, { io:
 * "input" })` — how `set_evaluator_rules` is described to the model — renders a
 * transform's *input*, so the tool offers `matching` and never `all`; parsing
 * yields the *output*, so nothing downstream of a draft, and nothing written to
 * any of the three columns above, spells it anything but `all`.
 *
 * A future change may rename the stored spelling too, but only once no Worker
 * version that predates it can still serve or be rolled back to — and then this
 * transform becomes an identity and should be deleted rather than left to
 * suggest the two ever disagreed.
 */
export const ModelFacingExternalEventPredicateV1Schema = z.union([
  z.strictObject({ kind: z.literal("always") }),
  z.strictObject({
    kind: z.literal("matching"),
    allOf: z.array(ExternalEventPredicateLeafV1Schema).min(1),
  }),
]).transform((predicate): z.infer<typeof ExternalEventPredicateV1Schema> => (
  predicate.kind === "matching"
    ? { kind: "all", allOf: predicate.allOf }
    : predicate
));

export const ExternalEventEvaluatorV1Schema = z.strictObject({
  evaluatorId: IdSchema.brand<"ExternalEventEvaluatorId">(),
  /** Host-only expansion of a configured rule through another delegated connection. */
  sourceEvaluatorId: IdSchema.optional(),
  source: z.strictObject({
    connectorType: ConnectorTypeSchema,
    connectionId: IdSchema.brand<"ConnectionId">(),
    eventType: NonEmptyStringSchema,
    resourceId: IdSchema.brand<"ResourceId">().optional(),
  }),
  when: ExternalEventPredicateV1Schema,
});

export const AutomationExternalEvaluatorSetV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  automationId: IdSchema,
  definitionRevision: z.number().int().positive(),
  evaluators: z.array(ExternalEventEvaluatorV1Schema),
}).superRefine((value, context) => {
  const identities = new Set<string>();
  const sources = new Set<string>();
  value.evaluators.forEach((evaluator, index) => {
    if (identities.has(evaluator.evaluatorId)) {
      context.addIssue({
        code: "custom",
        path: ["evaluators", index, "evaluatorId"],
        message: "Evaluator IDs must be unique",
      });
    }
    identities.add(evaluator.evaluatorId);
    const source = [
      evaluator.source.connectorType,
      evaluator.source.connectionId,
      evaluator.source.eventType,
      evaluator.source.resourceId ?? "",
    ].join("\u0000");
    if (sources.has(source)) {
      context.addIssue({
        code: "custom",
        path: ["evaluators", index, "source"],
        message: "Evaluator source tuples must be unique",
      });
    }
    sources.add(source);
  });
});

export const DraftEvaluatorKeySchema = z.string().regex(/^[a-z][a-z0-9_-]*$/u).brand<"DraftEvaluatorKey">();
export const DraftExternalEventEvaluatorV1Schema = z.strictObject({
  evaluatorKey: DraftEvaluatorKeySchema,
  source: z.strictObject({
    // The rule half of the join. Described here as well as on the trigger
    // because a label written on only one side is the failure this field
    // produces, and until now only the trigger's half said anything at all —
    // leaving the side that has to match it undocumented.
    sourceBindingKey: ActivitySourceBindingKeySchema
      .describe("The label of the trigger this rule filters, copied exactly from that trigger's `sourceBindingKey` in the draft. You composed that label yourself; no tool returns one, so copy it rather than looking it up or writing a second spelling. A rule whose label matches no trigger in the draft is refused when the draft is submitted."),
    suggestedSourcePluginId: ModelPluginIdSchema,
    event: z.union([
      z.strictObject({ kind: z.literal("event_type"), eventType: NonEmptyStringSchema }),
      z.strictObject({ kind: z.literal("event_family"), eventFamily: NonEmptyStringSchema }),
    ]),
    resourceId: IdSchema.brand<"ResourceId">().optional(),
  }),
  when: ExternalEventPredicateV1Schema,
});

/** One definition of the uniqueness rule, so the two spellings cannot drift. */
function assertUniqueEvaluatorKeys(
  value: { evaluators: ReadonlyArray<{ evaluatorKey: string }> },
  context: z.core.$RefinementCtx,
): void {
  const keys = new Set<string>();
  value.evaluators.forEach((evaluator, index) => {
    if (keys.has(evaluator.evaluatorKey)) {
      context.addIssue({
        code: "custom",
        path: ["evaluators", index, "evaluatorKey"],
        message: "Evaluator keys must be unique",
      });
    }
    keys.add(evaluator.evaluatorKey);
  });
}

export const AutomationSetEvaluatorRulesInputV1Schema = z.strictObject({
  schemaVersion: z.literal(1)
    .describe("Always 1. It fixes how the rules below are read, so a rule set written for a later shape is refused rather than half-understood."),
  evaluators: z.array(DraftExternalEventEvaluatorV1Schema)
    .describe("The complete set of rules deciding which external events wake this Sidekick. It replaces every rule the draft currently has rather than adding to it, so send the whole set each time and send [] to clear it. Each rule needs an `evaluatorKey` unique within the set."),
}).superRefine(assertUniqueEvaluatorKeys);

/**
 * The same rule set as `AutomationSetEvaluatorRulesInputV1Schema`, in the
 * spelling the drafting model writes.
 *
 * It exists for two jobs and no others: rendering `set_evaluator_rules`'s tool
 * schema, where `z.toJSONSchema(…, { io: "input" })` must show `matching`, and
 * parsing that tool's arguments, where the transform yields the stored shape.
 * Everything past the tool — the host port, the object's request schema, the
 * re-parse of `evaluator_rules_json` in `apply` — takes the stored schema,
 * because by then the value has already been through here.
 *
 * Keeping the pair this narrow is deliberate. An earlier attempt pointed the
 * draft evaluator itself at the model-facing predicate, which made the one
 * schema asymmetric: four callers re-parsing a *stored* set with it were then
 * parsing `all` against a union that had been narrowed to `matching`, and
 * `apply` threw on every accepted event-driven Sidekick. The workers suite
 * caught it. The boundary is one tool call wide, so the schema that spans it
 * should be too.
 */
export const AutomationSetEvaluatorRulesModelInputV1Schema = z.strictObject({
  schemaVersion: z.literal(1)
    .describe("Always 1. It fixes how the rules below are read, so a rule set written for a later shape is refused rather than half-understood."),
  evaluators: z.array(DraftExternalEventEvaluatorV1Schema.extend({
    when: ModelFacingExternalEventPredicateV1Schema,
  }))
    .describe("The complete set of rules deciding which external events wake this Sidekick. It replaces every rule the draft currently has rather than adding to it, so send the whole set each time and send [] to clear it. Each rule needs an `evaluatorKey` unique within the set."),
}).superRefine(assertUniqueEvaluatorKeys);

export const ExternalEventDestinationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("automation"), automationId: IdSchema }),
  z.strictObject({
    kind: z.literal("workstream_resource_update"),
    workstreamId: IdSchema,
    substreamId: z.union([z.literal("0"), IdSchema]),
    resourceId: IdSchema,
  }),
]);
export type ExternalEventDestination = z.infer<typeof ExternalEventDestinationSchema>;

/**
 * Complete replacement of one destination's evaluators. A repeat with the same
 * set is equivalent; there is no coordinate to compare and no hash to conflict.
 */
export const ExternalEventRegistrationProjectionV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceId: IdSchema.brand<"WorkspaceId">(),
  destination: ExternalEventDestinationSchema,
  sourceGeneration: z.number().int().nonnegative().optional(),
  evaluators: z.array(ExternalEventEvaluatorV1Schema),
});

/**
 * One matched event for one destination, carried whole.
 *
 * Admission is idempotent on the destination side (an automation keys its run
 * on the event id; a watched work stream keys its receipt on the event and
 * registration ids), so a redelivery is a no-op and the message needs no lease.
 */
export const WorkspaceExternalEventSchema = z.strictObject({
  id: IdSchema,
  eventSequence: z.number().int().positive(),
  eventType: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  summary: z.string(),
  /**
   * What the run that this event wakes gets to read. The matcher already
   * evaluated the rule over these; without them the run knew only that
   * something of this type happened, and could not name the deployed service
   * its own rule had just selected on.
   */
  textSnippet: z.string().default(""),
  metadata: z.record(z.string(), z.unknown()).default({}),
  /** The occurrence the connector named, lifted by the workspace store from the activity's own field — never from its metadata. */
  occurrenceKey: z.string().min(1).optional(),
  occurredAt: z.number().int().nonnegative(),
  audienceUserIds: z.array(IdSchema),
  audienceKind: z.enum(["workspace", "restricted"]),
  /** Host-written source identity. Older queued deliveries resolve this from their registration. */
  sourceConnectionId: IdSchema.optional(),
  sourceConnectionScope: z.enum(["personal", "workspace"]).optional(),
  sourceConnectionOwnerUserId: IdSchema.nullable().optional(),
});
export type WorkspaceExternalEvent = z.infer<typeof WorkspaceExternalEventSchema>;

/**
 * What an automation admits an event under.
 *
 * Two key spaces that cannot meet: `occurrence:<key>` when the connector named
 * the occurrence — one thing in the world that more than one delivery can
 * report, such as a Granola note that arrives as `note.access_granted` when it
 * is shared and as `note.generated` when its summary is written — and
 * `external:<event id>` otherwise. The key is adapter-authored and namespaced
 * by provider (`granola:<connection>:note:<id>:transcript`); the workspace
 * store lifts it only from the activity's own field, never from provider
 * metadata, so no payload can plant one. No length bound: only Rally's own
 * adapters write it, and a limit against our own code is the wrong tool.
 */
export function externalEventOccurrenceKey(event: Pick<WorkspaceExternalEvent, "id" | "occurrenceKey">): string {
  return event.occurrenceKey ? `occurrence:${event.occurrenceKey}` : `external:${event.id}`;
}

export const WorkspaceExternalEventDeliveryQueueMessageSchema = z.strictObject({
  type: z.literal("workspace_external_event_delivery_v1"),
  schemaVersion: z.literal(1),
  region: RegionSchema,
  workspaceId: IdSchema.brand<"WorkspaceId">(),
  registrationId: IdSchema,
  destination: ExternalEventDestinationSchema,
  event: WorkspaceExternalEventSchema,
  payloadHash: NonEmptyStringSchema,
});

export const WorkspaceExternalEventMatchResultSchema = z.strictObject({
  /** Whether any registration matched, whatever was already delivered. */
  matched: z.boolean(),
  deliveries: z.array(WorkspaceExternalEventDeliveryQueueMessageSchema),
});

export const ConnectorActivityFilterValueTypeV2Schema = z.enum([
  "string",
  "number",
  "boolean",
  "string_array",
  "person_id",
  "person_id_array",
]);

/**
 * How an activity's event relates to the resource it names.
 *
 * `file` and `thread` name the watched entity itself rather than a container it
 * sits in — Notion's `page` is the precedent. A Drive file and a mail thread are
 * each the thing somebody attached and turned watching on for, and neither is a
 * `folder` or a `parent`.
 */
export const ConnectorResourceRelationshipSchema = z.enum([
  "channel",
  "file",
  "folder",
  "parent",
  "project",
  "repository",
  "page",
  "thread",
  "application",
]);

export const ConnectorActivityTriggerDescriptorV2Schema = z.strictObject({
  eventType: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  eventFamilies: z.array(NonEmptyStringSchema),
  filterFields: z.array(z.strictObject({
    key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/u),
    label: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    valueType: ConnectorActivityFilterValueTypeV2Schema,
    operators: z.array(ExternalEventOperatorSchema).min(1),
    sensitive: z.boolean(),
  })),
  resourceRelationships: z.array(z.strictObject({
    relationship: ConnectorResourceRelationshipSchema,
    resourceType: NonEmptyStringSchema,
  })),
  digestible: z.boolean(),
  /**
   * The payload's own keys are the filter fields. A generic webhook carries
   * whatever its caller posts, so no list can be declared ahead of it; a rule
   * may then name any metadata key with any operator, and the event's
   * flattened metadata is what the leaf is read against.
   */
  openFilterFields: z.boolean().optional(),
});

export type ExternalEventPredicateLeafV1 = z.infer<typeof ExternalEventPredicateLeafV1Schema>;
export type ExternalEventPredicateV1 = z.infer<typeof ExternalEventPredicateV1Schema>;
export type ExternalEventEvaluatorV1 = z.infer<typeof ExternalEventEvaluatorV1Schema>;
export type AutomationExternalEvaluatorSetV1 = z.infer<typeof AutomationExternalEvaluatorSetV1Schema>;
export type DraftExternalEventEvaluatorV1 = z.infer<typeof DraftExternalEventEvaluatorV1Schema>;
export type AutomationSetEvaluatorRulesInputV1 = z.infer<typeof AutomationSetEvaluatorRulesInputV1Schema>;
export type AutomationSetEvaluatorRulesModelInputV1 = z.infer<typeof AutomationSetEvaluatorRulesModelInputV1Schema>;
export type ExternalEventRegistrationProjectionV1 = z.infer<typeof ExternalEventRegistrationProjectionV1Schema>;
export type WorkspaceExternalEventDeliveryQueueMessage = z.infer<typeof WorkspaceExternalEventDeliveryQueueMessageSchema>;
export type ConnectorActivityTriggerDescriptorV2 = z.infer<typeof ConnectorActivityTriggerDescriptorV2Schema>;

/**
 * What a rule normalizer needs to know about a plugin's triggers: which event
 * types it declares, the families they belong to, and whether any of them can
 * be narrowed to one resource.
 */
export interface AutomationRuleTriggerShape {
  eventType: string;
  eventFamilies?: readonly string[] | undefined;
  resourceRelationships?: readonly unknown[] | undefined;
}

/**
 * One resource type an evaluator rule may name, and the relationships through
 * which the triggers reach it.
 */
export interface AutomationBindableResourceType {
  resourceType: string;
  relationships: readonly string[];
}

/**
 * The resource types a rule may narrow itself to, given the triggers it could
 * match.
 *
 * The one answer to "may this rule name that resource": a `resourceId` is
 * admitted only where the event's own descriptor declares a relationship to
 * that resource's type, so every type outside this set is a refusal the
 * validators are certain to reach. Every caller asks it here rather than
 * walking `resourceRelationships` again — the normalizer, both validators, the
 * watched-resource reconciler, and the search that decides what to offer at
 * all. Why that last one forced the extraction is in
 * `docs/automation-lifecycle.md`'s changelog.
 *
 * Shape-tolerant in the way {@link withoutUnusableAutomationResourceIds} is:
 * it reads descriptors both before and after their schema parse, so a
 * relationship it cannot read is one it leaves out rather than throws on.
 */
export function automationBindableResourceTypes(
  triggers: readonly AutomationRuleTriggerShape[],
): readonly AutomationBindableResourceType[] {
  const relationshipsByResourceType = new Map<string, string[]>();
  for (const trigger of triggers) {
    for (const declared of trigger.resourceRelationships ?? []) {
      if (!declared || typeof declared !== "object" || Array.isArray(declared)) continue;
      const { relationship, resourceType } = declared as Record<string, unknown>;
      if (typeof resourceType !== "string" || resourceType.length === 0) continue;
      const relationships = relationshipsByResourceType.get(resourceType) ?? [];
      if (typeof relationship === "string" && relationship.length > 0 && !relationships.includes(relationship)) {
        relationships.push(relationship);
      }
      relationshipsByResourceType.set(resourceType, relationships);
    }
  }
  return [...relationshipsByResourceType].map(([resourceType, relationships]) => ({
    resourceType,
    relationships,
  }));
}

/**
 * Whether a rule matching these triggers may name a resource of this type.
 *
 * The predicate every validator asks, kept beside the set rather than rederived
 * at each call site: search offering a type acceptance would refuse, or
 * refusing one it would admit, is the single defect this pair exists to make
 * unrepresentable.
 */
export function automationTriggersAdmitResourceType(
  triggers: readonly AutomationRuleTriggerShape[],
  resourceType: string,
): boolean {
  return automationBindableResourceTypes(triggers)
    .some((bindable) => bindable.resourceType === resourceType);
}

const ZERO_PAYLOAD_ID = /^0{8}-0{4}-[0-9a-f]0{3}-[0-9a-f]0{3}-0{12}$/u;
const FULL_PAYLOAD_ID = /^f{8}-f{4}-[0-9a-f]f{3}-[0-9a-f]f{3}-f{12}$/u;

/**
 * Whether a `resourceId` means "none".
 *
 * `resourceId` is optional, and some models fill every declared property
 * regardless. What they reach for is a placeholder: the nil UUID, the max
 * UUID, or either reshaped to satisfy the version and variant nibbles the id
 * pattern asks for. Every one of those is all zeros or all `f` apart from
 * those two nibbles, and no real id looks like that.
 */
export function isSentinelAutomationResourceId(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const normalized = value.trim().toLowerCase();
  return normalized === "" || ZERO_PAYLOAD_ID.test(normalized) || FULL_PAYLOAD_ID.test(normalized);
}

/**
 * Drop a rule's `resourceId` where it cannot mean anything.
 *
 * Two cases, applied wherever a rule enters an automation: the tool call, the
 * receipt replay that rebuilds draft state on a later turn, and the accept
 * path that reads the stored revision. The first is a sentinel, see
 * {@link isSentinelAutomationResourceId}. The second is structural: when none
 * of the triggers the rule names declares a resource relationship, no id could
 * be legitimate, so whatever the model put there is noise rather than a
 * reference to check. A trigger that does declare relationships keeps the id,
 * and an unknown one is still refused by the validators that follow.
 *
 * Shape-tolerant on purpose: it runs before the schema parse, so it leaves
 * anything it does not recognize for the parse to describe.
 */
export function withoutUnusableAutomationResourceIds(
  raw: unknown,
  triggersForPlugin: (pluginId: string) => readonly AutomationRuleTriggerShape[] | undefined,
): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.evaluators)) return raw;
  return {
    ...record,
    evaluators: record.evaluators.map((evaluator) => {
      if (!evaluator || typeof evaluator !== "object" || Array.isArray(evaluator)) return evaluator;
      const source = (evaluator as Record<string, unknown>).source;
      if (!source || typeof source !== "object" || Array.isArray(source)) return evaluator;
      const { resourceId, ...rest } = source as Record<string, unknown>;
      if (resourceId === undefined) return evaluator;
      const unusable = resourceId === null
        || isSentinelAutomationResourceId(resourceId)
        || !ruleTriggersCanNameAResource(rest, triggersForPlugin);
      if (!unusable) return evaluator;
      return { ...(evaluator as Record<string, unknown>), source: rest };
    }),
  };
}

function ruleTriggersCanNameAResource(
  source: Record<string, unknown>,
  triggersForPlugin: (pluginId: string) => readonly AutomationRuleTriggerShape[] | undefined,
): boolean {
  const pluginId = source.suggestedSourcePluginId;
  const triggers = typeof pluginId === "string" ? triggersForPlugin(pluginId) : undefined;
  // An unknown plugin or a malformed event is the validator's to refuse, with
  // the id still in place so the refusal describes what the model sent.
  if (!triggers) return true;
  const event = source.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return true;
  const { kind, eventType, eventFamily } = event as Record<string, unknown>;
  const named = kind === "event_type" && typeof eventType === "string"
    ? triggers.filter((trigger) => trigger.eventType === eventType)
    : kind === "event_family" && typeof eventFamily === "string"
      ? triggers.filter((trigger) => (trigger.eventFamilies ?? []).includes(eventFamily))
      : [];
  if (named.length === 0) return true;
  return automationBindableResourceTypes(named).length > 0;
}
