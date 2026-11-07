import { IdSchema } from "@rally/contracts";
import { z } from "zod";
import { deferredZodSchema } from "@rally/contracts/deferred-zod-schema";

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

/**
 * The synthetic ingress event queued when a Sidekick with a Slack source is
 * saved: join the bot to the conversations the source names. It is an
 * ingress job so the join runs with the installation's token in the Worker.
 */
export const SLACK_SIDEKICK_SOURCE_JOIN_EVENT = "rally_sidekick_source_join";
const SlackIngressJobKindSchema = z.enum(["event", "interaction", "command"]);
const SlackIngressJobStatusSchema = z.enum(["queued", "processing", "completed", "failed"]);

export const WorkspaceSlackIngressEnqueueRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  jobId: z.string().min(1),
  connectionId: z.string().min(1),
  teamId: z.string().min(1),
  bodyHash: z.string().min(1),
  kind: SlackIngressJobKindSchema,
  /** Serialized by the caller; the object stores it verbatim. */
  payloadJson: z.string().min(1),
  at: TimestampSchema,
}));

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

export const WorkspaceSlackIngressEnqueueResultSchema = deferredZodSchema(() => z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("queued") }),
  /** The same id with the same body: an idempotent retry, safe to re-announce. */
  z.strictObject({ outcome: z.literal("replayed"), status: SlackIngressJobStatusSchema }),
  /** The same id with different content — Slack reused an event identity. */
  z.strictObject({ outcome: z.literal("conflict") }),
]));

export const WorkspaceSlackIngressClaimRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  jobId: z.string().min(1),
  at: TimestampSchema,
}));

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
export const WorkspaceSlackIngressClaimResultSchema = deferredZodSchema(() => z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("claimed"),
    leaseId: z.string().min(1),
    job: z.strictObject({
      jobId: z.string().min(1),
      connectionId: z.string().min(1),
      teamId: z.string().min(1),
      bodyHash: z.string().min(1),
      kind: SlackIngressJobKindSchema,
      payloadJson: z.string().nullable(),
    }),
  }),
  /** Terminal, at the attempt ceiling, or another worker's live lease. */
  z.strictObject({ outcome: z.literal("unavailable") }),
]));

export const WorkspaceSlackIngressCompleteRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  jobId: z.string().min(1),
  leaseId: z.string().min(1),
  at: TimestampSchema,
}));

export const WorkspaceSlackIngressSettleResultSchema = deferredZodSchema(() => z.strictObject({
  outcome: z.enum(["settled", "stale"]),
}));

export const WorkspaceSlackIngressFailRequestSchema = deferredZodSchema(() => z.strictObject({
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
}));

/**
 * The failure and the exhaustion-notice decision, taken together.
 *
 * The facade version wrote the failure and then read for a sibling episode as
 * a second statement, so two jobs exhausting at once could both find no
 * sibling and both notify. One transaction answers "is this the episode's
 * first report" from the same state the write produced.
 */
export const WorkspaceSlackIngressFailResultSchema = deferredZodSchema(() => z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("failed"),
    attemptCount: z.number().int().nonnegative(),
    exhausted: z.boolean(),
    /** True when no other job on this connection exhausted the same way inside the episode. */
    firstExhaustionReport: z.boolean(),
  }),
  z.strictObject({ outcome: z.literal("stale") }),
]));

export const WorkspaceSlackIngressRecoverableRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  /** Queued or failed jobs untouched since this instant are worth re-announcing. */
  staleBefore: TimestampSchema,
  at: TimestampSchema,
  limit: z.number().int().positive(),
}));

export const WorkspaceSlackIngressRecoverableResultSchema = deferredZodSchema(() => z.strictObject({
  jobIds: z.array(z.string().min(1)),
}));

export const WorkspaceSlackIngressSweepRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  at: TimestampSchema,
  /** Completed and permanently failed jobs older than this are removed. */
  retentionCutoff: TimestampSchema,
  /** Link challenges spent or expired before this are removed. */
  spentBefore: TimestampSchema,
  /** How many exhausted jobs the standing report names. */
  exhaustedReportLimit: z.number().int().positive(),
}));

export const WorkspaceSlackIngressSweepResultSchema = deferredZodSchema(() => z.strictObject({
  /** The standing exhausted set after the sweep, newest first. */
  exhausted: z.array(z.strictObject({
    jobId: z.string().min(1),
    errorCode: z.string().nullable(),
  })),
}));

/**
 * Whether a bare thread reply belongs to Rally. The thread is looked up as an
 * external conversation binding under the installation (`slack:<team>`), so
 * the answer is the same one ingress will act on; the connection still keys
 * the pending-prompt half, which is connection-scoped delivery state.
 */
export const WorkspaceSlackThreadRoutableRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  installationId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
  slackUserId: z.string().min(1),
  at: TimestampSchema,
}));

export const WorkspaceSlackThreadRoutableResultSchema = deferredZodSchema(() => z.strictObject({
  routable: z.boolean(),
  /** The thread or its room is suspended: the reply creates no work. */
  suspended: z.boolean(),
}));

export const WorkspaceSlackPendingPromptRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
  slackUserId: z.string().min(1),
  at: TimestampSchema,
}));

export const WorkspaceSlackPendingPromptResultSchema = deferredZodSchema(() => z.strictObject({
  prompt: z.string().nullable(),
}));

export const WorkspaceSlackPendingPromptStoreRequestSchema = deferredZodSchema(() => z.strictObject({
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
}));

export const WorkspaceSlackPendingPromptClearRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
  slackUserId: z.string().min(1),
}));

export const WorkspaceSlackThreadClaimRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
  at: TimestampSchema,
}));

/**
 * Either this caller now initializes the thread, or somebody else already is.
 *
 * The lease is minted inside the object and only returned on the branch that
 * won, so a loser cannot hold a lease id at all — the shape that let a
 * `rowsWritten` comparison masquerade as a claim elsewhere.
 */
export const WorkspaceSlackThreadClaimResultSchema = deferredZodSchema(() => z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("claimed"), leaseId: z.string().min(1) }),
  z.strictObject({ outcome: z.literal("held") }),
]));

export const WorkspaceSlackThreadReleaseRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
  leaseId: z.string().min(1),
}));

/**
 * The App Home context and feedback Rally keeps per Slack user.
 *
 * `slack_agent_contexts` is keyed `(connection_id, slack_user_id)` and carries
 * no `workspace_id` of its own — the workspace is how the caller found the
 * object, not a column. Its requests still take `workspaceId` so the object can
 * assert the caller reached the right one, exactly as every other method here.
 */
const SlackFeedbackRatingSchema = z.enum(["helpful", "needs_improvement"]);

export const WorkspaceSlackContextRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  slackUserId: z.string().min(1),
}));

export const WorkspaceSlackContextResultSchema = deferredZodSchema(() => z.strictObject({
  contextJson: z.string().nullable(),
}));

export const WorkspaceSlackContextStoreRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  connectionId: z.string().min(1),
  slackUserId: z.string().min(1),
  contextJson: z.string().min(1),
  at: TimestampSchema,
}));

/**
 * One feedback row per ingress job.
 *
 * `ingress_job_id` is `UNIQUE`, so a redelivered interaction is a replay rather
 * than an error. The statement this replaced already ignored the conflict and
 * was right to; what it could not do was say which case it had hit, because it
 * discarded the result. The witness makes the replay reportable, which is the
 * only thing a caller can usefully do with it.
 */
export const WorkspaceSlackFeedbackRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  feedbackId: z.string().min(1),
  ingressJobId: z.string().min(1),
  workstreamId: IdSchema,
  userId: IdSchema,
  connectionId: z.string().min(1),
  rating: SlackFeedbackRatingSchema,
  comment: z.string().nullable(),
  at: TimestampSchema,
}));

export const WorkspaceSlackFeedbackResultSchema = deferredZodSchema(() => z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("recorded") }),
  z.strictObject({ outcome: z.literal("replayed") }),
]));

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
export type WorkspaceSlackContextRequest = z.infer<typeof WorkspaceSlackContextRequestSchema>;
export type WorkspaceSlackContextResult = z.infer<typeof WorkspaceSlackContextResultSchema>;
export type WorkspaceSlackContextStoreRequest = z.infer<typeof WorkspaceSlackContextStoreRequestSchema>;
export type WorkspaceSlackFeedbackRequest = z.infer<typeof WorkspaceSlackFeedbackRequestSchema>;
export type WorkspaceSlackFeedbackResult = z.infer<typeof WorkspaceSlackFeedbackResultSchema>;
