import { z } from "zod";
import { IdSchema, UserIdSchema } from "./identifiers";
import { PersonalPresentationSchema } from "./onboarding";

/**
 * A Sidekick source: one person's permission for events they can see on one
 * connection to start this Sidekick.
 *
 * It is not delegation. Delegation lends a person's accounts to a run's tools;
 * a source lets events in and lends nothing. `docs/sidekick-sources.md` owns
 * the mechanism.
 */
const ConnectorTypeNameSchema = z.string().min(1);
const EventTypesSchema = z.array(z.string().min(1)).min(1);
/** The person's own filter: an event enters only when this sentence holds for it. */
const SourceConditionSchema = z.string().trim().min(1).nullable();

export const SidekickSourceOriginSchema = z.enum(["own_definition", "request", "migration"]);

/** Internal record. Membership incarnation and provenance never reach a tool or a client. */
export const SidekickSourceSchema = z.strictObject({
  sidekickId: IdSchema,
  userId: UserIdSchema,
  connectionId: IdSchema,
  connectorType: ConnectorTypeNameSchema,
  eventTypes: EventTypesSchema,
  condition: SourceConditionSchema,
  membershipIncarnation: z.string().min(1),
  origin: SidekickSourceOriginSchema,
  requestId: IdSchema.nullable(),
  approvedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type SidekickSource = z.infer<typeof SidekickSourceSchema>;

export const SidekickSourceRequestStateSchema = z.enum(["pending", "approved", "declined", "cancelled"]);
export type SidekickSourceRequestState = z.infer<typeof SidekickSourceRequestStateSchema>;

/** Where a request's card is shown: the conversation it was asked from. */
export const SidekickSourceRequestPlaceSchema = z.strictObject({
  parentKind: z.enum(["canvas", "automation"]),
  parentId: IdSchema,
});

/** One ask of one person. Only that person decides it. */
export const SidekickSourceRequestSchema = z.strictObject({
  requestId: IdSchema,
  sidekickId: IdSchema,
  userId: UserIdSchema,
  connectorType: ConnectorTypeNameSchema,
  eventTypes: EventTypesSchema,
  condition: SourceConditionSchema,
  state: SidekickSourceRequestStateSchema,
  requestedByUserId: UserIdSchema,
  requestedByName: z.string(),
  place: SidekickSourceRequestPlaceSchema.nullable(),
  createdAt: z.number().int().nonnegative(),
  decidedAt: z.number().int().nonnegative().nullable(),
});
export type SidekickSourceRequest = z.infer<typeof SidekickSourceRequestSchema>;

const SourcePersonSchema = z.strictObject({
  userId: UserIdSchema,
  displayName: z.string(),
  avatarUrl: z.string().nullable().optional(),
  presentation: PersonalPresentationSchema.nullable().optional(),
});

/** What a person reads about one request: who is asked, for what, and where it stands. */
export const SidekickSourceRequestViewSchema = z.object({
  requestId: IdSchema,
  sidekickId: IdSchema,
  sidekickName: z.string(),
  person: SourcePersonSchema,
  connectorType: ConnectorTypeNameSchema,
  eventTypes: EventTypesSchema,
  condition: SourceConditionSchema,
  state: SidekickSourceRequestStateSchema,
  requestedByName: z.string(),
  /** Whether the reader is the person asked, the only one who may decide. */
  yours: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  decidedAt: z.number().int().nonnegative().nullable(),
});
export type SidekickSourceRequestView = z.infer<typeof SidekickSourceRequestViewSchema>;

/** `GET /automations/:id/sources`: who lets events in, and who has been asked. */
export const SidekickSourcesResultSchema = z.object({
  sidekickId: IdSchema,
  sources: z.array(z.object({
    person: SourcePersonSchema,
    connectionId: IdSchema,
    /** The connection's own name, such as the mailbox address. */
    connectionName: z.string(),
    connectorType: ConnectorTypeNameSchema,
    eventTypes: EventTypesSchema,
    condition: SourceConditionSchema,
    /** False while the person is out of the Organization: the source lets nothing in. */
    available: z.boolean(),
    yours: z.boolean(),
  })),
  requests: z.array(SidekickSourceRequestViewSchema),
});
export type SidekickSourcesResult = z.infer<typeof SidekickSourcesResultSchema>;

/** `POST /automations/:id/source-requests`: a manager asks people for a source. */
export const SidekickSourceRequestInputSchema = z.strictObject({
  userIds: z.array(UserIdSchema).min(1),
  connectorType: ConnectorTypeNameSchema,
  eventTypes: EventTypesSchema,
  condition: SourceConditionSchema.optional(),
  place: SidekickSourceRequestPlaceSchema.nullable().optional(),
  /**
   * The asking operation's own stable id (an agent tool call's receipt). An
   * ask repeated under the same id answers with the requests it already made,
   * so a retried call never asks a person again who has since answered.
   */
  operationId: IdSchema.optional(),
});
export type SidekickSourceRequestInput = z.infer<typeof SidekickSourceRequestInputSchema>;

export const SidekickSourceRequestResultSchema = z.object({
  sidekickId: IdSchema,
  requests: z.array(SidekickSourceRequestViewSchema),
});
export type SidekickSourceRequestResult = z.infer<typeof SidekickSourceRequestResultSchema>;

/** `POST /automations/:id/source-requests/:requestId/decision`. */
export const SidekickSourceDecisionInputSchema = z.strictObject({ decision: z.enum(["approve", "decline"]) });
export type SidekickSourceDecisionInput = z.infer<typeof SidekickSourceDecisionInputSchema>;

/** `POST /automations/:id/sources/withdraw`: a person takes their own source back. */
export const SidekickSourceWithdrawInputSchema = z.strictObject({ connectionId: IdSchema });

export const SIDEKICK_SOURCE_ERRORS = {
  sidekick_source_request_not_found: "This request does not exist.",
  sidekick_source_request_not_yours: "Only the person asked can answer this request.",
  sidekick_source_request_settled: "This request was already answered.",
  sidekick_source_request_requires_manager: "Only the people who manage this Sidekick can ask for a source.",
  sidekick_source_person_unavailable: "That person is not an active member of this Organization.",
  sidekick_source_membership_unavailable: "Your Organization membership is unavailable, so this cannot be approved.",
  sidekick_source_connection_missing: "Connect that account first. There is nothing to allow until it is connected.",
} as const;
export type SidekickSourceErrorCode = keyof typeof SIDEKICK_SOURCE_ERRORS;
