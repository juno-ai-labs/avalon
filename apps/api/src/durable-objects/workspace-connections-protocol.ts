import { IdSchema } from "@rally/contracts";
import { z } from "zod/v3";

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
const RegionSchema = z.enum(["global", "eu"]);

/** The providers the attempt table's CHECK constraint admits. */
const OAuthProviderSchema = z.enum(["google", "github", "granola", "linear", "notion", "slack"]);
const OAuthAttemptStatusSchema = z.enum(["pending", "succeeded", "denied", "failed"]);

/** Attempt ids are 32-byte URL-safe random tokens, not UUIDs. */
const OAuthAttemptIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

/**
 * One attempt, whole. Every reader — the polling endpoint, the callback's
 * settlement, the failure-path reconciliation — needs the same row, telemetry
 * labels included, so there is one view rather than a projection per caller.
 */
export const WorkspaceConnectorOAuthAttemptSchema = z.object({
  attemptId: OAuthAttemptIdSchema,
  provider: OAuthProviderSchema,
  status: OAuthAttemptStatusSchema,
  connectionId: IdSchema.nullable(),
  errorCode: z.string().min(1).nullable(),
  expiresAt: TimestampSchema,
  userId: IdSchema,
  workspaceId: IdSchema,
  telemetryOperationId: z.string().min(1).nullable(),
  telemetryEventVersion: z.number().int().safe().min(1),
  telemetryScope: z.enum(["personal", "workspace"]).nullable(),
  telemetryCapabilityCount: z.number().int().safe().nonnegative().nullable(),
  telemetryReconnect: z.boolean(),
  createdAt: TimestampSchema,
}).strict();

export const WorkspaceConnectorOAuthAttemptStartRequestSchema = z.object({
  workspaceId: IdSchema,
  attemptId: OAuthAttemptIdSchema,
  region: RegionSchema,
  provider: OAuthProviderSchema,
  userId: IdSchema,
  expiresAt: TimestampSchema,
  telemetryScope: z.enum(["personal", "workspace"]),
  telemetryCapabilityCount: z.number().int().safe().nonnegative(),
  telemetryReconnect: z.boolean(),
  at: TimestampSchema,
}).strict();

/**
 * Give a start back when its regional `oauth_states` receipt failed to write.
 * Only a still-pending attempt is deleted: expiry remains the recovery fence
 * if this compensation is itself interrupted.
 */
export const WorkspaceConnectorOAuthAttemptAbandonRequestSchema = z.object({
  workspaceId: IdSchema,
  attemptId: OAuthAttemptIdSchema,
}).strict();

/**
 * GitHub's install-then-authorize handoff outlives the first expiry window, so
 * its second leg revives a pending attempt — or one that expiry reconciliation
 * already marked failed, and only that one: any other terminal status is a
 * decision this must not reopen.
 */
export const WorkspaceConnectorOAuthAttemptExtendRequestSchema = z.object({
  workspaceId: IdSchema,
  attemptId: OAuthAttemptIdSchema,
  region: RegionSchema,
  expiresAt: TimestampSchema,
  at: TimestampSchema,
}).strict();

export const WorkspaceConnectorOAuthAttemptReadRequestSchema = z.object({
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
}).strict();

export const WorkspaceConnectorOAuthAttemptReadResultSchema = z.object({
  attempt: WorkspaceConnectorOAuthAttemptSchema.nullable(),
}).strict();

export const WorkspaceConnectorOAuthAttemptFinishRequestSchema = z.object({
  workspaceId: IdSchema,
  attemptId: OAuthAttemptIdSchema,
  region: RegionSchema,
  status: z.enum(["succeeded", "denied", "failed"]),
  connectionId: IdSchema.nullable(),
  errorCode: z.string().min(1).nullable(),
  at: TimestampSchema,
}).strict();

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
  z.object({
    outcome: z.literal("finished"),
    attempt: WorkspaceConnectorOAuthAttemptSchema,
  }).strict(),
  z.object({
    outcome: z.literal("converged"),
    attempt: WorkspaceConnectorOAuthAttemptSchema,
  }).strict(),
  z.object({ outcome: z.literal("conflict") }).strict(),
]);

/**
 * Attach the client's telemetry operation to an attempt, first writer wins.
 * `telemetry_operation_id` carries a partial unique index, so binding one
 * operation to a second attempt still refuses at the constraint.
 */
export const WorkspaceConnectorOAuthAttemptTelemetryBindRequestSchema = z.object({
  workspaceId: IdSchema,
  attemptId: OAuthAttemptIdSchema,
  region: RegionSchema,
  operationId: z.string().min(1),
  eventVersion: z.union([z.literal(1), z.literal(2)]),
  at: TimestampSchema,
}).strict();

/**
 * Claim one webhook delivery for processing.
 *
 * `signatureHash` is the provider's delivery identity — a `webhook-id` or
 * receipt key — not a signature and never the signing secret; verification
 * happened in the Worker before this claim is asked for.
 */
export const WorkspaceWebhookReceiptClaimRequestSchema = z.object({
  workspaceId: IdSchema,
  receiptId: IdSchema,
  connectionId: IdSchema,
  signatureHash: z.string().min(1),
  receivedAt: TimestampSchema,
  expiresAt: TimestampSchema,
}).strict();

export const WorkspaceWebhookReceiptClaimResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("claimed"),
    receiptId: IdSchema,
  }).strict(),
  z.object({ outcome: z.literal("duplicate") }).strict(),
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
