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

/**
 * Why a claim did or did not take, in the claim's own answer.
 *
 * Four states, because the caller acts differently on each — and the routed
 * version needed *two more round trips* to tell them apart: one to read back
 * the row it had just claimed, and one diagnostic `SELECT` with a correlated
 * subquery to work out why a zero-change update had refused. Both are the same
 * transaction as the claim here, so the answer cannot describe a row that has
 * since moved.
 */
export type ClaimOutcome =
  | { outcome: "claimed"; attemptEpoch: number; leaseExpiresAt: number; startedAt: number }
  /** Already finished. The caller reports the outcome rather than retrying. */
  | { outcome: "terminal"; status: string }
  /** A member stopped it, or a follow-up superseded it. */
  | { outcome: "cancelled" }
  /** Another run holds the work stream. `activeLeaseExpiresAt` is when to look again. */
  | { outcome: "busy"; activeLeaseExpiresAt: number | null }
  | { outcome: "not_found" };

/** The statuses a run does not come back from, in the object's vocabulary. */
const TERMINAL_RUN_STATUSES = new Set(["completed", "needs_input", "failed", "cancelled"]);

/**
 * What a write fenced by the attempt's lease did.
 *
 * Every one of these writes was a routed `INSERT … SELECT … FROM harness_runs
 * WHERE lease_owner = ?` followed by a diagnostic read, because the insert's
 * own `meta.changes` could not distinguish "already written by me" from "I no
 * longer hold the run". These four states are that distinction, made once.
 */
export type FencedWriteOutcome =
  | { outcome: "persisted" }
  /** The same attempt already wrote this exact row. A retry, not a conflict. */
  | { outcome: "reused" }
  /** A different value is already recorded, and these rows are immutable. */
  | { outcome: "mismatch" }
  | { outcome: "ownership_lost" };

export interface ScopeRow extends Record<string, SqlStorageValue> {
  run_id: string;
  attempt_id: string;
  execution_principal_json: string;
  eligible_connection_ids_json: string;
  eligible_capabilities_json: string;
  eligible_connection_capabilities_json: string;
  trigger_policy_json: string;
  routing_policy_version: string;
  prompt_version: string;
  tool_surface_hash: string;
  limits_json: string;
  scope_hash: string;
  memory_context_hash: string | null;
  created_at: number;
}

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
   * The third statement of that batch wrote `workstreams.harness_status`, and
   * that write is still made — by `markWorkstreamRunning`, from the claimed row
   * this transaction is already holding rather than from a `WHERE EXISTS` that
   * re-derives the claim. The endpoint runs the whole operation inside
   * `commitRuntimeMutation`, so the sidebar's projection commits with the claim
   * instead of as a follow-up that could be lost.
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
      if (!claimed) return { outcome: "not_found" as const };
      if (claimed.legacy_attempt_id !== input.attemptId
        || claimed.lease_owner !== input.owner
        || claimed.lease_expires_at !== expiresAt) {
        // The update matched nothing. Why is a question the object can answer
        // from the row it is already holding, rather than the second statement
        // and correlated subquery the routed version needed.
        if (TERMINAL_RUN_STATUSES.has(claimed.status)) {
          return { outcome: "terminal" as const, status: claimed.status };
        }
        if (claimed.cancellation_requested_at !== null) return { outcome: "cancelled" as const };
        return {
          outcome: "busy" as const,
          activeLeaseExpiresAt: this.activeLeaseExpiresAt(input.runId, claimed.origin),
        };
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
      if (claimed.origin !== "block_dashboard_block") this.markWorkstreamRunning(input.now);
      return {
        outcome: "claimed" as const,
        attemptEpoch: claimed.attempt_epoch,
        leaseExpiresAt: expiresAt,
        startedAt: claimed.started_at,
      };
    });
  }

  /**
   * The work stream is busy, which is what the sidebar renders.
   *
   * The claim batch's third statement, in the object's own vocabulary. It stays
   * a *guard* rather than an assignment: `exact_state` distinguishes states the
   * retired view flattened to one `running`, and a claim must not demote an
   * `interrupting` work stream to plain `running` — the retired trigger did not
   * either, because it compared the view's projection on both sides before
   * writing. A HyperSight block never reaches here: those runs are beside the
   * work stream rather than holding it.
   */
  private markWorkstreamRunning(now: number): void {
    this.sql.exec(
      `UPDATE workstream
          SET state_reason_code = CASE WHEN exact_state IN
                ('running', 'interrupting', 'preparing_context', 'waiting_capacity')
                THEN state_reason_code ELSE 'runtime_running' END,
              state_changed_at = CASE WHEN exact_state IN
                ('running', 'interrupting', 'preparing_context', 'waiting_capacity')
                THEN state_changed_at ELSE ? END,
              exact_state = CASE WHEN exact_state IN
                ('running', 'interrupting', 'preparing_context', 'waiting_capacity')
                THEN exact_state ELSE 'running' END,
              last_people_activity_at = ?,
              updated_at = ?
        WHERE id = 1`,
      now,
      now,
      now,
    );
  }

  /**
   * When the run holding this work stream will let go, if one is.
   *
   * A HyperSight block is never blocked by an interactive run and vice versa,
   * so the question is asked against the same origin rule the claim itself
   * uses. Null means nothing live is holding it, which — after a refused claim
   * — means the refusal was about this run rather than about the work stream.
   */
  private activeLeaseExpiresAt(runId: string, origin: string): number | null {
    const row = first(this.sql.exec<{ lease_expires_at: number | null } & Record<string, SqlStorageValue>>(
      `SELECT MAX(lease_expires_at) AS lease_expires_at FROM runs
        WHERE run_id != ?
          AND (? = 'block_dashboard_block' OR origin != 'block_dashboard_block')
          AND parent_tool_call_id IS NULL
          AND status = 'running' AND terminalized_at IS NULL`,
      runId,
      origin,
    ));
    return row?.lease_expires_at ?? null;
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
   * Freeze this attempt's scope, or say why the frozen one is not it.
   *
   * The routed version was the plainest example of the fence being a join:
   * `INSERT INTO harness_run_scopes … SELECT … FROM harness_runs WHERE
   * lease_owner = ?`, so a row was written only if the writer still held the
   * run — and a zero-change result meant either "already frozen by this same
   * attempt" or "lost the run", which took a second statement to tell apart.
   * Here the fence is read, the existing row is read, and the answer names
   * which of the three it is.
   *
   * `mismatch` is not an ownership problem and must not be retried as one: it
   * means this run already has a *different* frozen scope, which is a defect in
   * the caller rather than a race.
   */
  persistScope(input: AttemptFence & {
    scopeHash: string;
    executionPrincipalJson: string;
    eligibleConnectionIdsJson: string;
    eligibleCapabilitiesJson: string;
    eligibleConnectionCapabilitiesJson: string;
    triggerPolicyJson: string;
    routingPolicyVersion: string;
    promptVersion: string;
    toolSurfaceHash: string;
    memoryContextHash: string | null;
    limitsJson: string;
  }): FencedWriteOutcome {
    return this.storage.transactionSync(() => {
      const existing = first(this.sql.exec<{ attempt_id: string; scope_hash: string } & Record<string, SqlStorageValue>>(
        `SELECT attempt_id, scope_hash FROM run_scopes WHERE run_id = ?`,
        input.runId,
      ));
      if (existing) {
        return existing.attempt_id === input.attemptId && existing.scope_hash === input.scopeHash
          ? { outcome: "reused" as const }
          : { outcome: "mismatch" as const };
      }
      if (this.attemptOwnership(input).outcome !== "owned") {
        return { outcome: "ownership_lost" as const };
      }
      this.sql.exec(
        `INSERT INTO run_scopes
           (run_id, attempt_id, execution_principal_json, eligible_connection_ids_json,
            eligible_capabilities_json, eligible_connection_capabilities_json,
            trigger_policy_json, routing_policy_version, prompt_version, tool_surface_hash,
            limits_json, scope_hash, memory_context_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.runId,
        input.attemptId,
        input.executionPrincipalJson,
        input.eligibleConnectionIdsJson,
        input.eligibleCapabilitiesJson,
        input.eligibleConnectionCapabilitiesJson,
        input.triggerPolicyJson,
        input.routingPolicyVersion,
        input.promptVersion,
        input.toolSurfaceHash,
        input.limitsJson,
        input.scopeHash,
        input.memoryContextHash,
        input.now,
      );
      return { outcome: "persisted" as const };
    });
  }

  /**
   * Record that this attempt activated a plugin inside its frozen scope.
   *
   * `persistScope`'s shape on a different table, and for the same reason: the
   * routed version fenced the insert by selecting from `harness_runs`, then
   * re-read the row to tell a replay from a lost run. An activation is
   * immutable per `(run, plugin)` — a second one with a different tool surface
   * means the surface changed under a frozen scope, which the caller must not
   * paper over.
   */
  persistPluginActivation(input: AttemptFence & {
    pluginId: string;
    toolSurfaceHash: string;
  }): FencedWriteOutcome {
    return this.storage.transactionSync(() => {
      const existing = first(this.sql.exec<{ attempt_id: string; tool_surface_hash: string } & Record<string, SqlStorageValue>>(
        `SELECT attempt_id, tool_surface_hash FROM run_plugin_activations
          WHERE run_id = ? AND plugin_id = ?`,
        input.runId,
        input.pluginId,
      ));
      if (existing) {
        return existing.attempt_id === input.attemptId
          && existing.tool_surface_hash === input.toolSurfaceHash
          ? { outcome: "reused" as const }
          : { outcome: "mismatch" as const };
      }
      if (this.attemptOwnership(input).outcome !== "owned") {
        return { outcome: "ownership_lost" as const };
      }
      this.sql.exec(
        `INSERT INTO run_plugin_activations
           (run_id, attempt_id, plugin_id, tool_surface_hash, authorized_at, activated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        input.runId,
        input.attemptId,
        input.pluginId,
        input.toolSurfaceHash,
        input.now,
        input.now,
      );
      return { outcome: "persisted" as const };
    });
  }

  /** One run's frozen scope, or nothing. */
  scope(input: { runId: string }): ScopeRow | undefined {
    return first(this.sql.exec<ScopeRow>(
      `SELECT run_id, attempt_id, execution_principal_json, eligible_connection_ids_json,
              eligible_capabilities_json, eligible_connection_capabilities_json,
              trigger_policy_json, routing_policy_version, prompt_version, tool_surface_hash,
              limits_json, scope_hash, memory_context_hash, created_at
         FROM run_scopes WHERE run_id = ?`,
      input.runId,
    ));
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
