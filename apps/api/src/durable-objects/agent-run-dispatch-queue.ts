/**
 * Durable scheduling for the agent run dispatch queues.
 *
 * A Durable Object's alarm is its only self-wake. Nothing outside the object
 * observes that the alarm is missing, so an object that clears its own alarm
 * while durable work is still outstanding goes inert permanently and silently.
 * That is not a hypothetical: it is what stalled every agent run behind a
 * spinner until the queue was audited.
 *
 * The rule these helpers exist to enforce is therefore narrow and absolute:
 *
 *   **The next wake-up is a pure function of persisted rows.**
 *
 * No in-memory value may be an input. Knowing in memory that a drain is
 * already running is an optimization for avoiding duplicate work; it is never
 * a reason to stop scheduling, because the process holding that knowledge is
 * exactly what a cancellation destroys. The previous implementation consulted
 * a `drainActive` flag here, so an invocation cancelled between claiming a row
 * and finishing it left the row `running` with no alarm to rediscover it.
 *
 * A claim therefore carries a deadline rather than being an open-ended state.
 * `lease_expires_at` is what makes "someone is working on this" and "someone
 * died working on this" distinguishable without a live process to ask, which
 * is the same pattern `memory_index_outbox` and `workstream_notification_intents`
 * already use. BlockDashboard's `agent_run_dispatches` was the only remaining
 * queue in the object schemas that had skipped it. SubstreamAgent owns one
 * persistent loop instead of a per-message dispatch queue.
 */

/**
 * How long a claim holds a dispatch before another invocation may reclaim it.
 *
 * This bounds *rediscovery*, not concurrent execution: the harness attempt
 * claim in D1 is the real mutual exclusion, and a reclaim that races a run
 * that is merely slow is turned away there and backs off. Matching that lease
 * keeps the two from disagreeing about who is late.
 */
export const AGENT_RUN_DISPATCH_LEASE_MS = 5 * 60_000;

/**
 * The longest an object may sleep while any dispatch is unfinished.
 *
 * Defence in depth, and deliberately redundant with the derivation below: if a
 * future change reintroduces a scheduling bug, this bounds the damage to one
 * interval instead of forever. It costs one alarm per minute per object that
 * genuinely has work outstanding, and nothing at all for idle objects.
 */
export const AGENT_RUN_DISPATCH_SWEEP_MS = 60_000;

/**
 * Identifies the BlockDashboard dispatch table. Both columns are compile-time
 * constants from its schema and are interpolated into SQL; they must never be
 * derived from a request.
 */
export interface AgentRunDispatchTable {
  readonly name: string;
  readonly idColumn: string;
  readonly payloadColumn: string;
}

export const BLOCK_DASHBOARD_RUN_DISPATCHES: AgentRunDispatchTable = {
  name: "agent_run_dispatches",
  idColumn: "block_run_id",
  payloadColumn: "dispatch_json",
};

export interface AgentRunDispatchClaim {
  readonly id: string;
  readonly payload: string;
  /** True when this claim is the run's first, so the caller must record a start. */
  readonly started: boolean;
  readonly leaseToken: string;
  readonly leaseExpiresAt: number;
  readonly attempt: number;
}

/**
 * When one dispatch row is next owed attention.
 *
 * A queued row is due at `available_at`. A running row is due at whichever is
 * later of its retry time and its lease expiry: before the lease lapses no one
 * may touch it, and once it lapses it is an orphan that must be reclaimed.
 * Either way it keeps a wake-up armed, which is the property that was missing.
 *
 * Exported because `BlockDashboardAgent` selects over a second lane of its own
 * and cannot use the whole query below; the expression itself must not be
 * copied, or the two lanes will drift apart on the subtle half.
 */
export const AGENT_RUN_DISPATCH_DUE_AT_SQL = `CASE
         WHEN state = 'queued' THEN available_at
         WHEN lease_expires_at IS NULL THEN available_at
         WHEN lease_expires_at > available_at THEN lease_expires_at
         ELSE available_at
       END`;

/**
 * Caps a derived wake-up at the sweep interval. Both objects must route their
 * due time through this rather than reimplementing the floor.
 */
export function applyAgentRunDispatchSweepFloor(
  dueAt: number | null,
  now: number,
  sweepMs: number = AGENT_RUN_DISPATCH_SWEEP_MS,
): number | null {
  if (dueAt === null) return null;
  return Math.min(dueAt, now + sweepMs);
}

/**
 * When the object must next wake for this queue, or null when nothing is
 * outstanding.
 */
export function nextAgentRunDispatchWakeUpAt(
  sql: SqlStorage,
  table: AgentRunDispatchTable,
  now: number,
  sweepMs: number = AGENT_RUN_DISPATCH_SWEEP_MS,
): number | null {
  const dueAt = sql.exec<{ due_at: number | null }>(
    `SELECT MIN(${AGENT_RUN_DISPATCH_DUE_AT_SQL}) AS due_at
       FROM ${table.name}
      WHERE state IN ('queued', 'running')`,
  ).toArray()[0]?.due_at ?? null;
  return applyAgentRunDispatchSweepFloor(dueAt, now, sweepMs);
}

/**
 * Releases every lease held by a previous isolate. Call once, during
 * construction.
 *
 * A lease can only be held by a living isolate, and a Durable Object runs at
 * most one isolate per object id, so any lease still recorded when a new one
 * boots was issued by an isolate that is gone. Without this the object would
 * wait out the full lease before recovering a run whose owner died seconds
 * ago — the recovery latency, not just the recovery, is what a member feels.
 */
export function releaseAgentRunDispatchLeases(
  sql: SqlStorage,
  table: AgentRunDispatchTable,
  now: number,
): void {
  sql.exec(
    `UPDATE ${table.name}
        SET lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE state = 'running' AND lease_expires_at IS NOT NULL`,
    now,
  );
}

/**
 * Takes the next due dispatch under a lease, or returns null when none is
 * available.
 *
 * The select and the update are deliberately adjacent with no `await` between
 * them. Durable Object invocations interleave only at await points, so the
 * pair is atomic against every other invocation of the same object, and the
 * guarded `WHERE` makes a lost race a no-op rather than a double claim.
 */
export function claimAgentRunDispatch(
  sql: SqlStorage,
  table: AgentRunDispatchTable,
  options: {
    readonly now: number;
    readonly leaseToken: string;
    readonly leaseMs?: number;
  },
): AgentRunDispatchClaim | null {
  const { now, leaseToken } = options;
  const leaseExpiresAt = now + (options.leaseMs ?? AGENT_RUN_DISPATCH_LEASE_MS);
  // A run left behind by a dead invocation outranks new work: recovering it is
  // what keeps the member's spinner from being permanent.
  const candidate = sql.exec<{
    id: string;
    payload: string;
    state: string;
    started_at: number | null;
  }>(
    `SELECT ${table.idColumn} AS id, ${table.payloadColumn} AS payload, state, started_at
       FROM ${table.name}
      WHERE state IN ('queued', 'running')
        AND available_at <= ?1
        AND (state = 'queued' OR lease_expires_at IS NULL OR lease_expires_at <= ?1)
      ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END, created_at, ${table.idColumn}
      LIMIT 1`,
    now,
  ).toArray()[0];
  if (!candidate) return null;

  const claimed = sql.exec(
    `UPDATE ${table.name}
        SET state = 'running',
            attempt = attempt + 1,
            started_at = COALESCE(started_at, ?2),
            lease_token = ?3,
            lease_expires_at = ?4,
            updated_at = ?2
      WHERE ${table.idColumn} = ?1
        AND state IN ('queued', 'running')
        AND (state = 'queued' OR lease_expires_at IS NULL OR lease_expires_at <= ?2)`,
    candidate.id,
    now,
    leaseToken,
    leaseExpiresAt,
  ).rowsWritten;
  if (claimed === 0) return null;

  const attempt = sql.exec<{ attempt: number }>(
    `SELECT attempt FROM ${table.name} WHERE ${table.idColumn} = ?`,
    candidate.id,
  ).toArray()[0]?.attempt ?? 1;
  return {
    id: candidate.id,
    payload: candidate.payload,
    started: candidate.started_at === null,
    leaseToken,
    leaseExpiresAt,
    attempt,
  };
}

/**
 * Returns a claimed dispatch to the queue for a later attempt.
 *
 * The lease is dropped rather than extended: the row is no longer being worked
 * on, and leaving a lease behind would postpone rediscovery to its expiry.
 *
 * The write is fenced on the caller's own `leaseToken` and reports whether it
 * landed. A stored token that nothing verifies is decoration: an execution that
 * outlived its claim would otherwise clear the lease its successor is holding,
 * and a NULL lease reads as immediately reclaimable — so an unfenced release
 * turns one late writer into two concurrent runs. False means the caller was
 * fenced out and must not act further on the row.
 */
export function deferAgentRunDispatch(
  sql: SqlStorage,
  table: AgentRunDispatchTable,
  id: string,
  leaseToken: string,
  availableAt: number,
  errorCode: string | null,
  now: number,
): boolean {
  return sql.exec(
    `UPDATE ${table.name}
        SET state = 'running',
            available_at = ?3,
            last_error_code = ?4,
            lease_token = NULL,
            lease_expires_at = NULL,
            updated_at = ?5
      WHERE ${table.idColumn} = ?1 AND lease_token = ?2`,
    id,
    leaseToken,
    availableAt,
    errorCode,
    now,
  ).rowsWritten > 0;
}

/** Moves a dispatch to a terminal state and releases its lease. */
export function settleAgentRunDispatch(
  sql: SqlStorage,
  table: AgentRunDispatchTable,
  id: string,
  leaseToken: string,
  state: "completed" | "failed",
  errorCode: string | null,
  now: number,
): boolean {
  return sql.exec(
    `UPDATE ${table.name}
        SET state = ?3,
            completed_at = ?4,
            last_error_code = ?5,
            lease_token = NULL,
            lease_expires_at = NULL,
            updated_at = ?4
      WHERE ${table.idColumn} = ?1 AND lease_token = ?2`,
    id,
    leaseToken,
    state,
    now,
    errorCode,
  ).rowsWritten > 0;
}
