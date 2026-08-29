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
