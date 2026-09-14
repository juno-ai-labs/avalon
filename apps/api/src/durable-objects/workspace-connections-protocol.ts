import { RegionSchema } from "@rally/contracts/regions";
import { ConnectorOAuthProviders, IdSchema } from "@rally/contracts";
import { z } from "zod";

/**
 * The connector OAuth attempt lifecycle and webhook receipt claims, as
 * questions rather than SQL.
 *
 * Both tables are WorkspaceDO-owned, and the connection service used to reach
 * them as statements through the workspace runtime facade — which routes by
 * table name, decides mutation outcomes from workerd's physical `rowsWritten`
 * counter, and splits what is logically one decision into a statement per
 * round trip. An attempt's expiry sweep and the read that reports it were two
 * trips; a receipt claim's outcome was a counter comparison the Durable Object
 * SQLite guide forbids deciding transitions with.
 *
 * Nothing in this protocol carries a credential. Attempts hold only handoff
 * state — provider, status, expiry, telemetry labels — and a receipt's
 * `signatureHash` is the provider's delivery identity (`webhook-id`, receipt
 * key), never the signing secret the delivery was verified with. Keeping the
 * schemas that way is deliberate: the credential envelope (ciphertext, IV, key
 * version, connection-bound AAD) lives on `connector_connections`, which this
 * protocol does not touch.
 */

const TimestampSchema = z.string().datetime({ offset: true });


/**
 * The providers the attempt table's CHECK constraint admits.
 *
 * Read from the contract rather than restated: the two lists have to move
 * together, and the object's CHECK is widened by a migration in the same change
 * that adds a value here.
 */
const OAuthProviderSchema = z.enum(ConnectorOAuthProviders);
const OAuthAttemptStatusSchema = z.enum(["pending", "succeeded", "denied", "failed"]);

/** Attempt ids are 32-byte URL-safe random tokens, not UUIDs. */
const OAuthAttemptIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

/**
 * One attempt, whole. Every reader — the polling endpoint, the callback's
 * settlement, the failure-path reconciliation — needs the same row, telemetry
 * labels included, so there is one view rather than a projection per caller.
 */
export const WorkspaceConnectorOAuthAttemptSchema = z.strictObject({
  attemptId: OAuthAttemptIdSchema,
  provider: OAuthProviderSchema,
  status: OAuthAttemptStatusSchema,
  connectionId: IdSchema.nullable(),
  errorCode: z.string().min(1).nullable(),
  expiresAt: TimestampSchema,
  userId: IdSchema,
  workspaceId: IdSchema,
  telemetryOperationId: z.string().min(1).nullable(),
  telemetryEventVersion: z.number().int().min(1),
  telemetryScope: z.enum(["personal", "workspace"]).nullable(),
  telemetryCapabilityCount: z.number().int().nonnegative().nullable(),
  telemetryReconnect: z.boolean(),
  createdAt: TimestampSchema,
});

export const WorkspaceConnectorOAuthAttemptStartRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  attemptId: OAuthAttemptIdSchema,
  region: RegionSchema,
  provider: OAuthProviderSchema,
  userId: IdSchema,
  expiresAt: TimestampSchema,
  telemetryScope: z.enum(["personal", "workspace"]),
  telemetryCapabilityCount: z.number().int().nonnegative(),
  telemetryReconnect: z.boolean(),
  at: TimestampSchema,
});

/**
 * Give a start back when its regional `oauth_states` receipt failed to write.
 * Only a still-pending attempt is deleted: expiry remains the recovery fence
 * if this compensation is itself interrupted.
 */
export const WorkspaceConnectorOAuthAttemptAbandonRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  attemptId: OAuthAttemptIdSchema,
});

/**
 * GitHub's install-then-authorize handoff outlives the first expiry window, so
 * its second leg revives a pending attempt — or one that expiry reconciliation
 * already marked failed, and only that one: any other terminal status is a
 * decision this must not reopen.
 */
export const WorkspaceConnectorOAuthAttemptExtendRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  attemptId: OAuthAttemptIdSchema,
  region: RegionSchema,
  expiresAt: TimestampSchema,
  at: TimestampSchema,
});

export const WorkspaceConnectorOAuthAttemptReadRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  attemptId: OAuthAttemptIdSchema,
  region: RegionSchema,
  /**
   * When set, only this member's attempt answers — the polling endpoint's
   * scoping, which must not tell one member about another's attempt.
   */
  userId: IdSchema.nullable(),
  /**
   * When set, a pending attempt whose expiry has passed is settled as
   * `failed`/`oauth_attempt_expired` first, in the same transaction as the
   * read — the poll endpoint's lazy expiry, which used to be a separate
   * statement ahead of the read.
   */
  expireDueAt: TimestampSchema.nullable(),
});

export const WorkspaceConnectorOAuthAttemptReadResultSchema = z.strictObject({
  attempt: WorkspaceConnectorOAuthAttemptSchema.nullable(),
});

export const WorkspaceConnectorOAuthAttemptFinishRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  attemptId: OAuthAttemptIdSchema,
  region: RegionSchema,
  status: z.enum(["succeeded", "denied", "failed"]),
  connectionId: IdSchema.nullable(),
  errorCode: z.string().min(1).nullable(),
  at: TimestampSchema,
});

/**
 * How the finish ended. `finished` took the transition; `converged` found the
 * attempt already in exactly the requested terminal state (a replayed callback
 * step), which callers treat as success; `conflict` found a different terminal
 * state, which the service reports as its 409 — an outcome rather than a
 * throw, because a thrown RPC error reaches the caller as a bare message with
 * the HTTP status lost.
 *
 * The settled row rides along on both success branches so the caller can emit
 * telemetry and publish sync without a second read racing a later transition.
 */
export const WorkspaceConnectorOAuthAttemptFinishResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("finished"),
    attempt: WorkspaceConnectorOAuthAttemptSchema,
  }),
  z.strictObject({
    outcome: z.literal("converged"),
    attempt: WorkspaceConnectorOAuthAttemptSchema,
  }),
  z.strictObject({ outcome: z.literal("conflict") }),
]);

/**
 * Attach the client's telemetry operation to an attempt, first writer wins.
 * `telemetry_operation_id` carries a partial unique index, so binding one
 * operation to a second attempt still refuses at the constraint.
 */
export const WorkspaceConnectorOAuthAttemptTelemetryBindRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  attemptId: OAuthAttemptIdSchema,
  region: RegionSchema,
  operationId: z.string().min(1),
  eventVersion: z.union([z.literal(1), z.literal(2)]),
  at: TimestampSchema,
});

/**
 * Claim one webhook delivery for processing.
 *
 * `signatureHash` is the provider's delivery identity — a `webhook-id` or
 * receipt key — not a signature and never the signing secret; verification
 * happened in the Worker before this claim is asked for.
 */
export const WorkspaceWebhookReceiptClaimRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  receiptId: IdSchema,
  connectionId: IdSchema,
  signatureHash: z.string().min(1),
  eventIdentity: z.strictObject({ providerEventId: z.string().min(1), eventType: z.string().min(1) }).optional(),
  receivedAt: TimestampSchema,
  expiresAt: TimestampSchema,
});

export const WorkspaceWebhookReceiptClaimResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("claimed"),
    firstObservedAt: TimestampSchema.optional(),
    receiptId: IdSchema,
  }),
  z.strictObject({ outcome: z.literal("duplicate"), firstObservedAt: TimestampSchema.optional() }),
]);

export type WorkspaceConnectorOAuthAttempt = z.infer<typeof WorkspaceConnectorOAuthAttemptSchema>;
export type WorkspaceConnectorOAuthAttemptStartRequest = z.infer<
  typeof WorkspaceConnectorOAuthAttemptStartRequestSchema
>;
export type WorkspaceConnectorOAuthAttemptAbandonRequest = z.infer<
  typeof WorkspaceConnectorOAuthAttemptAbandonRequestSchema
>;
export type WorkspaceConnectorOAuthAttemptExtendRequest = z.infer<
  typeof WorkspaceConnectorOAuthAttemptExtendRequestSchema
>;
export type WorkspaceConnectorOAuthAttemptReadRequest = z.infer<
  typeof WorkspaceConnectorOAuthAttemptReadRequestSchema
>;
export type WorkspaceConnectorOAuthAttemptReadResult = z.infer<
  typeof WorkspaceConnectorOAuthAttemptReadResultSchema
>;
export type WorkspaceConnectorOAuthAttemptFinishRequest = z.infer<
  typeof WorkspaceConnectorOAuthAttemptFinishRequestSchema
>;
export type WorkspaceConnectorOAuthAttemptFinishResult = z.infer<
  typeof WorkspaceConnectorOAuthAttemptFinishResultSchema
>;
export type WorkspaceConnectorOAuthAttemptTelemetryBindRequest = z.infer<
  typeof WorkspaceConnectorOAuthAttemptTelemetryBindRequestSchema
>;
export type WorkspaceWebhookReceiptClaimRequest = z.infer<
  typeof WorkspaceWebhookReceiptClaimRequestSchema
>;
export type WorkspaceWebhookReceiptClaimResult = z.infer<
  typeof WorkspaceWebhookReceiptClaimResultSchema
>;
