import { z } from "zod";
import {
  IdSchema,
  UserIdSchema,
} from "./identifiers";

export const AutomationIdSchema = IdSchema.brand<"AutomationId">();
export type AutomationId = z.infer<typeof AutomationIdSchema>;
export const asAutomationId = (value: string): AutomationId => AutomationIdSchema.parse(value);

/**
 * Who can see an automation and who may change it — and nothing else.
 *
 * Deliberately not `ScopeSchema`, which a work stream shares: a work stream has
 * no third scope, and widening the shared enum would offer `workstream` in
 * every place a room's audience is chosen.
 *
 * Scope is not a destination. The one place a result goes because of what the
 * automation *is* is the room that owns a `workstream`-scoped one, and a run
 * sends there with its own tool.
 */
export const AutomationScopeSchema = z.enum(["personal", "workspace", "workstream"]);
export type AutomationScope = z.infer<typeof AutomationScopeSchema>;

export const AutomationLifecycleStateSchema = z.enum(["draft", "active", "paused", "deleted"]);
export type AutomationLifecycleState = z.infer<typeof AutomationLifecycleStateSchema>;

export const AutomationRunTriggerV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("manual"), requestedByUserId: UserIdSchema }),
  z.strictObject({
    kind: z.literal("schedule"),
    scheduleId: IdSchema,
    scheduleKind: z.enum(["calendar", "interval"]),
    plannedFor: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("external_event"),
    workspaceEventId: IdSchema,
    eventType: z.string().min(1),
    occurredAt: z.number().int().nonnegative(),
    payloadHash: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("inbound_email"),
    receiptId: IdSchema,
    occurredAt: z.number().int().nonnegative(),
  }),
]);
export type AutomationRunTriggerV1 = z.infer<typeof AutomationRunTriggerV1Schema>;

/**
 * What a run carries into its loop: a reference, not a copy.
 *
 * A definition revision is immutable, so the run reads it from its parent at
 * start (`readRunDefinition`) rather than freezing a copy the contract would
 * then have to migrate whenever a field changed shape. The run id is also the
 * child substream id under the automation.
 */
export const AutomationRunReferenceV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  automationId: AutomationIdSchema,
  runId: IdSchema,
  definitionRevision: z.number().int().positive(),
  trigger: AutomationRunTriggerV1Schema,
});
export type AutomationRunReferenceV1 = z.infer<typeof AutomationRunReferenceV1Schema>;

/**
 * What an automation delivered into a work stream, as the row's typed content.
 *
 * The row itself is an ordinary message authored by "Automation"; everything
 * specific to an activation lives here, inside the `structuredContent` every
 * other typed row already uses.
 */
export const AutomationActivationV1Schema = z.strictObject({
  type: z.literal("automation_activation"),
  schemaVersion: z.literal(1),
  automationId: AutomationIdSchema,
  /** Frozen at delivery so a later rename does not rewrite history. */
  automationName: z.string().min(1).max(300),
  /** The run that produced it, which is also its substream under the automation. */
  runId: IdSchema,
  deliveryId: z.string().min(1).max(200),
  /**
   * Provenance a reader and the model can both see. It narrows nothing about
   * what the woken run may do; the untrusted label carries the difference in
   * how far to trust the text.
   */
  trigger: z.strictObject({
    kind: z.enum(["manual", "schedule", "external_event", "inbound_email"]),
  }).strict(),
  occurredAt: z.number().int().nonnegative(),
});
export type AutomationActivationV1 = z.infer<typeof AutomationActivationV1Schema>;

/**
 * The card proposing an automation an agent drafted in this work stream.
 *
 * A `system` row: Rally noting that something now exists for the room to look
 * at. The draft lives on the automation, whose own conversation is where it is
 * reviewed, created, and later edited; this carries only what the card shows
 * and the id it links to.
 */
export const AutomationDraftProposedV1Schema = z.strictObject({
  type: z.literal("automation_draft_proposed"),
  schemaVersion: z.literal(1),
  automationId: AutomationIdSchema,
  automationName: z.string().min(1).max(300),
  description: z.string().min(1).max(1200),
  /** One line per trigger, already rendered: the card shows them, not parses them. */
  triggerSummaries: z.array(z.string().min(1).max(300)).max(10),
  suggestedScope: AutomationScopeSchema,
  /** False when the agent still has a blocking question. */
  ready: z.boolean(),
});
export type AutomationDraftProposedV1 = z.infer<typeof AutomationDraftProposedV1Schema>;
