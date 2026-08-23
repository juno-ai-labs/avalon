/**
 * One work stream's harness runs, in the object's own vocabulary.
 *
 * This is the family the whole compat layer was built around, and the one where
 * the cost of a routed statement is easiest to see. Every operation here is a
 * *claim* on a lease, and a claim written as routed SQL is a compare-and-swap
 * spelled out in a `WHERE` clause whose answer comes back as a `meta.changes`
 * integer. So each one needed a second statement to learn what had actually
 * happened, and often a third: `heartbeatHarnessAttempt` updated the row, then
 * re-read it to decide whether zero changes meant a cancelled run or a lost
 * lease, then re-read it *again* to learn the deadline it had just written.
 *
 * Worse, the fence itself became a join. `INSERT INTO harness_run_scopes …
 * SELECT … FROM harness_runs WHERE lease_owner = ?` is how a dependent table's
 * write proved the writer still held the run — 33 `lease_owner = ?` predicates
 * across 59 `FROM harness_runs` clauses in the runtime alone. Inside one
 * transaction the fence is read once and the write follows it, so an operation
 * answers with the outcome rather than with a count to interpret.
 *
 * The retired `_runtime_harness_runs` view also remapped four statuses:
 * `admitted` published as `scheduled`, `cancelled` as `stopped`, and both
 * `waiting` and `steering` as `running`. This class speaks the object's
 * vocabulary; the published spelling is the port's caller's business.
 */

import { boundParameterChunks } from "./bound-parameters";

/** What a caller proved before it was allowed to write. */
export interface AttemptFence {
  runId: string;
  attemptId: string;
  owner: string;
  /** The instant the caller is asking about; a lease is live relative to it. */
  now: number;
}

/** Why a fenced operation refused, or that it did not. */
export type AttemptOutcome =
  | { outcome: "owned" }
  /** The member stopped it, or a supersede asked it to stop. */
  | { outcome: "cancelled" }
  /** Someone else holds the attempt, or the lease lapsed. */
  | { outcome: "ownership_lost" };

export type ClaimOutcome =
  | { outcome: "claimed"; attemptEpoch: number; leaseExpiresAt: number; startedAt: number }
  | { outcome: "not_claimable" };

export type HeartbeatOutcome =
  | { outcome: "renewed"; leaseExpiresAt: number }
  | { outcome: "cancelled" }
  | { outcome: "ownership_lost" };

export interface RunRow extends Record<string, SqlStorageValue> {
  run_id: string;
  status: string;
  origin: string;
  parent_run_id: string | null;
  parent_tool_call_id: string | null;
  legacy_attempt_id: string | null;
  attempt_epoch: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  cancellation_requested_at: number | null;
  cancellation_reason: string | null;
  terminalized_at: number | null;
  started_at: number;
  completed_at: number | null;
  final_part_id: string | null;
  error_json: string | null;
  workflow_instance_id: string | null;
  chain_root_run_id: string | null;
}

const RUN_COLUMNS = `run_id, status, origin, parent_run_id, parent_tool_call_id,
  legacy_attempt_id, attempt_epoch, lease_owner, lease_expires_at,
  cancellation_requested_at, cancellation_reason, terminalized_at, started_at,
  completed_at, final_part_id, error_json, workflow_instance_id, chain_root_run_id`;

function first<T>(cursor: SqlStorageCursor<T extends Record<string, SqlStorageValue> ? T : never>) {
  return cursor.toArray()[0];
}

export class WorkstreamHarnessRunStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  /** One run, or nothing. */
  run(input: { runId: string }): RunRow | undefined {
    return first(this.sql.exec<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = ?`,
      input.runId,
    ));
  }

  /**
   * Take or renew the attempt on a root run.
   *
   * The claim, its lifecycle event and the answer, in one transaction. The
   * routed version was a three-statement batch whose second and third
   * statements each re-stated the first's fence as a join — `attempt_id = ?4
   * AND lease_owner = ?5` — because a batch cannot ask whether its own earlier
   * statement landed. Here the update's own row count decides, once.
   *
   * The third statement of that batch wrote `workstreams.harness_status`, which
   * is the sidebar's projection of exactly this. It is not reproduced: the
   * endpoint runs this operation inside `commitRuntimeMutation`, so the
   * projection is committed with the claim rather than as a guarded follow-up
   * that could be lost.
   */
  claimAttempt(input: AttemptFence & {
    leaseSeconds: number;
    lifecycleEventId: string;
  }): ClaimOutcome {
    return this.storage.transactionSync(() => {
      const expiresAt = input.now + input.leaseSeconds * 1_000;
      this.sql.exec(
        `UPDATE runs
            SET status = 'running',
                started_at = CASE WHEN started_at = 0 THEN ?5 ELSE started_at END,
                attempt_epoch = CASE WHEN legacy_attempt_id = ?2
                  THEN attempt_epoch ELSE attempt_epoch + 1 END,
                legacy_attempt_id = ?2,
                lease_owner = ?3,
                heartbeat_at = ?5,
                lease_expires_at = ?4,
                updated_at = ?5
          WHERE run_id = ?1
            AND parent_tool_call_id IS NULL
            AND status IN ('admitted', 'running')
            AND terminalized_at IS NULL
            AND cancellation_requested_at IS NULL
            AND (
              legacy_attempt_id IS NULL
              OR (legacy_attempt_id = ?2 AND lease_owner = ?3)
              OR lease_expires_at IS NULL
              OR lease_expires_at <= ?5
            )
            -- One mutating run per work stream, except HyperSight blocks,
            -- which each own their own. The runs_mutating_substream_uq index
            -- enforces one per substream; this is the product rule on top of
            -- it, and it is why a second interactive run waits rather than
            -- racing.
            AND (
              origin = 'block_dashboard_block'
              OR NOT EXISTS (
                SELECT 1 FROM runs active
                 WHERE active.run_id != ?1
                   AND active.origin != 'block_dashboard_block'
                   AND active.parent_tool_call_id IS NULL
                   AND active.status = 'running'
                   AND active.terminalized_at IS NULL
                   AND active.lease_expires_at > ?5
              )
            )`,
        input.runId,
        input.attemptId,
        input.owner,
        expiresAt,
        input.now,
      );
      const claimed = this.run({ runId: input.runId });
      if (!claimed
        || claimed.legacy_attempt_id !== input.attemptId
        || claimed.lease_owner !== input.owner
        || claimed.lease_expires_at !== expiresAt) {
        return { outcome: "not_claimable" as const };
      }
      this.recordLifecycleEvent({
        eventId: input.lifecycleEventId,
        runId: input.runId,
        attemptId: input.attemptId,
        eventKey: `attempt:${input.attemptId}:claimed`,
        eventType: "claimed",
        status: "running",
        memberSafePayloadJson: "{}",
        now: input.now,
      });
      return {
        outcome: "claimed" as const,
        attemptEpoch: claimed.attempt_epoch,
        leaseExpiresAt: expiresAt,
        startedAt: claimed.started_at,
      };
    });
  }

  /**
   * Push the lease deadline forward, and say why not when it does not move.
   *
   * Three round trips became one. The routed version updated, then — on zero
   * changes — read the row to tell a cancelled run from a lost lease, then read
   * it a third time to learn the deadline it had itself just written. The
   * distinction still matters to the caller, because a cancelled run is an
   * ordinary end and a lost lease is a run that has been taken over.
   */
  heartbeatAttempt(input: AttemptFence & { leaseSeconds: number }): HeartbeatOutcome {
    return this.storage.transactionSync(() => {
      const expiresAt = input.now + input.leaseSeconds * 1_000;
      const existing = this.run({ runId: input.runId });
      if (!existing) return { outcome: "ownership_lost" as const };
      if (existing.status === "cancelled" || existing.cancellation_requested_at !== null) {
        return { outcome: "cancelled" as const };
      }
      if (existing.legacy_attempt_id !== input.attemptId
        || existing.lease_owner !== input.owner
        || existing.status !== "running"
        || existing.terminalized_at !== null
        || existing.lease_expires_at === null
        || existing.lease_expires_at <= input.now) {
        return { outcome: "ownership_lost" as const };
      }
      this.sql.exec(
        `UPDATE runs SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
          WHERE run_id = ?`,
        input.now,
        expiresAt,
        input.now,
        input.runId,
      );
      return { outcome: "renewed" as const, leaseExpiresAt: expiresAt };
    });
  }

  /**
   * Whether the caller still holds this attempt, and if not, why.
   *
   * `allowCancellationRequested` is the one variation the routed predicates
   * had, and it is deliberate rather than an oversight: a live lease owner may
   * close a tool that was already running when cancellation was requested.
   * Cancellation blocks *new* work; it cannot strand a child receipt the same
   * attempt has to settle before it can terminalize.
   */
  attemptOwnership(input: AttemptFence & {
    allowCancellationRequested?: boolean;
  }): AttemptOutcome {
    const row = this.run({ runId: input.runId });
    if (!row
      || row.legacy_attempt_id !== input.attemptId
      || row.lease_owner !== input.owner
      || row.terminalized_at !== null
      || row.lease_expires_at === null
      || row.lease_expires_at <= input.now) {
      return { outcome: "ownership_lost" };
    }
    if (!input.allowCancellationRequested
      && (row.status === "cancelled" || row.cancellation_requested_at !== null)) {
      return { outcome: "cancelled" };
    }
    if (row.status !== "running") return { outcome: "ownership_lost" };
    return { outcome: "owned" };
  }

  /**
   * Record one immutable lifecycle event.
   *
   * `ON CONFLICT DO NOTHING` on `(run_id, event_key)` is the whole idempotency
   * story: an event key names the thing that happened once, so a replay writes
   * nothing and says so.
   */
  recordLifecycleEvent(input: {
    eventId: string;
    runId: string;
    attemptId: string | null;
    eventKey: string;
    eventType: string;
    status: string;
    memberSafePayloadJson: string;
    now: number;
  }): { outcome: "recorded" | "replayed" } {
    const before = this.lifecycleEvent({ runId: input.runId, eventKey: input.eventKey });
    if (before) return { outcome: "replayed" };
    this.sql.exec(
      `INSERT INTO run_lifecycle_events
         (event_id, run_id, attempt_id, event_key, event_type, status,
          member_safe_payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, event_key) DO NOTHING`,
      input.eventId,
      input.runId,
      input.attemptId,
      input.eventKey,
      input.eventType,
      input.status,
      input.memberSafePayloadJson,
      input.now,
    );
    return { outcome: "recorded" };
  }

  /** One lifecycle event by the key that names it, or nothing. */
  lifecycleEvent(input: { runId: string; eventKey: string }): {
    event_id: string;
    attempt_id: string | null;
    event_type: string;
    status: string;
    member_safe_payload_json: string;
    created_at: number;
  } | undefined {
    return first(this.sql.exec<{
      event_id: string;
      attempt_id: string | null;
      event_type: string;
      status: string;
      member_safe_payload_json: string;
      created_at: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT event_id, attempt_id, event_type, status, member_safe_payload_json, created_at
         FROM run_lifecycle_events WHERE run_id = ? AND event_key = ?`,
      input.runId,
      input.eventKey,
    ));
  }

  /** Every run named, for a caller resolving a batch of ids. */
  runsByIds(input: { runIds: readonly string[] }): RunRow[] {
    if (input.runIds.length === 0) return [];
    return boundParameterChunks(input.runIds).flatMap((ids) =>
      this.sql.exec<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM runs WHERE run_id IN (${ids.map(() => "?").join(", ")})`,
        ...ids,
      ).toArray());
  }
}
