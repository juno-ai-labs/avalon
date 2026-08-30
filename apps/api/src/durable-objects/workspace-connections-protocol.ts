import { IdSchema } from "@rally/contracts";
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
  telemetryEventVersion: z.number().int().min(1),
  telemetryScope: z.enum(["personal", "workspace"]).nullable(),
  telemetryCapabilityCount: z.number().int().nonnegative().nullable(),
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
  telemetryCapabilityCount: z.number().int().nonnegative(),
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

/**
 * The connection row itself, as questions rather than statements.
 *
 * `connector_connections` is the table the rest of this protocol references but
 * did not own: attempts bind to it, receipts cascade from it, and every other
 * domain reads it. Its statements reached the object through the same facade,
 * with the same three costs — routing by table name, mutation outcomes decided
 * from workerd's physical `rowsWritten`, and one logical decision split across
 * a round trip per statement.
 *
 * Unlike the attempt and receipt schemas above, these requests *do* carry the
 * credential envelope: ciphertext, IV, and key version are columns on this
 * table, and a create or a refresh has to write them. What travels is the
 * envelope, never a plaintext secret and never the key that opens it — the
 * service encrypts before it calls, exactly as it did before it stopped
 * writing SQL. Additional authenticated data stays bound to the connection id,
 * so an envelope moved between connections still fails to open.
 */
const ConnectorTypeSchema = z.enum([
  "google", "generic_webhook", "github", "granola", "linear", "notion", "slack", "x",
]);
const ConnectionScopeSchema = z.enum(["personal", "workspace"]);
const ConnectionStatusSchema = z.enum(["healthy", "needs_reconnect", "error", "disabled"]);

/**
 * One connection, whole.
 *
 * The replaced statements were mostly `SELECT *`, and their readers pick
 * different columns out of the same row — the ingress route builder wants
 * `config_json` and `provider_account_id`, the credential paths want the
 * envelope, the list endpoint wants the display fields. One view rather than a
 * projection per caller keeps those readers from drifting apart, and the
 * object is the only writer, so there is no second definition to disagree with.
 */
export const WorkspaceConnectionSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().min(1),
  connector_type: ConnectorTypeSchema,
  scope: ConnectionScopeSchema,
  owner_user_id: z.string().nullable(),
  provider_account_id: z.string().nullable(),
  display_name: z.string(),
  encrypted_credentials: z.string().nullable(),
  credential_iv: z.string().nullable(),
  credential_key_version: z.number().int().nullable(),
  credential_refresh_lease_id: z.string().nullable(),
  credential_refresh_lease_expires_at: z.string().nullable(),
  granted_scopes_json: z.string(),
  status: ConnectionStatusSchema,
  cursor_json: z.string(),
  config_json: z.string(),
  last_sync_at: z.string().nullable(),
  next_poll_at: z.string().nullable(),
  error_json: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  model_plugin_id: z.string(),
}).strict();

export const WorkspaceConnectionResultSchema = z.object({
  connection: WorkspaceConnectionSchema.nullable(),
}).strict();

export const WorkspaceConnectionListResultSchema = z.object({
  connections: z.array(WorkspaceConnectionSchema),
}).strict();

/**
 * Read one connection by id, with the qualifications its caller would have
 * written into a `WHERE` clause.
 *
 * Every qualification here appeared in at least one replaced statement, and
 * each one is load-bearing rather than defensive: `connectorType` is how a
 * provider's completion refuses to adopt another provider's row, `activeOnly`
 * is how the webhook paths refuse a disabled connection, and `visibleToUserId`
 * is the personal-connection visibility rule — a member may reach a workspace
 * connection or their own, and nobody else's.
 */
export const WorkspaceConnectionReadRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  connectorType: ConnectorTypeSchema.optional(),
  scope: ConnectionScopeSchema.optional(),
  activeOnly: z.boolean().optional(),
  healthyOnly: z.boolean().optional(),
  visibleToUserId: z.string().min(1).optional(),
}).strict();

/**
 * Read one connection by id *without* naming its workspace.
 *
 * The ingress edges — a generic webhook delivery, a Granola delivery, the
 * route sync — are reached by connection id alone, before anything has
 * established which workspace the delivery belongs to; the row is what tells
 * them. The object still fences the answer, because the caller had to address
 * this object to ask, and the object only holds one workspace's rows.
 */
export const WorkspaceConnectionByIdRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  connectorType: ConnectorTypeSchema.optional(),
  scope: ConnectionScopeSchema.optional(),
  activeOnly: z.boolean().optional(),
}).strict();

/** Every connection a member may see: workspace-scoped, plus their own. */
export const WorkspaceConnectionListRequestSchema = z.object({
  workspaceId: IdSchema,
  userId: z.string().min(1),
}).strict();

/**
 * Find an existing connection to adopt rather than duplicate.
 *
 * The replaced statements were six near-identical searches — Linear's and
 * Slack's re-authorization lookups, GitHub's duplicate-installation check, X's
 * and Granola's singleton guards, and the generic webhook's creation
 * idempotency key. They differ only in which of these predicates they set, so
 * they are one question with optional terms rather than six methods that would
 * drift.
 */
export const WorkspaceConnectionFindRequestSchema = z.object({
  workspaceId: IdSchema,
  connectorType: ConnectorTypeSchema,
  scope: ConnectionScopeSchema.optional(),
  providerAccountId: z.string().nullable().optional(),
  ownerUserId: z.string().nullable().optional(),
  excludeConnectionId: z.string().min(1).optional(),
  creationIdempotencyKey: z.string().min(1).optional(),
}).strict();

/**
 * Two of those searches — Slack's and Linear's re-authorization lookups — had
 * no `workspace_id` predicate on their workspace-scoped branch. That is
 * vestigial from when this table was regional and one query really could see
 * every workspace's rows; since the cutover the facade routes the statement
 * into one workspace's object, which holds no other workspace's connections,
 * so the fence was already being applied by addressing rather than by SQL.
 * `workspaceId` is required here, which makes the fence the statement was
 * relying on something a reader can see.
 */

/**
 * The credential envelope, as one value rather than three loose columns.
 *
 * Ciphertext, IV, and key version are only ever written together and are only
 * meaningful together — a row carrying one without the others cannot be
 * opened. Grouping them means no write can set two of the three, which the
 * replaced statements had to be trusted not to do.
 */
export const WorkspaceConnectionCredentialEnvelopeSchema = z.object({
  ciphertext: z.string().min(1),
  iv: z.string().min(1),
  keyVersion: z.number().int().positive(),
}).strict();

/**
 * Bind a settled OAuth attempt to the connection the same write created or
 * refreshed.
 *
 * `persistConnectionMutation` batched these two statements so a member's
 * handoff could never stay pending after its connection committed. A D1 batch
 * reached the object as one `executeRuntimeSql` call, which is what made it
 * atomic; a typed method per statement would have quietly given that up. So
 * the bind travels *with* the write instead, and the object performs both in
 * one `transactionSync`.
 */
export const WorkspaceConnectionAttemptBindSchema = z.object({
  attemptId: z.string().min(1),
  region: RegionSchema,
}).strict();

/** Create a connection, and settle the attempt that authorized it. */
export const WorkspaceConnectionCreateRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  connectorType: ConnectorTypeSchema,
  scope: ConnectionScopeSchema,
  ownerUserId: z.string().nullable(),
  providerAccountId: z.string().nullable(),
  displayName: z.string().min(1),
  credentials: WorkspaceConnectionCredentialEnvelopeSchema.nullable(),
  grantedScopesJson: z.string(),
  modelPluginId: z.string().min(1),
  configJson: z.string(),
  nextPollAt: z.string().nullable(),
  at: TimestampSchema,
  bindAttempt: WorkspaceConnectionAttemptBindSchema.optional(),
}).strict();

/**
 * Re-authorize an existing connection: new envelope, new grants, healthy again.
 *
 * `outcome` rather than a row count. The Google path decided its user-visible
 * `connection_not_found` 404 from the facade's `meta.changes`, which is
 * workerd's physical `rowsWritten` — the counter
 * [`docs/durable-object-sqlite.md`](../../../../docs/durable-object-sqlite.md)
 * forbids deciding a logical outcome from. It answers from a `RETURNING`
 * witness now, so `missing` means no row matched rather than no page was
 * written.
 */
export const WorkspaceConnectionRefreshRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  connectorType: ConnectorTypeSchema,
  providerAccountId: z.string().nullable(),
  displayName: z.string().min(1),
  credentials: WorkspaceConnectionCredentialEnvelopeSchema,
  grantedScopesJson: z.string(),
  modelPluginId: z.string().min(1),
  configJson: z.string(),
  nextPollAt: z.string().nullable().optional(),
  at: TimestampSchema,
  bindAttempt: WorkspaceConnectionAttemptBindSchema.optional(),
}).strict();

export const WorkspaceConnectionWriteResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("written"), connection: WorkspaceConnectionSchema }).strict(),
  z.object({ outcome: z.literal("missing") }).strict(),
]);

/** Move a connection's health, optionally only from a status it still holds. */
export const WorkspaceConnectionStatusRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  status: ConnectionStatusSchema,
  errorJson: z.string().nullable(),
  connectorType: ConnectorTypeSchema.optional(),
  /** Only move a connection still in this status — the reconnect marker's fence. */
  fromStatus: ConnectionStatusSchema.optional(),
  at: TimestampSchema,
}).strict();

/**
 * Disable a connection and drop the envelope with it.
 *
 * Clearing the credential columns is the point, not bookkeeping: a disabled
 * connection must stop being openable, and leaving ciphertext behind would
 * keep a revoked grant recoverable from the row.
 */
export const WorkspaceConnectionDisableRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  at: TimestampSchema,
}).strict();

/** Replace the envelope on a connection that is still usable. */
export const WorkspaceConnectionCredentialWriteRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  credentials: WorkspaceConnectionCredentialEnvelopeSchema,
  activeOnly: z.boolean().optional(),
  at: TimestampSchema,
}).strict();

/**
 * Re-encrypt an envelope, conditional on the exact envelope being replaced.
 *
 * The key-rotation sweep reads a connection, re-encrypts it under the new key,
 * and writes it back; between those steps an OAuth completion may have
 * replaced the envelope entirely. The compare is over all three columns
 * because that triple *is* the envelope — matching on ciphertext alone would
 * let a rotation land on a row whose IV had moved.
 */
export const WorkspaceConnectionEnvelopeRotateRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  expected: WorkspaceConnectionCredentialEnvelopeSchema,
  next: WorkspaceConnectionCredentialEnvelopeSchema,
  at: TimestampSchema,
}).strict();

export const WorkspaceConnectionSettleResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("settled") }).strict(),
  z.object({ outcome: z.literal("raced") }).strict(),
]);

/**
 * The credential-refresh lease: claim, settle, release.
 *
 * Already a lease before this conversion, and already correct — the claim
 * fenced on an expired or absent holder and returned the envelope it won, and
 * the settle fenced on still holding it. What moves is where the lease id and
 * its expiry are minted. The object owns lifecycle time and randomness per
 * [`docs/durable-object-sqlite.md`](../../../../docs/durable-object-sqlite.md),
 * so a caller carries the lease it was handed rather than one it invented.
 */
export const WorkspaceConnectionLeaseClaimRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  leaseMs: z.number().int().positive(),
  at: TimestampSchema,
}).strict();

export const WorkspaceConnectionLeaseClaimResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("claimed"),
    leaseId: z.string().min(1),
    credentials: WorkspaceConnectionCredentialEnvelopeSchema.nullable(),
  }).strict(),
  z.object({ outcome: z.literal("held") }).strict(),
]);

export const WorkspaceConnectionLeaseSettleRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  leaseId: z.string().min(1),
  credentials: WorkspaceConnectionCredentialEnvelopeSchema,
  at: TimestampSchema,
}).strict();

export const WorkspaceConnectionLeaseReleaseRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  leaseId: z.string().min(1),
}).strict();

/**
 * Advance GitHub's repository-access selection, conditional on its revision.
 *
 * Already a compare-and-set on `$.githubRepositoryAccess.revision` with a
 * `RETURNING` witness — one of the few replaced statements that was reading
 * its own outcome honestly. It is typed here for the same reason as its
 * neighbours rather than because it was wrong.
 */
export const WorkspaceConnectionRepositoryAccessRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  accessJson: z.string(),
  at: TimestampSchema,
}).strict();

/** Granola's identity refresh: the account it reports, and its display name. */
export const WorkspaceConnectionIdentityRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  connectorType: ConnectorTypeSchema,
  scope: ConnectionScopeSchema,
  providerAccountId: z.string().nullable(),
  displayName: z.string().min(1),
  configJson: z.string(),
  at: TimestampSchema,
}).strict();

/**
 * Every model plugin id this workspace has spoken for.
 *
 * `allocateModelPluginId` read the taken ids and then the current row's own id
 * as two statements, then picked a free name. Both reads answer from one
 * critical section here; the allocation itself stays in the service, because
 * which name a connector prefers is product vocabulary rather than storage.
 */
export const WorkspaceConnectionPluginIdsRequestSchema = z.object({
  workspaceId: IdSchema,
  excludeConnectionId: z.string().min(1).nullable(),
}).strict();

export const WorkspaceConnectionPluginIdsResultSchema = z.object({
  taken: z.array(z.string()),
  current: z.string().nullable(),
}).strict();

export type WorkspaceConnection = z.infer<typeof WorkspaceConnectionSchema>;
export type WorkspaceConnectionResult = z.infer<typeof WorkspaceConnectionResultSchema>;
export type WorkspaceConnectionListResult = z.infer<typeof WorkspaceConnectionListResultSchema>;
export type WorkspaceConnectionReadRequest = z.infer<typeof WorkspaceConnectionReadRequestSchema>;
export type WorkspaceConnectionByIdRequest = z.infer<typeof WorkspaceConnectionByIdRequestSchema>;
export type WorkspaceConnectionListRequest = z.infer<typeof WorkspaceConnectionListRequestSchema>;
export type WorkspaceConnectionFindRequest = z.infer<typeof WorkspaceConnectionFindRequestSchema>;
export type WorkspaceConnectionCreateRequest = z.infer<typeof WorkspaceConnectionCreateRequestSchema>;
export type WorkspaceConnectionRefreshRequest = z.infer<typeof WorkspaceConnectionRefreshRequestSchema>;
export type WorkspaceConnectionWriteResult = z.infer<typeof WorkspaceConnectionWriteResultSchema>;
export type WorkspaceConnectionStatusRequest = z.infer<typeof WorkspaceConnectionStatusRequestSchema>;
export type WorkspaceConnectionDisableRequest = z.infer<typeof WorkspaceConnectionDisableRequestSchema>;
export type WorkspaceConnectionCredentialWriteRequest = z.infer<
  typeof WorkspaceConnectionCredentialWriteRequestSchema
>;
export type WorkspaceConnectionEnvelopeRotateRequest = z.infer<
  typeof WorkspaceConnectionEnvelopeRotateRequestSchema
>;
export type WorkspaceConnectionSettleResult = z.infer<typeof WorkspaceConnectionSettleResultSchema>;
export type WorkspaceConnectionLeaseClaimRequest = z.infer<
  typeof WorkspaceConnectionLeaseClaimRequestSchema
>;
export type WorkspaceConnectionLeaseClaimResult = z.infer<
  typeof WorkspaceConnectionLeaseClaimResultSchema
>;
export type WorkspaceConnectionLeaseSettleRequest = z.infer<
  typeof WorkspaceConnectionLeaseSettleRequestSchema
>;
export type WorkspaceConnectionLeaseReleaseRequest = z.infer<
  typeof WorkspaceConnectionLeaseReleaseRequestSchema
>;
export type WorkspaceConnectionRepositoryAccessRequest = z.infer<
  typeof WorkspaceConnectionRepositoryAccessRequestSchema
>;
export type WorkspaceConnectionIdentityRequest = z.infer<
  typeof WorkspaceConnectionIdentityRequestSchema
>;
export type WorkspaceConnectionPluginIdsRequest = z.infer<
  typeof WorkspaceConnectionPluginIdsRequestSchema
>;
export type WorkspaceConnectionPluginIdsResult = z.infer<
  typeof WorkspaceConnectionPluginIdsResultSchema
>;
