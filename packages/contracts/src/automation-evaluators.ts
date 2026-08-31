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
  z.object({
    kind: z.literal("string"),
    attribute: NonEmptyStringSchema,
    operator: ExternalEventStringOperatorSchema,
    value: NonEmptyStringSchema,
  }).strict(),
  z.object({
    kind: z.literal("string"),
    attribute: NonEmptyStringSchema,
    operator: ExternalEventStringSetOperatorSchema,
    value: NonEmptyStringArraySchema,
  }).strict(),
]);

const NumberLeafSchema = z.union([
  z.object({
    kind: z.literal("number"),
    attribute: NonEmptyStringSchema,
    operator: ExternalEventNumberOperatorSchema,
    value: FiniteNumberSchema,
  }).strict(),
  z.object({
    kind: z.literal("number"),
    attribute: NonEmptyStringSchema,
    operator: ExternalEventStringSetOperatorSchema,
    value: FiniteNumberArraySchema,
  }).strict(),
]);

export const ExternalEventPredicateLeafV1Schema = z.union([
  StringLeafSchema,
  NumberLeafSchema,
  z.object({
    kind: z.literal("boolean"),
    attribute: NonEmptyStringSchema,
    operator: z.enum(["equals", "not_equals"]),
    value: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("person_id"),
    attribute: NonEmptyStringSchema,
    operator: z.enum(["equals", "not_equals"]),
    value: PersonIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("person_id_array"),
    attribute: NonEmptyStringSchema,
    operator: z.literal("has"),
    value: PersonIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("person_id_array"),
    attribute: NonEmptyStringSchema,
    operator: ExternalEventArraySetOperatorSchema,
    value: z.array(PersonIdSchema).min(1),
  }).strict(),
  z.object({
    kind: z.literal("string_array"),
    attribute: NonEmptyStringSchema,
    operator: z.literal("has"),
    value: NonEmptyStringSchema,
  }).strict(),
  z.object({
    kind: z.literal("string_array"),
    attribute: NonEmptyStringSchema,
    operator: ExternalEventArraySetOperatorSchema,
    value: NonEmptyStringArraySchema,
  }).strict(),
  z.object({
    kind: z.literal("presence"),
    attribute: NonEmptyStringSchema,
    operator: ExternalEventPresenceOperatorSchema,
  }).strict(),
]);

export const ExternalEventPredicateV1Schema = z.union([
  z.object({ kind: z.literal("always") }).strict(),
  z.object({
    kind: z.literal("dnf"),
    anyOf: z.array(z.object({
      allOf: z.array(ExternalEventPredicateLeafV1Schema).min(1),
    }).strict()).min(1),
  }).strict(),
]);

export const ExternalEventEvaluatorV1Schema = z.object({
  evaluatorId: IdSchema.brand<"ExternalEventEvaluatorId">(),
  source: z.object({
    connectorType: ConnectorTypeSchema,
    connectionId: IdSchema.brand<"ConnectionId">(),
    eventType: NonEmptyStringSchema,
    resourceId: IdSchema.brand<"ResourceId">().optional(),
  }).strict(),
  when: ExternalEventPredicateV1Schema,
}).strict();

export const AutomationExternalEvaluatorSetV1Schema = z.object({
  schemaVersion: z.literal(1),
  automationId: IdSchema.brand<"AutomationId">(),
  definitionRevision: z.number().int().positive().brand<"AutomationDefinitionRevision">(),
  authorityGeneration: z.number().int().positive().brand<"AutomationAuthorityGeneration">(),
  projectionVersion: z.number().int().positive().brand<"AutomationEvaluatorProjectionVersion">(),
  evaluators: z.array(ExternalEventEvaluatorV1Schema),
}).strict().superRefine((value, context) => {
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
export const DraftExternalEventEvaluatorV1Schema = z.object({
  evaluatorKey: DraftEvaluatorKeySchema,
  source: z.object({
    sourceBindingKey: ActivitySourceBindingKeySchema,
    suggestedSourcePluginId: ModelPluginIdSchema,
    event: z.union([
      z.object({ kind: z.literal("event_type"), eventType: NonEmptyStringSchema }).strict(),
      z.object({ kind: z.literal("event_family"), eventFamily: NonEmptyStringSchema }).strict(),
    ]),
    resourceId: IdSchema.brand<"ResourceId">().optional(),
  }).strict(),
  when: ExternalEventPredicateV1Schema,
}).strict();

export const AutomationSetEvaluatorRulesInputV1Schema = z.object({
  schemaVersion: z.literal(1),
  evaluators: z.array(DraftExternalEventEvaluatorV1Schema),
}).strict().superRefine((value, context) => {
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

export const ExternalEventRegistrationProjectionV1Schema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: IdSchema.brand<"WorkspaceId">(),
  destination: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("automation"), automationId: IdSchema }).strict(),
    z.object({
      kind: z.literal("workstream_resource_update"),
      workstreamId: IdSchema,
      substreamId: z.union([z.literal("0"), IdSchema]),
      resourceId: IdSchema,
    }).strict(),
  ]),
  authorityGeneration: z.number().int().positive(),
  projectionVersion: z.number().int().positive(),
  sourceHash: NonEmptyStringSchema,
  evaluators: z.array(ExternalEventEvaluatorV1Schema),
}).strict();

export const WorkspaceExternalEventDeliveryQueueMessageSchema = z.object({
  type: z.literal("workspace_external_event_delivery_v1"),
  schemaVersion: z.literal(1),
  region: z.enum(["global", "eu"]),
  workspaceId: IdSchema.brand<"WorkspaceId">(),
  workspaceEventId: IdSchema,
  deliveryId: IdSchema,
  payloadHash: NonEmptyStringSchema,
}).strict();

export const WorkspaceExternalEventMatchResultSchema = z.object({
  /**
   * Durable claim witness across retries. Unlike `deliveries`, this remains
   * true after matching deliveries have already settled and no longer need to
   * be re-enqueued.
   */
  claimed: z.boolean(),
  deliveries: z.array(WorkspaceExternalEventDeliveryQueueMessageSchema),
}).strict();

export const WorkspaceExternalEventDeliveryClaimRequestSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: IdSchema.brand<"WorkspaceId">(),
  workspaceEventId: IdSchema,
  deliveryId: IdSchema,
  payloadHash: NonEmptyStringSchema,
  leaseId: IdSchema,
}).strict();

export const WorkspaceExternalEventDeliveryClaimResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("delivered") }).strict(),
  z.object({ outcome: z.literal("busy"), retryAt: z.number().int().nonnegative() }).strict(),
  z.object({
    outcome: z.literal("claimed"),
    leaseExpiresAt: z.number().int().nonnegative(),
    destination: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("automation"),
        automationId: IdSchema,
        authorityGeneration: z.number().int().positive(),
        projectionVersion: z.number().int().positive(),
      }).strict(),
      z.object({
        kind: z.literal("workstream_resource_update"),
        workstreamId: IdSchema,
        substreamId: z.union([z.literal("0"), IdSchema]),
        resourceId: IdSchema,
        authorityGeneration: z.number().int().positive(),
        projectionVersion: z.number().int().positive(),
      }).strict(),
    ]),
    event: z.object({
      id: IdSchema,
      eventSequence: z.number().int().positive(),
      eventType: NonEmptyStringSchema,
      title: NonEmptyStringSchema,
      summary: z.string(),
      occurredAt: z.number().int().nonnegative(),
      audienceUserIds: z.array(IdSchema),
      audienceKind: z.enum(["workspace", "restricted"]),
    }).strict(),
  }).strict(),
]);

export const WorkspaceExternalEventDeliverySettleRequestSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: IdSchema.brand<"WorkspaceId">(),
  deliveryId: IdSchema,
  leaseId: IdSchema,
  outcome: z.enum(["delivered", "not_delivered"]),
  outcomeCode: NonEmptyStringSchema,
}).strict();

export const ConnectorActivityFilterValueTypeV2Schema = z.enum([
  "string",
  "number",
  "boolean",
  "string_array",
  "person_id",
  "person_id_array",
]);

export const ConnectorResourceRelationshipSchema = z.enum([
  "channel",
  "folder",
  "parent",
  "project",
  "repository",
  "page",
  "application",
]);

export const ConnectorActivityTriggerDescriptorV2Schema = z.object({
  eventType: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  eventFamilies: z.array(NonEmptyStringSchema),
  filterFields: z.array(z.object({
    key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/u),
    label: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    valueType: ConnectorActivityFilterValueTypeV2Schema,
    operators: z.array(ExternalEventOperatorSchema).min(1),
    sensitive: z.boolean(),
  }).strict()),
  resourceRelationships: z.array(z.object({
    relationship: ConnectorResourceRelationshipSchema,
    resourceType: NonEmptyStringSchema,
  }).strict()),
  digestible: z.boolean(),
}).strict();

export type ExternalEventPredicateLeafV1 = z.infer<typeof ExternalEventPredicateLeafV1Schema>;
export type ExternalEventPredicateV1 = z.infer<typeof ExternalEventPredicateV1Schema>;
export type ExternalEventEvaluatorV1 = z.infer<typeof ExternalEventEvaluatorV1Schema>;
export type AutomationExternalEvaluatorSetV1 = z.infer<typeof AutomationExternalEvaluatorSetV1Schema>;
export type DraftExternalEventEvaluatorV1 = z.infer<typeof DraftExternalEventEvaluatorV1Schema>;
export type AutomationSetEvaluatorRulesInputV1 = z.infer<typeof AutomationSetEvaluatorRulesInputV1Schema>;
export type ExternalEventRegistrationProjectionV1 = z.infer<typeof ExternalEventRegistrationProjectionV1Schema>;
export type WorkspaceExternalEventDeliveryQueueMessage = z.infer<typeof WorkspaceExternalEventDeliveryQueueMessageSchema>;
export type WorkspaceExternalEventDeliveryClaimResult = z.infer<typeof WorkspaceExternalEventDeliveryClaimResultSchema>;
export type ConnectorActivityTriggerDescriptorV2 = z.infer<typeof ConnectorActivityTriggerDescriptorV2Schema>;
