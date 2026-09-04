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

export const ConnectorTypeSchema = z.enum([
  "google",
  "generic_webhook",
  "github",
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
 */
export const ExternalEventPredicateV1Schema = z.union([
  z.strictObject({ kind: z.literal("always") }),
  z.strictObject({
    kind: z.literal("all"),
    allOf: z.array(ExternalEventPredicateLeafV1Schema).min(1),
  }),
]);

export const ExternalEventEvaluatorV1Schema = z.strictObject({
  evaluatorId: IdSchema.brand<"ExternalEventEvaluatorId">(),
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
    sourceBindingKey: ActivitySourceBindingKeySchema,
    suggestedSourcePluginId: ModelPluginIdSchema,
    event: z.union([
      z.strictObject({ kind: z.literal("event_type"), eventType: NonEmptyStringSchema }),
      z.strictObject({ kind: z.literal("event_family"), eventFamily: NonEmptyStringSchema }),
    ]),
    resourceId: IdSchema.brand<"ResourceId">().optional(),
  }),
  when: ExternalEventPredicateV1Schema,
});

export const AutomationSetEvaluatorRulesInputV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  evaluators: z.array(DraftExternalEventEvaluatorV1Schema),
}).superRefine((value, context) => {
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
});

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
  occurredAt: z.number().int().nonnegative(),
  audienceUserIds: z.array(IdSchema),
  audienceKind: z.enum(["workspace", "restricted"]),
});
export type WorkspaceExternalEvent = z.infer<typeof WorkspaceExternalEventSchema>;

export const WorkspaceExternalEventDeliveryQueueMessageSchema = z.strictObject({
  type: z.literal("workspace_external_event_delivery_v1"),
  schemaVersion: z.literal(1),
  region: z.enum(["global", "eu"]),
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
export type ExternalEventRegistrationProjectionV1 = z.infer<typeof ExternalEventRegistrationProjectionV1Schema>;
export type WorkspaceExternalEventDeliveryQueueMessage = z.infer<typeof WorkspaceExternalEventDeliveryQueueMessageSchema>;
export type ConnectorActivityTriggerDescriptorV2 = z.infer<typeof ConnectorActivityTriggerDescriptorV2Schema>;
