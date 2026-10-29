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
  /**
   * The run that produced it, which is also its substream under the automation.
   * A `conversation_post` from the Sidekick's configuration conversation has no
   * run, and carries that loop's harness run id instead.
   */
  runId: IdSchema,
  deliveryId: z.string().min(1).max(200),
  /**
   * Provenance a reader and the model can both see. It narrows nothing about
   * what the woken run may do; the untrusted label carries the difference in
   * how far to trust the text. Absent on a post from the configuration
   * conversation, which no trigger started.
   */
  trigger: z.strictObject({
    kind: z.enum(["manual", "schedule", "external_event", "inbound_email"]),
  }).strict().optional(),
  occurredAt: z.number().int().nonnegative(),
  /**
   * The person outside Rally whose words this post forwards, when the run was
   * continued by a message from a bound external thread. Host-derived from
   * that message, never from the model, so a later reader of the conversation
   * can tell forwarded external text from the Sidekick's own.
   */
  externalSource: z.strictObject({
    provider: z.string().min(1).max(80),
    displayName: z.string().min(1).max(180),
  }).optional(),
});
export type AutomationActivationV1 = z.infer<typeof AutomationActivationV1Schema>;

/**
 * The notice the host writes into a Sidekick's authoring conversation when a
 * scheduled self-review is due: the structured content of that `system` row,
 * and what the review Queue message carries. Counts, and a sample of run ids
 * the host picked so the wizard reads a bounded set however many runs there
 * were; nothing here is a second copy of a run. `since` is the previous
 * review, or null for the first. Every count and every sampled run is a run
 * under `definitionRevision`: an earlier revision's runs followed an earlier
 * procedure and are not this review's evidence.
 */
export const SidekickReviewNoticeV1Schema = z.strictObject({
  kind: z.literal("sidekick_review_due"),
  schemaVersion: z.literal(1),
  reviewId: IdSchema,
  automationId: AutomationIdSchema,
  /** The accepted definition revision when the review was requested. */
  definitionRevision: z.number().int().positive(),
  since: z.string().datetime({ offset: true }).nullable(),
  until: z.string().datetime({ offset: true }),
  /**
   * Where the wizard announces a change, as the conversation tools name it:
   * a room's Sidekick's home (its Thread's Main conversation or a Breakout),
   * an Organization Sidekick's General Channel (or its author's Personal
   * Channel when General is archived or absent), or a personal Sidekick's
   * author's Personal Channel. Null when no such conversation exists yet.
   */
  announceTo: z.string().min(1).nullable(),
  /** Runs that finished in the window, by the state they finished in; `needsInput` is runs waiting, not finishes. */
  finished: z.strictObject({
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    needsInput: z.number().int().nonnegative(),
    stopped: z.number().int().nonnegative(),
  }),
  /**
   * The runs to read, chosen by the host: failed runs, then stopped ones,
   * newest first, up to a limit; runs waiting for input the same way; and
   * completed runs spaced evenly across the window, newest first, so a
   * Sidekick that ran a thousand times is read at the same cost as one that
   * ran twenty. A list shorter than its limit is every such run.
   */
  sample: z.strictObject({
    failed: z.array(IdSchema),
    needsInput: z.array(IdSchema),
    completed: z.array(IdSchema),
  }),
});
export type SidekickReviewNoticeV1 = z.infer<typeof SidekickReviewNoticeV1Schema>;

/**
 * The Sidekick's name, off an activation row's structured content.
 *
 * Frozen at delivery rather than looked up, so a rename does not rewrite what
 * an earlier conversation said. A malformed or absent object is not worth
 * failing a whole projection over: the text still arrives, under a name that
 * says only what it is.
 */
export function automationActivationName(structuredContent: unknown): string {
  const parsed = AutomationActivationV1Schema.safeParse(structuredContent);
  return parsed.success ? parsed.data.automationName : "Sidekick";
}

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
