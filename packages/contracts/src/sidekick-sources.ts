import { z } from "zod";
import { IdSchema, UserIdSchema } from "./identifiers";
import { PersonalPresentationSchema } from "./onboarding";
import { ConnectorConnectionCardIds } from "./connector-connection-card";

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

/**
 * Internal record: one person, one connection, one event type. Each event
 * type carries its own condition and its own provenance, so answering a
 * request about one kind of event changes nothing the person let in before.
 * `requestId` is set when the person approved a request for this event type:
 * the only way a source answers "may events from your account start this
 * Sidekick", where a source a saved rule made stands for that rule alone.
 * Membership incarnation and provenance never reach a tool or a client.
 */
export const SidekickSourceSchema = z.strictObject({
  sidekickId: IdSchema,
  userId: UserIdSchema,
  connectionId: IdSchema,
  connectorType: ConnectorTypeNameSchema,
  eventType: z.string().min(1),
  condition: SourceConditionSchema,
  membershipIncarnation: z.string().min(1),
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

/**
 * Whether the person asked has an account that carries the asked events: one
 * that works, one whose sign-in lapsed (a changed password), or none yet.
 * Connecting is part of answering, so a request is made either way and its
 * card offers the connection before Approve.
 */
export const SidekickSourceConnectionStateSchema = z.enum(["connected", "reconnect_required", "not_connected"]);
export type SidekickSourceConnectionState = z.infer<typeof SidekickSourceConnectionStateSchema>;

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
  /**
   * The person asked's account for these events, read when the view is.
   * Absent only in a view an older server wrote into a transcript.
   */
  connection: SidekickSourceConnectionStateSchema.optional(),
  /**
   * The connection that carries these events, and so the one to make: the
   * person's own, or the Organization's, for a connector whose events arrive
   * only on its Organization connection (Granola, Fireflies, Ashby), which an
   * administrator makes in Settings. `card` is the connection card that makes
   * a personal one here, or null when none does. Absent from older views.
   */
  connect: z.object({
    scope: z.enum(["personal", "workspace"]),
    card: z.enum(ConnectorConnectionCardIds).nullable(),
  }).optional(),
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

/** `POST /automations/source-requests/read`: requests by id, each only if the reader may see it. */
export const SidekickSourceRequestsReadInputSchema = z.strictObject({ requestIds: z.array(IdSchema).min(1) });
export const SidekickSourceRequestsReadResultSchema = z.object({ requests: z.array(SidekickSourceRequestViewSchema) });
export type SidekickSourceRequestsReadResult = z.infer<typeof SidekickSourceRequestsReadResultSchema>;

export const SidekickSourceWithdrawResultSchema = z.object({ withdrawn: z.boolean() });

/** `POST /automations/:id/sources/withdraw`: a person takes their own source back. */
export const SidekickSourceWithdrawInputSchema = z.strictObject({ connectionId: IdSchema });

export const SIDEKICK_SOURCE_ERRORS = {
  sidekick_source_request_not_found: "This request does not exist.",
  sidekick_source_request_not_yours: "Only the person asked can answer this request.",
  sidekick_source_request_settled: "This request was already answered.",
  sidekick_source_request_requires_manager: "Only the people who manage this Sidekick can ask for a source.",
  sidekick_source_person_unavailable: "That person is not an active member of this Organization.",
  sidekick_source_membership_unavailable: "Your Organization membership is unavailable, so this cannot be approved.",
  sidekick_source_owner_must_approve:
    "A rule on another person's own account needs that person's approval for that event. Ask them with a source request, and save again once they approve.",
  sidekick_source_connection_missing: "Connect that account first. There is nothing to allow until it is connected.",
  sidekick_source_connection_reconnect: "Reconnect that account first. Its sign-in has lapsed, so nothing could arrive from it.",
} as const;
export type SidekickSourceErrorCode = keyof typeof SIDEKICK_SOURCE_ERRORS;
