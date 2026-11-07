import { sha256Hex } from "../lib/crypto";
import { uuidV7 } from "../lib/uuid-v7";
import { ExternalConversationBindingStorage } from "./workspace-external-binding-storage";
import {
  SLACK_SIDEKICK_SOURCE_JOIN_EVENT,
  WorkspaceSlackIngressClaimResultSchema,
  WorkspaceSlackIngressEnqueueResultSchema,
  WorkspaceSlackIngressFailResultSchema,
  WorkspaceSlackIngressRecoverableResultSchema,
  WorkspaceSlackIngressSettleResultSchema,
  WorkspaceSlackIngressSweepResultSchema,
  WorkspaceSlackPendingPromptResultSchema,
  WorkspaceSlackThreadClaimResultSchema,
  WorkspaceSlackThreadRoutableResultSchema,
  WorkspaceSlackContextResultSchema,
  WorkspaceSlackFeedbackResultSchema,
  type WorkspaceSlackIngressClaimRequest,
  type WorkspaceSlackIngressClaimResult,
  type WorkspaceSlackIngressCompleteRequest,
  type WorkspaceSlackIngressEnqueueRequest,
  type WorkspaceSlackIngressEnqueueResult,
  type WorkspaceSlackIngressFailRequest,
  type WorkspaceSlackIngressFailResult,
  type WorkspaceSlackIngressRecoverableRequest,
  type WorkspaceSlackIngressRecoverableResult,
  type WorkspaceSlackIngressSettleResult,
  type WorkspaceSlackIngressSweepRequest,
  type WorkspaceSlackIngressSweepResult,
  type WorkspaceSlackPendingPromptClearRequest,
  type WorkspaceSlackPendingPromptRequest,
  type WorkspaceSlackPendingPromptResult,
  type WorkspaceSlackPendingPromptStoreRequest,
  type WorkspaceSlackThreadClaimRequest,
  type WorkspaceSlackThreadClaimResult,
  type WorkspaceSlackThreadReleaseRequest,
  type WorkspaceSlackContextRequest,
  type WorkspaceSlackContextResult,
  type WorkspaceSlackContextStoreRequest,
  type WorkspaceSlackFeedbackRequest,
  type WorkspaceSlackFeedbackResult,
  type WorkspaceSlackThreadRoutableRequest,
  type WorkspaceSlackThreadRoutableResult,
  SLACK_INGRESS_ATTEMPT_LIMIT,
} from "./workspace-slack-protocol";

/**
 * How long one worker's claim on an ingress job holds before another may take
 * it. Unchanged from the service-side `5 * 60_000` it replaces; the Queue
 * redelivers on this horizon, so a worker that died mid-attempt is reclaimed
 * rather than mourned.
 */
const SLACK_INGRESS_LEASE_MS = 5 * 60_000;

/**
 * How long the thread-initialization claim holds. Unchanged from the
 * service-side `5 * 60_000` it replaces — sized for one session creation, and
 * reaped by the maintenance sweep once expired.
 */
export const SLACK_THREAD_CLAIM_LEASE_MS = 5 * 60_000;

/**
 * Admit one ingress job, or say what stands where it would have gone.
 *
 * The insert and the duplicate read are one transaction, so the answer is the
 * row's own state rather than a `meta.changes` count — the physical-write
 * counter `docs/durable-object-sqlite.md` forbids deciding a logical outcome
 * from. Slack retries deliveries with the same id and body; those replay. The
 * same id with a different body is Slack reusing an event identity, which is
 * a conflict the caller refuses loudly.
 */
/**
 * The joins a Sidekick's saved Slack sources need, written as Slack ingress
 * jobs. A Sidekick hears a conversation's messages only if the bot is in it,
 * so a source that names conversations keeps the bot there; the ingress runs
 * the job with the installation's token. A join is not an invitation.
 *
 * A job is keyed by the Sidekick revision whose registrations named it, so
 * every accepted revision joins again: a bot removed from a conversation since
 * the last one, or a source that moved away and back, is rejoined rather than
 * deduplicated against a completed job for the same channel set. Returns the
 * jobs to dispatch.
 */
export async function enqueueSlackSourceJoins(
  storage: DurableObjectStorage,
  input: {
    workspaceId: string;
    automationId: string;
    revision: number;
    evaluators: readonly { source: { connectorType: string; connectionId: string }; when: unknown }[];
    appId: string | null;
  },
): Promise<{ jobId: string; connectionId: string }[]> {
  const byConnection = new Map<string, Set<string>>();
  for (const evaluator of input.evaluators) {
    if (evaluator.source.connectorType !== "slack") continue;
    const channelIds = slackSourceChannelIds(evaluator.when);
    if (channelIds.length === 0) continue;
    const set = byConnection.get(evaluator.source.connectionId) ?? new Set<string>();
    for (const channelId of channelIds) set.add(channelId);
    byConnection.set(evaluator.source.connectionId, set);
  }
  const jobs: { jobId: string; connectionId: string }[] = [];
  for (const [connectionId, channelIds] of byConnection) {
    const connection = storage.sql.exec<{ provider_account_id: string | null }>(
      `SELECT provider_account_id FROM connector_connections
        WHERE id = ? AND connector_type = 'slack' AND scope = 'workspace' AND status <> 'disabled'`,
      connectionId,
    ).toArray()[0];
    if (!connection?.provider_account_id) continue;
    const channels = [...channelIds].sort();
    const eventId = `rally-sidekick-source-join:${input.automationId}:g${input.revision}:${channels.join(",")}`;
    const payloadJson = JSON.stringify({
      type: "event_callback",
      team_id: connection.provider_account_id,
      ...(input.appId ? { api_app_id: input.appId } : {}),
      event_id: eventId,
      event: { type: SLACK_SIDEKICK_SOURCE_JOIN_EVENT, channel_ids: channels },
    });
    const jobId = `event:${eventId}`;
    const admitted = enqueueWorkspaceSlackIngressJob(storage, {
      workspaceId: input.workspaceId,
      jobId,
      connectionId,
      teamId: connection.provider_account_id,
      bodyHash: await sha256Hex(payloadJson),
      kind: "event",
      payloadJson,
      at: new Date().toISOString(),
    });
    if (admitted.outcome === "replayed" && admitted.status === "completed") continue;
    jobs.push({ jobId, connectionId });
  }
  return jobs;
}

/** The conversations a Slack source's predicate names by `channelId`. */
function slackSourceChannelIds(when: unknown): string[] {
  const predicate = when as { kind?: unknown; allOf?: unknown };
  if (predicate.kind !== "all" || !Array.isArray(predicate.allOf)) return [];
  return predicate.allOf.flatMap((leaf: unknown) => {
    const candidate = leaf as { kind?: unknown; attribute?: unknown; operator?: unknown; value?: unknown };
    if (candidate.kind !== "string" || candidate.attribute !== "channelId") return [];
    if (candidate.operator === "equals" && typeof candidate.value === "string") return [candidate.value];
    if (candidate.operator === "in" && Array.isArray(candidate.value)) {
      return candidate.value.filter((value): value is string => typeof value === "string");
    }
    return [];
  });
}

export function enqueueWorkspaceSlackIngressJob(
  storage: DurableObjectStorage,
  request: WorkspaceSlackIngressEnqueueRequest,
): WorkspaceSlackIngressEnqueueResult {
  return storage.transactionSync(() => {
    const inserted = storage.sql.exec<{ id: string }>(
      `INSERT INTO slack_ingress_jobs
         (id, workspace_id, connection_id, team_id, body_hash, kind, payload_json,
          status, attempt_count, received_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING
       RETURNING id`,
      request.jobId,
      request.workspaceId,
      request.connectionId,
      request.teamId,
      request.bodyHash,
      request.kind,
      request.payloadJson,
      request.at,
      request.at,
    ).toArray()[0];
    if (inserted?.id === request.jobId) {
      return WorkspaceSlackIngressEnqueueResultSchema.parse({ outcome: "queued" });
    }
    const prior = storage.sql.exec<{ body_hash: string; status: string }>(
      `SELECT body_hash, status FROM slack_ingress_jobs WHERE id = ?`,
      request.jobId,
    ).toArray()[0];
    // The insert lost its conflict inside the same transaction, so the prior
    // row cannot be gone. Absence is a storage invariant broken, not a domain
    // outcome.
    if (!prior) throw new Error("slack_ingress_prior_job_missing");
    return WorkspaceSlackIngressEnqueueResultSchema.parse(
      prior.body_hash === request.bodyHash
        ? { outcome: "replayed", status: prior.status }
        : { outcome: "conflict" },
    );
  });
}

/**
 * Claim one job for processing, minting the lease that fences its settlement.
 *
 * A job at the attempt ceiling is not claimable: the Queue redelivers a
 * message whose processing threw, and without the bound every redelivery
 * re-ran a dead job, pinned it again, and reported it again. A worker that
 * died mid-attempt (`processing` with an expired lease) is reclaimed
 * regardless, because its attempt was never recorded as a failure. The
 * returned witness is the row the update took, per
 * `docs/durable-object-sqlite.md` — never a row count.
 */
export function claimWorkspaceSlackIngressJob(
  storage: DurableObjectStorage,
  request: WorkspaceSlackIngressClaimRequest,
): WorkspaceSlackIngressClaimResult {
  const leaseId = uuidV7();
  const leaseExpiresAt = new Date(Date.parse(request.at) + SLACK_INGRESS_LEASE_MS).toISOString();
  const claimed = storage.sql.exec<{
    id: string;
    connection_id: string;
    team_id: string;
    body_hash: string;
    kind: "event" | "interaction" | "command";
    payload_json: string | null;
    lease_id: string;
  }>(
    `UPDATE slack_ingress_jobs SET
       status = 'processing', attempt_count = attempt_count + 1,
       lease_id = ?, lease_expires_at = ?, error_code = NULL, updated_at = ?
     WHERE id = ? AND workspace_id = ?
       AND ((status IN ('queued', 'failed') AND attempt_count < ${SLACK_INGRESS_ATTEMPT_LIMIT})
         OR (status = 'processing' AND lease_expires_at < ?))
     RETURNING id, connection_id, team_id, body_hash, kind, payload_json, lease_id`,
    leaseId,
    leaseExpiresAt,
    request.at,
    request.jobId,
    request.workspaceId,
    request.at,
  ).toArray()[0];
  if (claimed?.id !== request.jobId || claimed.lease_id !== leaseId) {
    return WorkspaceSlackIngressClaimResultSchema.parse({ outcome: "unavailable" });
  }
  return WorkspaceSlackIngressClaimResultSchema.parse({
    outcome: "claimed",
    leaseId,
    job: {
      jobId: claimed.id,
      connectionId: claimed.connection_id,
      teamId: claimed.team_id,
      bodyHash: claimed.body_hash,
      kind: claimed.kind,
      payloadJson: claimed.payload_json,
    },
  });
}

/** Settle a claimed job as done, clearing the payload it no longer needs. */
export function completeWorkspaceSlackIngressJob(
  storage: DurableObjectStorage,
  request: WorkspaceSlackIngressCompleteRequest,
): WorkspaceSlackIngressSettleResult {
  const settled = storage.sql.exec<{ id: string }>(
    `UPDATE slack_ingress_jobs SET status = 'completed', payload_json = NULL,
       lease_id = NULL, lease_expires_at = NULL, error_code = NULL,
       completed_at = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND lease_id = ?
     RETURNING id`,
    request.at,
    request.at,
    request.jobId,
    request.workspaceId,
    request.leaseId,
  ).toArray()[0];
  return WorkspaceSlackIngressSettleResultSchema.parse({
    outcome: settled?.id === request.jobId ? "settled" : "stale",
  });
}

/**
 * Record a claimed job's failure, and decide the exhaustion notice with it.
 *
 * A non-retryable failure pins the attempt count at the ceiling, which is
 * right while the cause is dead — only the reauthorization re-drive lifts it.
 * The episode check runs in the same transaction as the write, so two jobs
 * exhausting concurrently see each other and only one is the episode's first
 * report; as two facade statements both could find no sibling and both notify.
 */
export function failWorkspaceSlackIngressJob(
  storage: DurableObjectStorage,
  request: WorkspaceSlackIngressFailRequest,
): WorkspaceSlackIngressFailResult {
  return storage.transactionSync(() => {
    const failed = storage.sql.exec<{ attempt_count: number; connection_id: string }>(
      `UPDATE slack_ingress_jobs SET status = 'failed', lease_id = NULL,
         lease_expires_at = NULL, error_code = ?,
         attempt_count = CASE WHEN ? THEN attempt_count ELSE ${SLACK_INGRESS_ATTEMPT_LIMIT} END,
         updated_at = ?
       WHERE id = ? AND workspace_id = ? AND lease_id = ?
       RETURNING attempt_count, connection_id`,
      request.errorCode,
      request.retryable ? 1 : 0,
      request.at,
      request.jobId,
      request.workspaceId,
      request.leaseId,
    ).toArray()[0];
    if (!failed) {
      return WorkspaceSlackIngressFailResultSchema.parse({ outcome: "stale" });
    }
    const exhausted = failed.attempt_count >= SLACK_INGRESS_ATTEMPT_LIMIT;
    const episodeAlreadyReported = exhausted
      ? storage.sql.exec<{ reported: number }>(
        `SELECT 1 AS reported FROM slack_ingress_jobs
          WHERE connection_id = ? AND error_code = ? AND attempt_count >= ${SLACK_INGRESS_ATTEMPT_LIMIT}
            AND id <> ? AND updated_at > ?
          LIMIT 1`,
        failed.connection_id,
        request.errorCode,
        request.jobId,
        request.exhaustionEpisodeStartedAt,
      ).toArray().length > 0
      : false;
    return WorkspaceSlackIngressFailResultSchema.parse({
      outcome: "failed",
      attemptCount: failed.attempt_count,
      exhausted,
      firstExhaustionReport: exhausted && !episodeAlreadyReported,
    });
  });
}

/**
 * The jobs whose payload survives and whose processing has gone quiet.
 *
 * The predicate mirrors `claimWorkspaceSlackIngressJob`'s, and that alignment
 * is the point: this scan re-enqueues what that claim will take. The facade
 * statement applied the attempt ceiling to every row, including a `processing`
 * one whose lease had expired — which the claim reclaims regardless of attempt
 * count, because a dead worker recorded no outcome. That left one row nothing
 * could advance: a job whose worker died on its twentieth attempt stays
 * `processing` for ever, the alarm's `slack_ingress` arm reads a `processing`
 * row's due time as its `lease_expires_at` and so finds it permanently due,
 * this scan skipped it, and neither reap takes a `processing` row. The alarm
 * then wakes, sweeps nothing, and re-arms on the same instant. Applying the
 * ceiling only to `queued`/`failed` closes it: the reclaim settles the job,
 * a failure at the ceiling becomes `failed`, and `failed` has a reap and a
 * 30-day horizon.
 */
export function recoverableWorkspaceSlackIngressJobs(
  storage: DurableObjectStorage,
  request: WorkspaceSlackIngressRecoverableRequest,
): WorkspaceSlackIngressRecoverableResult {
  const rows = storage.sql.exec<{ id: string }>(
    `SELECT id FROM slack_ingress_jobs
     WHERE workspace_id = ? AND payload_json IS NOT NULL
       AND ((status IN ('queued', 'failed')
             AND attempt_count < ${SLACK_INGRESS_ATTEMPT_LIMIT}
             AND updated_at < ?)
         OR (status = 'processing' AND lease_expires_at < ?))
     ORDER BY received_at ASC LIMIT ?`,
    request.workspaceId,
    request.staleBefore,
    request.at,
    request.limit,
  ).toArray();
  return WorkspaceSlackIngressRecoverableResultSchema.parse({
    jobIds: rows.map((row) => row.id),
  });
}

/**
 * One maintenance pass over the ingress spine's four tables, and the standing
 * exhausted report from the state the pass left behind.
 *
 * The reaps and the report are one transaction because they are one alarm
 * pass: the workspace alarm's `slack_ingress` arm derives its next due time
 * from exactly these predicates, so a reap that removed less than the arm
 * counts — or a report over rows a concurrent reap was removing — is the hot
 * loop of 2026-08-22. The spent-challenge cutoff is the caller's, bound to the
 * grace horizon the alarm counts with, not to the 30-day retention.
 */
export function sweepWorkspaceSlackIngress(
  storage: DurableObjectStorage,
  request: WorkspaceSlackIngressSweepRequest,
): WorkspaceSlackIngressSweepResult {
  return storage.transactionSync(() => {
    storage.sql.exec(
      `DELETE FROM slack_ingress_jobs WHERE status = 'completed' AND completed_at < ?`,
      request.retentionCutoff,
    );
    storage.sql.exec(
      `DELETE FROM slack_link_challenges
        WHERE (consumed_at IS NOT NULL AND consumed_at < ?) OR expires_at < ?`,
      request.spentBefore,
      request.spentBefore,
    );
    storage.sql.exec(
      `DELETE FROM slack_agent_thread_claims WHERE lease_expires_at < ?`,
      request.at,
    );
    storage.sql.exec(
      `DELETE FROM slack_agent_pending_prompts WHERE expires_at < ?`,
      request.at,
    );

    storage.sql.exec(
      `DELETE FROM slack_ingress_jobs
        WHERE status = 'failed' AND attempt_count >= ${SLACK_INGRESS_ATTEMPT_LIMIT}
          AND updated_at < ?`,
      request.retentionCutoff,
    );
    const exhausted = storage.sql.exec<{ id: string; error_code: string | null }>(
      `SELECT id, error_code FROM slack_ingress_jobs
        WHERE status = 'failed' AND attempt_count >= ${SLACK_INGRESS_ATTEMPT_LIMIT}
        ORDER BY updated_at DESC LIMIT ?`,
      request.exhaustedReportLimit,
    ).toArray();
    return WorkspaceSlackIngressSweepResultSchema.parse({
      exhausted: exhausted.map((row) => ({ jobId: row.id, errorCode: row.error_code })),
    });
  });
}

/**
 * Whether a bare thread reply belongs to Rally: a thread binding that is
 * active or still being created, or a live pending prompt from this member
 * awaiting `try again`. A binding that resolves suspended (the thread, or its
 * room) is reported as such so ingress can log it and drop the reply.
 *
 * The binding is the routing authority; `slack_agent_sessions` is delivery
 * state and is no longer consulted here.
 */
export function workspaceSlackThreadRoutable(
  storage: DurableObjectStorage,
  request: WorkspaceSlackThreadRoutableRequest,
): WorkspaceSlackThreadRoutableResult {
  const resolution = new ExternalConversationBindingStorage(storage).resolve({
    installationId: request.installationId,
    path: [request.channelId, request.threadTs],
    addressed: false,
    claimKey: null,
    // Only the holding question matters to a routability check, and a
    // pending claim of any age still means the thread is Rally's.
    pendingStaleBefore: "0000-01-01T00:00:00.000Z",
  });
  if (resolution.outcome === "suspended") {
    return WorkspaceSlackThreadRoutableResultSchema.parse({ routable: false, suspended: true });
  }
  if (resolution.outcome === "deliver" || resolution.outcome === "hold") {
    return WorkspaceSlackThreadRoutableResultSchema.parse({ routable: true, suspended: false });
  }
  const pending = storage.sql.exec<{ routable: number }>(
    `SELECT 1 AS routable FROM slack_agent_pending_prompts
      WHERE connection_id = ? AND slack_channel_id = ? AND slack_thread_ts = ?
        AND slack_user_id = ? AND expires_at > ?`,
    request.connectionId,
    request.channelId,
    request.threadTs,
    request.slackUserId,
    request.at,
  ).toArray();
  return WorkspaceSlackThreadRoutableResultSchema.parse({ routable: pending.length > 0, suspended: false });
}

/** The prompt this member is still owed a retry of, if it has not expired. */
export function workspaceSlackPendingPrompt(
  storage: DurableObjectStorage,
  request: WorkspaceSlackPendingPromptRequest,
): WorkspaceSlackPendingPromptResult {
  const row = storage.sql.exec<{ prompt: string }>(
    `SELECT prompt FROM slack_agent_pending_prompts
     WHERE connection_id = ? AND slack_channel_id = ? AND slack_thread_ts = ?
       AND slack_user_id = ? AND expires_at > ?`,
    request.connectionId,
    request.channelId,
    request.threadTs,
    request.slackUserId,
    request.at,
  ).toArray()[0];
  return WorkspaceSlackPendingPromptResultSchema.parse({ prompt: row?.prompt ?? null });
}

/** Retain a denied prompt so `try again` can replay it once the cause is fixed. */
export function rememberWorkspaceSlackPendingPrompt(
  storage: DurableObjectStorage,
  request: WorkspaceSlackPendingPromptStoreRequest,
): void {
  storage.sql.exec(
    `INSERT INTO slack_agent_pending_prompts
       (connection_id, slack_channel_id, slack_thread_ts, slack_user_id, prompt,
        denial_reason, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(connection_id, slack_channel_id, slack_thread_ts, slack_user_id)
     DO UPDATE SET prompt = excluded.prompt, denial_reason = excluded.denial_reason,
       expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    request.connectionId,
    request.channelId,
    request.threadTs,
    request.slackUserId,
    request.prompt,
    request.denialReason,
    request.expiresAt,
    request.at,
    request.at,
  );
}

/** Drop a retained prompt: the request it held has been taken or superseded. */
export function clearWorkspaceSlackPendingPrompt(
  storage: DurableObjectStorage,
  request: WorkspaceSlackPendingPromptClearRequest,
): void {
  storage.sql.exec(
    `DELETE FROM slack_agent_pending_prompts
     WHERE connection_id = ? AND slack_channel_id = ? AND slack_thread_ts = ?
       AND slack_user_id = ?`,
    request.connectionId,
    request.channelId,
    request.threadTs,
    request.slackUserId,
  );
}

/**
 * Take the right to initialize one Slack thread's session, or learn that a
 * live claim already holds it.
 *
 * The upsert takes the row outright when none exists, and takes over only a
 * lease that has already expired — `DO UPDATE … WHERE lease_expires_at < ?`.
 * The witness is the returned lease compared to the one just minted: an
 * upsert that changed nothing returns no row, and one that lost the conflict
 * returns the standing holder's lease, so the loser can never mistake the
 * winner's lease for its own.
 */
export function claimWorkspaceSlackThread(
  storage: DurableObjectStorage,
  request: WorkspaceSlackThreadClaimRequest,
): WorkspaceSlackThreadClaimResult {
  const leaseId = uuidV7();
  const claimed = storage.sql.exec<{ lease_id: string }>(
    `INSERT INTO slack_agent_thread_claims
       (connection_id, slack_channel_id, slack_thread_ts, lease_id, lease_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(connection_id, slack_channel_id, slack_thread_ts) DO UPDATE SET
       lease_id = excluded.lease_id,
       lease_expires_at = excluded.lease_expires_at,
       updated_at = excluded.updated_at
     WHERE slack_agent_thread_claims.lease_expires_at < ?
     RETURNING lease_id`,
    request.connectionId,
    request.channelId,
    request.threadTs,
    leaseId,
    new Date(Date.parse(request.at) + SLACK_THREAD_CLAIM_LEASE_MS).toISOString(),
    request.at,
    request.at,
    request.at,
  ).toArray()[0];
  return WorkspaceSlackThreadClaimResultSchema.parse(
    claimed?.lease_id === leaseId
      ? { outcome: "claimed", leaseId }
      : { outcome: "held" },
  );
}

/** Give the initialization claim back, if it is still this caller's to give. */
export function releaseWorkspaceSlackThreadClaim(
  storage: DurableObjectStorage,
  request: WorkspaceSlackThreadReleaseRequest,
): void {
  storage.sql.exec(
    `DELETE FROM slack_agent_thread_claims
     WHERE connection_id = ? AND slack_channel_id = ? AND slack_thread_ts = ? AND lease_id = ?`,
    request.connectionId,
    request.channelId,
    request.threadTs,
    request.leaseId,
  );
}

export function workspaceSlackContext(
  storage: DurableObjectStorage,
  request: WorkspaceSlackContextRequest,
): WorkspaceSlackContextResult {
  const row = storage.sql.exec<{ context_json: string }>(
    `SELECT context_json FROM slack_agent_contexts
      WHERE connection_id = ? AND slack_user_id = ?`,
    request.connectionId,
    request.slackUserId,
  ).toArray()[0];
  return WorkspaceSlackContextResultSchema.parse({ contextJson: row?.context_json ?? null });
}

export function storeWorkspaceSlackContext(
  storage: DurableObjectStorage,
  request: WorkspaceSlackContextStoreRequest,
): void {
  storage.sql.exec(
    `INSERT INTO slack_agent_contexts (connection_id, slack_user_id, context_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(connection_id, slack_user_id)
       DO UPDATE SET context_json = excluded.context_json, updated_at = excluded.updated_at`,
    request.connectionId,
    request.slackUserId,
    request.contextJson,
    request.at,
  );
}

/** One row per ingress job; a redelivery is a replay, not a failure. */
export function recordWorkspaceSlackFeedback(
  storage: DurableObjectStorage,
  request: WorkspaceSlackFeedbackRequest,
): WorkspaceSlackFeedbackResult {
  const inserted = storage.sql.exec<{ id: string }>(
    `INSERT INTO slack_agent_feedback
       (id, ingress_job_id, workspace_id, workstream_id, user_id, connection_id, rating, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ingress_job_id) DO NOTHING
     RETURNING id`,
    request.feedbackId,
    request.ingressJobId,
    request.workspaceId,
    request.workstreamId,
    request.userId,
    request.connectionId,
    request.rating,
    request.comment,
    request.at,
  ).toArray()[0];
  return WorkspaceSlackFeedbackResultSchema.parse({
    outcome: inserted ? "recorded" : "replayed",
  });
}
