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

/**
 * Whether a sub-agent may start, resume, replay, or must be told no.
 *
 * Eight states, because the routed version computed exactly these across six
 * statements and two diagnostic reads: an `INSERT … SELECT` carrying three
 * capacity subqueries in its `WHERE`, a lifecycle insert re-stating the fence,
 * a read-back, a reclaim `UPDATE` with a fourth capacity subquery, and a second
 * diagnostic read repeating all of them to work out which policy had refused.
 * A count of changed rows cannot say "the chain budget is spent" or "someone
 * else is already running this tool call"; these names can.
 */
export type InlineChildAdmissionOutcome =
  | {
      outcome: "claimed";
      childRunId: string;
      attemptId: string;
      owner: string;
      attemptEpoch: number;
      leaseExpiresAt: number;
      chainRootRunId: string;
      chainDepth: number;
      /** True when this resumed an existing attempt rather than starting one. */
      reused: boolean;
    }
  /** Already finished. Its stored result is the tool's answer. */
  | {
      outcome: "replay";
      childRunId: string;
      childResultJson: string | null;
      childResultHash: string | null;
    }
  /** A live executor holds this same tool call's child. */
  | { outcome: "busy"; childRunId: string; leaseExpiresAt: number | null }
  /** The same tool call was admitted for a different objective. */
  | { outcome: "objective_mismatch"; childRunId: string }
  | { outcome: "cancelled" }
  | {
      outcome: "refused";
      reason: "depth_limit" | "chain_budget_exhausted" | "child_capacity";
    }
  /** The parent has no frozen scope, so there is nothing to narrow from. */
  | { outcome: "parent_scope_missing" }
  | { outcome: "ownership_lost" };

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
  chain_depth: number;
  delegated_task_hash: string | null;
  child_result_json: string | null;
  child_result_hash: string | null;
}

const RUN_COLUMNS = `run_id, status, origin, parent_run_id, parent_tool_call_id,
  legacy_attempt_id, attempt_epoch, lease_owner, lease_expires_at,
  cancellation_requested_at, cancellation_reason, terminalized_at, started_at,
  completed_at, final_part_id, error_json, workflow_instance_id, chain_root_run_id,
  chain_depth, delegated_task_hash, child_result_json, child_result_hash`;

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
   * Record one inference attempt against a run.
   *
   * The only write in this family with no lease fence, and deliberately so: an
   * attempt row is telemetry about a provider call that already happened, and
   * losing it because the lease lapsed mid-call would delete the record of
   * exactly the failure worth knowing about. `INSERT OR IGNORE` on the id keeps
   * a retry idempotent.
   */
  recordInferenceAttempt(input: {
    inferenceAttemptId: string;
    runId: string;
    attemptId: string;
    turnId: string;
    endpointAttempt: number;
    fallbackAttempt: number;
    provider: string;
    model: string;
    credentialSourceHash: string | null;
    workspaceIdentityHash: string;
    routingDecisionJson: string;
    outcome: string;
    failureClassification: string | null;
    latencyMs: number | null;
    ttftMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    cachedTokens: number | null;
    costMicros: number | null;
    responseBytes: number | null;
    startedAt: number;
    completedAt: number;
    now: number;
  }): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO inference_attempts
         (inference_attempt_id, run_id, attempt_id, turn_id, endpoint_attempt,
          fallback_attempt, provider, model, credential_source_hash,
          workspace_identity_hash, routing_decision_json, outcome, failure_classification,
          latency_ms, ttft_ms, input_tokens, output_tokens, reasoning_tokens,
          cached_tokens, cost_micros, response_bytes, started_at, completed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.inferenceAttemptId,
      input.runId,
      input.attemptId,
      input.turnId,
      input.endpointAttempt,
      input.fallbackAttempt,
      input.provider,
      input.model,
      input.credentialSourceHash,
      input.workspaceIdentityHash,
      input.routingDecisionJson,
      input.outcome,
      input.failureClassification,
      input.latencyMs,
      input.ttftMs,
      input.inputTokens,
      input.outputTokens,
      input.reasoningTokens,
      input.cachedTokens,
      input.costMicros,
      input.responseBytes,
      input.startedAt,
      input.completedAt,
      input.now,
    );
  }

  /**
   * Admit, resume or refuse a sub-agent for one of the parent's tool calls.
   *
   * The largest statement the compat layer routed, and the clearest case for
   * this whole conversion: the routed version put three capacity subqueries
   * inside an `INSERT … SELECT`'s `WHERE`, so a refusal came back as zero rows
   * and needed a second read — repeating all three subqueries — to say *which*
   * policy had refused. Inside one transaction the policies are read first and
   * the write follows, so each refusal names itself.
   *
   * The `(parent run, tool call)` pair is the idempotency key: the model
   * retrying the same `run_subagent` call must reach the same child, which is
   * why a replay and a busy child are outcomes rather than errors.
   *
   * **`activeChildren` counts this work stream's children, not the workspace's.**
   * The routed predicate read `active_child.workspace_id = parent.workspace_id`,
   * but it ran against `_runtime_harness_runs`, a view of this object's rows
   * alone — so the comparison was true for every row it could see and the cap
   * has been per-work-stream since the per-workspace-database cutover. This
   * counts what that predicate actually counted; the name it is configured
   * under, `HARNESS_CHILD_MAX_ACTIVE_WORKSPACE_RUNS`, still says otherwise.
   */
  admitInlineChild(input: {
    parentRunId: string;
    parentAttemptId: string;
    parentOwner: string;
    parentToolCallId: string;
    childRunId: string;
    childAttemptId: string;
    childOwner: string;
    objectiveHash: string;
    leaseSeconds: number;
    maxDepth: number;
    maxChainRuns: number;
    maxActiveChildren: number;
    lifecycleEventId: string;
    now: number;
  }): InlineChildAdmissionOutcome {
    return this.storage.transactionSync(() => {
      const parent = this.run({ runId: input.parentRunId });
      if (!parent
        || parent.legacy_attempt_id !== input.parentAttemptId
        || parent.lease_owner !== input.parentOwner
        || parent.status !== "running"
        || parent.terminalized_at !== null
        || parent.cancellation_requested_at !== null
        || parent.lease_expires_at === null
        || parent.lease_expires_at <= input.now) {
        return { outcome: "ownership_lost" as const };
      }
      if (!this.scope({ runId: input.parentRunId })) {
        return { outcome: "parent_scope_missing" as const };
      }

      const existing = first(this.sql.exec<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM runs
          WHERE parent_run_id = ? AND parent_tool_call_id = ?`,
        input.parentRunId,
        input.parentToolCallId,
      ));
      const expiresAt = input.now + input.leaseSeconds * 1_000;

      if (existing) {
        if (existing.delegated_task_hash !== input.objectiveHash) {
          return { outcome: "objective_mismatch" as const, childRunId: existing.run_id };
        }
        if (existing.terminalized_at !== null || TERMINAL_RUN_STATUSES.has(existing.status)) {
          return {
            outcome: "replay" as const,
            childRunId: existing.run_id,
            childResultJson: existing.child_result_json,
            childResultHash: existing.child_result_hash,
          };
        }
        if (existing.cancellation_requested_at !== null) return { outcome: "cancelled" as const };
        if (existing.lease_expires_at !== null && existing.lease_expires_at > input.now) {
          return {
            outcome: "busy" as const,
            childRunId: existing.run_id,
            leaseExpiresAt: existing.lease_expires_at,
          };
        }
        if (existing.status !== "running"
          || existing.legacy_attempt_id === null
          || existing.lease_owner === null) {
          return { outcome: "ownership_lost" as const };
        }
        if (this.activeInlineChildren(existing.run_id, input.now) >= input.maxActiveChildren) {
          return { outcome: "refused" as const, reason: "child_capacity" as const };
        }
        // Resume the same durable attempt after its lease expires. Keeping the
        // attempt id keeps its frozen scope and its tool receipts valid; the
        // fresh owner is what fences the executor that lost the lease.
        this.sql.exec(
          `UPDATE runs
              SET heartbeat_at = ?2, lease_expires_at = ?3, lease_owner = ?4,
                  attempt_epoch = attempt_epoch + 1, updated_at = ?2
            WHERE run_id = ?1`,
          existing.run_id,
          input.now,
          expiresAt,
          input.childOwner,
        );
        return {
          outcome: "claimed" as const,
          childRunId: existing.run_id,
          attemptId: existing.legacy_attempt_id,
          owner: input.childOwner,
          attemptEpoch: existing.attempt_epoch + 1,
          leaseExpiresAt: expiresAt,
          chainRootRunId: existing.chain_root_run_id ?? existing.run_id,
          chainDepth: Number(existing.chain_depth),
          reused: true,
        };
      }

      const chainRootRunId = parent.chain_root_run_id ?? parent.run_id;
      const chainDepth = Number(parent.chain_depth) + 1;
      if (chainDepth > input.maxDepth) {
        return { outcome: "refused" as const, reason: "depth_limit" as const };
      }
      const chainRuns = Number(first(this.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
        `SELECT COUNT(*) AS count FROM runs
          WHERE run_id = ?1
             OR (chain_root_run_id = ?1 AND parent_tool_call_id IS NOT NULL)`,
        chainRootRunId,
      ))?.count ?? 0);
      if (chainRuns >= input.maxChainRuns) {
        return { outcome: "refused" as const, reason: "chain_budget_exhausted" as const };
      }
      if (this.activeInlineChildren(null, input.now) >= input.maxActiveChildren) {
        return { outcome: "refused" as const, reason: "child_capacity" as const };
      }

      // A delegated child owns its own substream. Sharing the parent's would
      // violate `runs_mutating_substream_uq`, which allows one mutating run per
      // substream — the child would be a UNIQUE failure rather than a sub-agent.
      const substreamId = `run:${input.childRunId}`;
      this.sql.exec(
        `INSERT OR IGNORE INTO substreams
           (id, kind, inherit_mode, inherit_from_substream_id, inherit_fence_seq, depth,
            return_mode, origin_part_id, owner_user_id, audience, tool_policy, status, created_at)
         VALUES (?, 'agent', 'fork', '0', 0, ?, 'tool_result', NULL, NULL, 'system',
                 'read_only', 'open', ?)`,
        substreamId,
        Math.min(4, chainDepth),
        input.now,
      );
      this.sql.exec(
        `INSERT INTO runs
           (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
            next_action_cursor, input_fence_seq, revision, started_at,
            active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
            tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
            origin, execution_principal_json, parent_run_id, parent_tool_call_id,
            chain_root_run_id, chain_depth, legacy_attempt_id, lease_owner,
            lease_expires_at, heartbeat_at, delegated_task_hash, inherited_scope_hash,
            created_at, updated_at)
         SELECT ?1, ?2, 'running', '{}', 1, 0, '', 0, 0, ?8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                'sub_agent', parent.execution_principal_json, ?3, ?4, ?5, ?6, ?7, ?9,
                ?10, ?8, ?11, parent_scope.scope_hash, ?8, ?8
           FROM runs parent
           JOIN run_scopes parent_scope ON parent_scope.run_id = parent.run_id
          WHERE parent.run_id = ?3`,
        input.childRunId,
        substreamId,
        input.parentRunId,
        input.parentToolCallId,
        chainRootRunId,
        chainDepth,
        input.childAttemptId,
        input.now,
        input.childOwner,
        expiresAt,
        input.objectiveHash,
      );
      this.recordLifecycleEvent({
        eventId: input.lifecycleEventId,
        runId: input.childRunId,
        attemptId: input.childAttemptId,
        eventKey: "admitted",
        eventType: "child_admitted",
        status: "running",
        memberSafePayloadJson: JSON.stringify({
          parentHarnessRunId: input.parentRunId,
          chainDepth,
        }),
        now: input.now,
      });
      return {
        outcome: "claimed" as const,
        childRunId: input.childRunId,
        attemptId: input.childAttemptId,
        owner: input.childOwner,
        attemptEpoch: 1,
        leaseExpiresAt: expiresAt,
        chainRootRunId,
        chainDepth,
        reused: false,
      };
    });
  }

  /**
   * How many delegated children are running right now, excluding one.
   *
   * See `admitInlineChild`: this is the work stream's count, which is what the
   * routed `active_child.workspace_id = parent.workspace_id` predicate actually
   * counted once `harness_runs` became object-local.
   */
  private activeInlineChildren(exceptRunId: string | null, now: number): number {
    return Number(first(this.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count FROM runs
        WHERE parent_tool_call_id IS NOT NULL
          AND (?1 IS NULL OR run_id != ?1)
          AND status = 'running'
          AND terminalized_at IS NULL
          AND lease_expires_at > ?2`,
      exceptRunId,
      now,
    ))?.count ?? 0);
  }

  /**
   * Whether a sub-agent's attempt may still write, fenced by its parent too.
   *
   * The routed version was a self-join on `harness_runs` with eight bound
   * parameters and two `lease_expires_at > now` predicates — the double fence
   * that stops a child from outliving the parent that delegated to it. Both
   * rows are this object's, so the join is two reads.
   *
   * The precedence is the routed statement's and is load-bearing: a lease that
   * has been lost or a link that does not hold answers `ownership_lost` even if
   * the other side was also cancelled, because a caller that no longer owns the
   * run must not report a cancellation as though it had observed one. Only once
   * both leases are good does a stop on either side answer `cancelled`.
   */
  inlineChildOwnership(input: {
    parentRunId: string;
    parentAttemptId: string;
    parentOwner: string;
    childRunId: string;
    childAttemptId: string;
    childOwner: string;
    now: number;
  }): AttemptOutcome {
    const child = this.run({ runId: input.childRunId });
    const parent = this.run({ runId: input.parentRunId });
    if (!child
      || !parent
      || child.parent_run_id !== input.parentRunId
      || child.parent_tool_call_id === null) {
      return { outcome: "ownership_lost" };
    }
    const held = (
      row: RunRow,
      attemptId: string,
      owner: string,
    ): boolean => row.legacy_attempt_id === attemptId
      && row.lease_owner === owner
      && row.terminalized_at === null
      && row.lease_expires_at !== null
      && row.lease_expires_at > input.now;
    if (!held(child, input.childAttemptId, input.childOwner)
      || !held(parent, input.parentAttemptId, input.parentOwner)) {
      return { outcome: "ownership_lost" };
    }
    if (child.status === "cancelled"
      || child.cancellation_requested_at !== null
      || parent.status === "cancelled"
      || parent.cancellation_requested_at !== null) {
      return { outcome: "cancelled" };
    }
    if (child.status !== "running" || parent.status !== "running") {
      return { outcome: "ownership_lost" };
    }
    return { outcome: "owned" };
  }

  /**
   * Push a sub-agent's lease forward, fenced by its parent's lease too.
   *
   * `heartbeatAttempt`'s three-round-trip problem with the double fence on top:
   * the routed version ran a guarded `UPDATE` whose `WHERE` carried an `EXISTS`
   * over the parent, then — on zero changes — a `LEFT JOIN` read to tell a
   * cancelled run from a lost lease, then a third read for the deadline it had
   * just written itself. The fence and the write are the same transaction here,
   * so the deadline is the one this call chose.
   */
  heartbeatInlineChild(input: {
    parentRunId: string;
    parentAttemptId: string;
    parentOwner: string;
    childRunId: string;
    childAttemptId: string;
    childOwner: string;
    leaseSeconds: number;
    now: number;
  }): HeartbeatOutcome {
    return this.storage.transactionSync(() => {
      const owned = this.inlineChildOwnership(input);
      if (owned.outcome !== "owned") return { outcome: owned.outcome };
      const expiresAt = input.now + input.leaseSeconds * 1_000;
      this.sql.exec(
        `UPDATE runs SET heartbeat_at = ?2, lease_expires_at = ?3, updated_at = ?2
          WHERE run_id = ?1`,
        input.childRunId,
        input.now,
        expiresAt,
      );
      return { outcome: "renewed" as const, leaseExpiresAt: expiresAt };
    });
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
