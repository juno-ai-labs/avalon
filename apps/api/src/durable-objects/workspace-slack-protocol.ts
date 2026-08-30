import { IdSchema } from "@rally/contracts";
import { z } from "zod";

/**
 * The Slack ingress spine — jobs, thread claims, and pending prompts — as
 * questions rather than SQL.
 *
 * `slack_ingress_jobs`, `slack_agent_thread_claims`,
 * `slack_agent_pending_prompts`, and `slack_link_challenges` are WorkspaceDO
 * tables that `SlackAgentService` reached as individual statements through the
 * workspace runtime facade. That facade routes by the table names it finds in
 * the SQL, and this domain has already produced one wrong answer that way:
 * `slackUserIsLinked` joined `slack_user_links` to `workspace_members`, was
 * claimed by the router because it named a local table, and executed inside an
 * object with no `workspace_members` — failing every Slack run-outcome
 * delivery in production. A typed method cannot be routed to the wrong
 * database, because its SQL lives inside the object that owns the tables.
 *
 * A refusal travels as an outcome, never a throw: a thrown RPC error reaches
 * the caller as a bare message with the HTTP status lost, so the object names
 * what happened and the service maps it to its own `ApiError` or silence.
 * Where an outcome carries data only on one branch, the union gives each
 * outcome its own member so a caller narrows instead of asserting past nulls.
 *
 * Identifiers minted by Slack — team, channel, thread, user, and the
 * `kind:hash` job ids derived from its payloads — are validated only as
 * non-empty strings. They are provider vocabulary, not Rally ids, and the
 * object's schema stores them as opaque TEXT.
 */

const TimestampSchema = z.string().datetime({ offset: true });
const SlackIngressJobKindSchema = z.enum(["event", "interaction", "command"]);
const SlackIngressJobStatusSchema = z.enum(["queued", "processing", "completed", "failed"]);

export const WorkspaceSlackIngressEnqueueRequestSchema = z.object({
  workspaceId: IdSchema,
  jobId: z.string().min(1),
  connectionId: z.string().min(1),
  teamId: z.string().min(1),
  bodyHash: z.string().min(1),
  kind: SlackIngressJobKindSchema,
  /** Serialized by the caller; the object stores it verbatim. */
  payloadJson: z.string().min(1),
  at: TimestampSchema,
}).strict();

/**
 * What the insert found: a fresh row, a replay, or Slack reusing an identity.
 *
 * The facade version decided "duplicate" from the adapter's `meta.changes`,
 * which `docs/durable-object-sqlite.md` forbids for a logical outcome — the
 * counter reports physical writes, index maintenance included. Here the insert
 * returns its witness and the duplicate branch reads the prior row in the same
 * transaction, so the answer is the row's, not the counter's.
 */
/**
 * The retry ceiling one ingress job gets before only a reauthorization
 * re-drive can bring it back.
 *
 * Unchanged from the `20` the service spelled at every site it replaced. It
 * lives in the protocol rather than beside the claim that enforces it because
 * two sites outside the object have to agree with it exactly and cannot import
 * from storage without dragging `DurableObjectStorage` into a service: the
 * reauthorization re-drive in `services/slack-agent-service.ts`, still a facade
 * statement because it joins `connector_connections`, and the workspace alarm's
 * due-time arm in `services/workspace-schedule-execution.ts`, which must count
 * exactly the rows the claim and the recovery scan will and will not act on. A
 * comment saying "these three must move together" is only as good as the next
 * person reading all three files; one exported constant is checked by `tsc`.
 */
export const SLACK_INGRESS_ATTEMPT_LIMIT = 20;

export const WorkspaceSlackIngressEnqueueResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("queued") }).strict(),
  /** The same id with the same body: an idempotent retry, safe to re-announce. */
  z.object({ outcome: z.literal("replayed"), status: SlackIngressJobStatusSchema }).strict(),
  /** The same id with different content — Slack reused an event identity. */
  z.object({ outcome: z.literal("conflict") }).strict(),
]);

export const WorkspaceSlackIngressClaimRequestSchema = z.object({
  workspaceId: IdSchema,
  jobId: z.string().min(1),
  at: TimestampSchema,
}).strict();

/**
 * The claimed job travels with the lease that fenced it.
 *
 * The object mints the lease and its expiry, per
 * `docs/durable-object-sqlite.md`: a claim RPC generates its lease inside the
 * authority and returns it, so caller-supplied lease formats never become part
 * of the invariant. `payloadJson` stays nullable because the claim does not
 * check it — a completed job's payload is cleared, and a claim that raced one
 * reports what it found rather than inventing a payload.
 */
export const WorkspaceSlackIngressClaimResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("claimed"),
    leaseId: z.string().min(1),
    job: z.object({
      jobId: z.string().min(1),
      connectionId: z.string().min(1),
      teamId: z.string().min(1),
      bodyHash: z.string().min(1),
      kind: SlackIngressJobKindSchema,
      payloadJson: z.string().nullable(),
    }).strict(),
  }).strict(),
  /** Terminal, at the attempt ceiling, or another worker's live lease. */
  z.object({ outcome: z.literal("unavailable") }).strict(),
]);

export const WorkspaceSlackIngressCompleteRequestSchema = z.object({
  workspaceId: IdSchema,
  jobId: z.string().min(1),
  leaseId: z.string().min(1),
  at: TimestampSchema,
}).strict();

export const WorkspaceSlackIngressSettleResultSchema = z.object({
  outcome: z.enum(["settled", "stale"]),
}).strict();

export const WorkspaceSlackIngressFailRequestSchema = z.object({
  workspaceId: IdSchema,
  jobId: z.string().min(1),
  leaseId: z.string().min(1),
  errorCode: z.string().min(1),
  retryable: z.boolean(),
  /**
   * Jobs on the same connection that exhausted with the same code after this
   * instant count as one episode; the caller derives it from its notice
   * window so the number stays a service decision.
   */
  exhaustionEpisodeStartedAt: TimestampSchema,
  at: TimestampSchema,
}).strict();

/**
 * The failure and the exhaustion-notice decision, taken together.
 *
 * The facade version wrote the failure and then read for a sibling episode as
 * a second statement, so two jobs exhausting at once could both find no
 * sibling and both notify. One transaction answers "is this the episode's
 * first report" from the same state the write produced.
 */
export const WorkspaceSlackIngressFailResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("failed"),
    attemptCount: z.number().int().nonnegative(),
    exhausted: z.boolean(),
    /** True when no other job on this connection exhausted the same way inside the episode. */
    firstExhaustionReport: z.boolean(),
  }).strict(),
  z.object({ outcome: z.literal("stale") }).strict(),
]);

export const WorkspaceSlackIngressRecoverableRequestSchema = z.object({
  workspaceId: IdSchema,
  /** Queued or failed jobs untouched since this instant are worth re-announcing. */
  staleBefore: TimestampSchema,
  at: TimestampSchema,
  limit: z.number().int().positive(),
}).strict();

export const WorkspaceSlackIngressRecoverableResultSchema = z.object({
  jobIds: z.array(z.string().min(1)),
}).strict();

export const WorkspaceSlackIngressSweepRequestSchema = z.object({
  workspaceId: IdSchema,
  at: TimestampSchema,
  /** Completed and permanently failed jobs older than this are removed. */
  retentionCutoff: TimestampSchema,
  /** Link challenges spent or expired before this are removed. */
  spentBefore: TimestampSchema,
  /** How many exhausted jobs the standing report names. */
  exhaustedReportLimit: z.number().int().positive(),
}).strict();

export const WorkspaceSlackIngressSweepResultSchema = z.object({
  /** The standing exhausted set after the sweep, newest first. */
  exhausted: z.array(z.object({
    jobId: z.string().min(1),
    errorCode: z.string().nullable(),
  }).strict()),
}).strict();

export const WorkspaceSlackThreadRoutableRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
  slackUserId: z.string().min(1),
  at: TimestampSchema,
}).strict();

export const WorkspaceSlackThreadRoutableResultSchema = z.object({
  routable: z.boolean(),
}).strict();

export const WorkspaceSlackPendingPromptRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
  slackUserId: z.string().min(1),
  at: TimestampSchema,
}).strict();

export const WorkspaceSlackPendingPromptResultSchema = z.object({
  prompt: z.string().nullable(),
}).strict();

export const WorkspaceSlackPendingPromptStoreRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
  slackUserId: z.string().min(1),
  /** Already trimmed and bounded by the caller to the column's own CHECK. */
  prompt: z.string().min(1).max(40_000),
  denialReason: z.enum(["connection", "channel_resolution", "policy"]),
  /** The retention decision stays the service's; the object stores its answer. */
  expiresAt: TimestampSchema,
  at: TimestampSchema,
}).strict();

export const WorkspaceSlackPendingPromptClearRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
  slackUserId: z.string().min(1),
}).strict();

export const WorkspaceSlackThreadClaimRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
  at: TimestampSchema,
}).strict();

/**
 * Either this caller now initializes the thread, or somebody else already is.
 *
 * The lease is minted inside the object and only returned on the branch that
 * won, so a loser cannot hold a lease id at all — the shape that let a
 * `rowsWritten` comparison masquerade as a claim elsewhere.
 */
export const WorkspaceSlackThreadClaimResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("claimed"), leaseId: z.string().min(1) }).strict(),
  z.object({ outcome: z.literal("held") }).strict(),
]);

export const WorkspaceSlackThreadReleaseRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
  leaseId: z.string().min(1),
}).strict();

/**
 * The agent-session lifecycle: the thread's Rally identity, its delivery
 * bookkeeping, and the status reaction Rally keeps on the triggering message.
 *
 * `slack_agent_contexts` is keyed `(connection_id, slack_user_id)` and carries
 * no `workspace_id` of its own — the workspace is how the caller found the
 * object, not a column. Its requests still take `workspaceId` so the object can
 * assert the caller reached the right one, exactly as every other method here.
 */
const SlackInvocationKindSchema = z.enum(["app_mention", "direct_message", "slash_command", "shortcut"]);
const SlackChannelTypeSchema = z.enum(["public", "private", "im", "unknown"]);
const SlackAssignmentMethodSchema = z.enum(["verified_email", "explicit_link"]);
const SlackFeedbackRatingSchema = z.enum(["helpful", "needs_improvement"]);

/** The session as its readers consume it, in the object's own column names. */
export const WorkspaceSlackSessionSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().min(1),
  connection_id: z.string().min(1),
  slack_team_id: z.string().min(1),
  slack_user_id: z.string().min(1),
  slack_channel_id: z.string().min(1),
  slack_thread_ts: z.string().min(1),
  slack_stream_ts: z.string().nullable(),
  workstream_id: z.string().min(1),
  last_delivery_key: z.string().nullable(),
  opening_client_message_id: z.string(),
  invocation_kind: SlackInvocationKindSchema,
  channel_type: SlackChannelTypeSchema,
  assigned_user_id: z.string().nullable(),
  /** The triggering message Rally's status reaction sits on, not the root. */
  reaction_channel_id: z.string().nullable(),
  reaction_message_ts: z.string().nullable(),
  /** Only what Rally placed itself, so a transition never takes a member's. */
  reaction_current: z.string().nullable(),
  reaction_cursor: z.number().int().nonnegative(),
}).strict();

export const WorkspaceSlackSessionResultSchema = z.object({
  session: WorkspaceSlackSessionSchema.nullable(),
}).strict();

export const WorkspaceSlackSessionByIdRequestSchema = z.object({
  workspaceId: IdSchema,
  sessionId: z.string().min(1),
}).strict();

export const WorkspaceSlackSessionByThreadRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
}).strict();

export const WorkspaceSlackSessionByWorkstreamRequestSchema = z.object({
  workspaceId: IdSchema,
  workstreamId: IdSchema,
}).strict();

export const WorkspaceSlackSessionExistsRequestSchema = z.object({
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  connectionId: z.string().min(1),
}).strict();

export const WorkspaceSlackSessionExistsResultSchema = z.object({
  sessionId: z.string().nullable(),
}).strict();

export const WorkspaceSlackSessionCreateRequestSchema = z.object({
  workspaceId: IdSchema,
  sessionId: z.string().min(1),
  connectionId: z.string().min(1),
  teamId: z.string().min(1),
  slackUserId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
  openingClientMessageId: z.string().min(1).max(120),
  workstreamId: IdSchema,
  invocationKind: SlackInvocationKindSchema,
  channelType: SlackChannelTypeSchema,
  assignedUserId: z.string().nullable(),
  assignedAt: TimestampSchema.nullable(),
  assignmentMethod: SlackAssignmentMethodSchema.nullable(),
  claimedBySlackUserId: z.string().nullable(),
  claimedAt: TimestampSchema.nullable(),
  contextJson: z.string().min(1),
  at: TimestampSchema,
}).strict();

export const WorkspaceSlackSessionAssignRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  teamId: z.string().min(1),
  slackUserId: z.string().min(1),
  assignedUserId: z.string().min(1),
  assignmentMethod: SlackAssignmentMethodSchema,
  at: TimestampSchema,
}).strict();

/**
 * The sessions this assignment moved, with the values it moved them *from*.
 *
 * The service read the matching rows and then updated them as two statements
 * over the same predicate, which is a race: a session seated between the two
 * was reconciled against a snapshot that no longer described it. Both run in
 * one `transactionSync` here, and the previous assignment travels back because
 * `reconcileSlackWorkstreamIdentity` needs it — `RETURNING` yields the new row,
 * so the prior values have to be read inside the same critical section rather
 * than inferred from the write.
 *
 * The count the service used to take from `meta.changes` is this array's
 * length, decided by which rows the update actually returned.
 */
export const WorkspaceSlackSessionAssignResultSchema = z.object({
  sessions: z.array(z.object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    workstreamId: z.string().min(1),
    previousAssignedUserId: z.string().nullable(),
    previousAssignmentMethod: SlackAssignmentMethodSchema.nullable(),
  }).strict()),
}).strict();

export const WorkspaceSlackSessionDeliveryKeyRequestSchema = z.object({
  workspaceId: IdSchema,
  sessionId: z.string().min(1),
  deliveryKey: z.string().min(1),
  at: TimestampSchema,
}).strict();

export const WorkspaceSlackSessionStreamRequestSchema = z.object({
  workspaceId: IdSchema,
  sessionId: z.string().min(1),
  streamTs: z.string().min(1).nullable(),
  at: TimestampSchema,
}).strict();

/**
 * Settle the status reaction, conditional on the emoji this transition removed.
 *
 * The compare-and-set spans a Slack API call — the caller reads what is placed,
 * asks Slack to swap it, then records the result — so it cannot be one
 * transaction. What it can be is honest about whether it won: the write
 * returns the updated row as a witness, and `raced` is the *absence* of that
 * witness rather than a `rowsWritten` of zero. The service decided this from
 * `meta.changes` before, which is the physical counter
 * [`docs/durable-object-sqlite.md`](../../../../docs/durable-object-sqlite.md)
 * forbids deciding a logical outcome from.
 *
 * `expected` is nullable because NULL is a real state: it means Rally has
 * placed nothing, so the predicate is `IS`, not `=`. That predicate is carried
 * forward from the statement this replaced, which already had it right; what
 * moved is only how the outcome is decided.
 */
export const WorkspaceSlackSessionReactionRequestSchema = z.object({
  workspaceId: IdSchema,
  sessionId: z.string().min(1),
  expected: z.string().nullable(),
  reaction: z.string().nullable(),
  cursor: z.number().int().nonnegative().optional(),
  at: TimestampSchema,
}).strict();

export const WorkspaceSlackSessionReactionResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("settled") }).strict(),
  z.object({ outcome: z.literal("raced") }).strict(),
]);

/**
 * Move the status reaction onto the message that made the newest prompt.
 *
 * A follow-up in an existing thread restarts the rotation rather than resuming
 * the previous run's position, so the cursor resets to 0 here. Unconditional,
 * unlike {@link WorkspaceSlackSessionReactionRequestSchema}: this is the run
 * declaring where its status now lives, not a transition racing another.
 */
export const WorkspaceSlackSessionReactionAnchorRequestSchema = z.object({
  workspaceId: IdSchema,
  sessionId: z.string().min(1),
  channelId: z.string().min(1),
  messageTs: z.string().min(1),
  reaction: z.string().nullable(),
  at: TimestampSchema,
}).strict();

export const WorkspaceSlackContextRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  slackUserId: z.string().min(1),
}).strict();

export const WorkspaceSlackContextResultSchema = z.object({
  contextJson: z.string().nullable(),
}).strict();

export const WorkspaceSlackContextStoreRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  slackUserId: z.string().min(1),
  contextJson: z.string().min(1),
  at: TimestampSchema,
}).strict();

/**
 * One feedback row per ingress job.
 *
 * `ingress_job_id` is `UNIQUE`, so a redelivered interaction is a replay rather
 * than an error. The statement this replaced already ignored the conflict and
 * was right to; what it could not do was say which case it had hit, because it
 * discarded the result. The witness makes the replay reportable, which is the
 * only thing a caller can usefully do with it.
 */
export const WorkspaceSlackFeedbackRequestSchema = z.object({
  workspaceId: IdSchema,
  feedbackId: z.string().min(1),
  ingressJobId: z.string().min(1),
  workstreamId: IdSchema,
  userId: IdSchema,
  connectionId: z.string().min(1),
  rating: SlackFeedbackRatingSchema,
  comment: z.string().nullable(),
  at: TimestampSchema,
}).strict();

export const WorkspaceSlackFeedbackResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("recorded") }).strict(),
  z.object({ outcome: z.literal("replayed") }).strict(),
]);

export type WorkspaceSlackIngressEnqueueRequest = z.infer<typeof WorkspaceSlackIngressEnqueueRequestSchema>;
export type WorkspaceSlackIngressEnqueueResult = z.infer<typeof WorkspaceSlackIngressEnqueueResultSchema>;
export type WorkspaceSlackIngressClaimRequest = z.infer<typeof WorkspaceSlackIngressClaimRequestSchema>;
export type WorkspaceSlackIngressClaimResult = z.infer<typeof WorkspaceSlackIngressClaimResultSchema>;
export type WorkspaceSlackIngressCompleteRequest = z.infer<typeof WorkspaceSlackIngressCompleteRequestSchema>;
export type WorkspaceSlackIngressSettleResult = z.infer<typeof WorkspaceSlackIngressSettleResultSchema>;
export type WorkspaceSlackIngressFailRequest = z.infer<typeof WorkspaceSlackIngressFailRequestSchema>;
export type WorkspaceSlackIngressFailResult = z.infer<typeof WorkspaceSlackIngressFailResultSchema>;
export type WorkspaceSlackIngressRecoverableRequest = z.infer<typeof WorkspaceSlackIngressRecoverableRequestSchema>;
export type WorkspaceSlackIngressRecoverableResult = z.infer<typeof WorkspaceSlackIngressRecoverableResultSchema>;
export type WorkspaceSlackIngressSweepRequest = z.infer<typeof WorkspaceSlackIngressSweepRequestSchema>;
export type WorkspaceSlackIngressSweepResult = z.infer<typeof WorkspaceSlackIngressSweepResultSchema>;
export type WorkspaceSlackThreadRoutableRequest = z.infer<typeof WorkspaceSlackThreadRoutableRequestSchema>;
export type WorkspaceSlackThreadRoutableResult = z.infer<typeof WorkspaceSlackThreadRoutableResultSchema>;
export type WorkspaceSlackPendingPromptRequest = z.infer<typeof WorkspaceSlackPendingPromptRequestSchema>;
export type WorkspaceSlackPendingPromptResult = z.infer<typeof WorkspaceSlackPendingPromptResultSchema>;
export type WorkspaceSlackPendingPromptStoreRequest = z.infer<typeof WorkspaceSlackPendingPromptStoreRequestSchema>;
export type WorkspaceSlackPendingPromptClearRequest = z.infer<typeof WorkspaceSlackPendingPromptClearRequestSchema>;
export type WorkspaceSlackThreadClaimRequest = z.infer<typeof WorkspaceSlackThreadClaimRequestSchema>;
export type WorkspaceSlackThreadClaimResult = z.infer<typeof WorkspaceSlackThreadClaimResultSchema>;
export type WorkspaceSlackThreadReleaseRequest = z.infer<typeof WorkspaceSlackThreadReleaseRequestSchema>;
export type WorkspaceSlackSession = z.infer<typeof WorkspaceSlackSessionSchema>;
export type WorkspaceSlackSessionResult = z.infer<typeof WorkspaceSlackSessionResultSchema>;
export type WorkspaceSlackSessionByIdRequest = z.infer<typeof WorkspaceSlackSessionByIdRequestSchema>;
export type WorkspaceSlackSessionByThreadRequest = z.infer<typeof WorkspaceSlackSessionByThreadRequestSchema>;
export type WorkspaceSlackSessionByWorkstreamRequest = z.infer<typeof WorkspaceSlackSessionByWorkstreamRequestSchema>;
export type WorkspaceSlackSessionExistsRequest = z.infer<typeof WorkspaceSlackSessionExistsRequestSchema>;
export type WorkspaceSlackSessionExistsResult = z.infer<typeof WorkspaceSlackSessionExistsResultSchema>;
export type WorkspaceSlackSessionCreateRequest = z.infer<typeof WorkspaceSlackSessionCreateRequestSchema>;
export type WorkspaceSlackSessionAssignRequest = z.infer<typeof WorkspaceSlackSessionAssignRequestSchema>;
export type WorkspaceSlackSessionAssignResult = z.infer<typeof WorkspaceSlackSessionAssignResultSchema>;
export type WorkspaceSlackSessionDeliveryKeyRequest = z.infer<typeof WorkspaceSlackSessionDeliveryKeyRequestSchema>;
export type WorkspaceSlackSessionStreamRequest = z.infer<typeof WorkspaceSlackSessionStreamRequestSchema>;
export type WorkspaceSlackSessionReactionRequest = z.infer<typeof WorkspaceSlackSessionReactionRequestSchema>;
export type WorkspaceSlackSessionReactionResult = z.infer<typeof WorkspaceSlackSessionReactionResultSchema>;
export type WorkspaceSlackContextRequest = z.infer<typeof WorkspaceSlackContextRequestSchema>;
export type WorkspaceSlackContextResult = z.infer<typeof WorkspaceSlackContextResultSchema>;
export type WorkspaceSlackContextStoreRequest = z.infer<typeof WorkspaceSlackContextStoreRequestSchema>;
export type WorkspaceSlackFeedbackRequest = z.infer<typeof WorkspaceSlackFeedbackRequestSchema>;
export type WorkspaceSlackFeedbackResult = z.infer<typeof WorkspaceSlackFeedbackResultSchema>;
export type WorkspaceSlackSessionReactionAnchorRequest = z.infer<typeof WorkspaceSlackSessionReactionAnchorRequestSchema>;
