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

import type { SidekickRunUsage } from "@rally/contracts";
import { boundParameterChunks } from "./bound-parameters";
import {
  type PreparedConversationTurn,
  type PreparedParticipantMessage,
  WorkstreamTranscriptStorage,
  UnsettledToolBatchError,
} from "./workstream-transcript-storage";
import { WorkstreamMessageStorage } from "./workstream-message-storage";
import { enqueueSemanticRealtimeReference } from "./workstream-semantic-realtime-outbox";

/** What a caller proved before it was allowed to write. */
export interface AttemptFence {
  runId: string;
  attemptId: string;
  owner: string;
  /** The instant the caller is asking about; a lease is live relative to it. */
  now: number;
}

/** The persistent-loop writer whose subordinate receipt is being closed. */
export interface TerminalLoopExecutionFence {
  loopId: string;
  executionId: string;
  executionEpoch: number;
  leaseOwner: string;
}

interface TerminalCommitInput {
  runId: string;
  attemptId: string | null;
  claimAttempt: boolean;
  status: TerminalRunStatus;
  finalTurnId: string | null;
  model: string | null;
  usageJson: string | null;
  errorJson: string | null;
  memberSafePayloadJson: string;
  lifecycleEventId: string;
  terminalizedAt: number;
  activityStoppedAt: number;
  descendantReason: string;
  stateReasonCode?: string;
}

export interface PublishHostOutcomeInput extends AttemptFence {
  finalTurn: { turnId: string; text: string } | null;
  participantNotice: { turnId: string; text: string } | null;
  hostOutcomeStatus: "completed" | "needs_input" | "failed" | "stopped";
  hostOutcomeError: { code: string; message: string } | null;
  lifecycleEventId: string;
  /** A stopped run may still publish: the member asked it to stop, not to vanish. */
  allowCancellationRequested: boolean;
}

interface PreparedHostOutcome {
  finalTurn: PreparedParticipantMessage | null;
  participantNotice: PreparedConversationTurn | null;
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

/**
 * The statuses a run does not come back from, in the object's vocabulary.
 *
 * Exported because the runtime has its own set spelled in the *published*
 * vocabulary, where this `cancelled` is `stopped`. A caller reading a `RunRow`
 * is reading the object's words and must compare against these.
 */
export type TerminalRunStatus = "completed" | "needs_input" | "failed" | "cancelled";
export type AdmittedRunStatus = "admitted" | "running";
export type PersistedRunStatus = AdmittedRunStatus | TerminalRunStatus;

export const TERMINAL_RUN_STATUSES = new Set<string>([
  "completed",
  "needs_input",
  "failed",
  "cancelled",
]);

function assertTerminalRunStatus(status: string): asserts status is TerminalRunStatus {
  if (!TERMINAL_RUN_STATUSES.has(status)) throw new Error("terminal_run_status_invalid");
}

function assertAdmittedRunStatus(status: string): asserts status is AdmittedRunStatus {
  if (status !== "admitted" && status !== "running") throw new Error("admitted_run_status_invalid");
}

function assertPersistedRunStatus(status: string): asserts status is PersistedRunStatus {
  if (status !== "admitted" && status !== "running" && !TERMINAL_RUN_STATUSES.has(status)) {
    throw new Error("persisted_run_status_invalid");
  }
}

/**
 * What a write fenced by the attempt's lease did.
 *
 * Every one of these writes was a routed `INSERT … SELECT … FROM harness_runs
 * WHERE lease_owner = ?` followed by a diagnostic read, because the insert's
 * own `meta.changes` could not distinguish "already written by me" from "I no
 * longer hold the run". These three states are that distinction, made once.
 */
export type FencedWriteOutcome =
  | { outcome: "persisted" }
  /**
   * The run already carries this row, so the write is a no-op.
   *
   * Deliberately not conditioned on the incoming value matching the stored one.
   * These rows are written once at admission and read back afterwards; a later
   * attempt of the same run recomputes what it would have written from the code
   * it is running, which is not the same thing as the run's recorded state. See
   * `persistScope`.
   */
  | { outcome: "reused" }
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
 * How a root run's terminalization landed, and what the caller must still do.
 *
 * The routed version was a four-statement batch — the lifecycle event, the run,
 * the work stream's sidebar state, and the descendant sweep — where the last two
 * re-derived the second through `EXISTS (… terminalized_at = ?)` because a batch
 * cannot ask whether its own earlier statement landed. All four are one
 * transaction here.
 *
 * `already_terminal` carries the stored terminal state, because the caller's
 * next step depends on it: a stopped run whose residual receipts were never
 * reconciled must finish that work, and the receipts live in a different
 * authority, so it cannot happen inside this transaction.
 */
export type TerminalizeOutcome =
  | { outcome: "terminalized" }
  | {
      outcome: "already_terminal";
      status: string;
      terminalizedAt: number;
      errorJson: string | null;
      memberSafePayloadJson: string;
      /** Whether the residual-receipt marker for this attempt is already written. */
      receiptsReconciled: boolean;
    }
  | { outcome: "ownership_lost" }
  | { outcome: "not_found" };

/** One run the reaper found terminal but never receipt-reconciled. */
const BUSY_RUN_STATUSES = `('running')`;
const OPEN_RUN_STATUSES = `('admitted', 'running')`;

export interface ResidualRepairRow extends Record<string, SqlStorageValue> {
  run_id: string;
  attempt_id: string;
  origin: string;
  status: string;
  terminalized_at: number;
  error_json: string | null;
  parent_tool_call_id: string | null;
  member_safe_payload_json: string;
}

/** One run whose lease ran out while it was still claimed. */
export interface StaleRunRow extends Record<string, SqlStorageValue> {
  run_id: string;
  attempt_id: string;
  lease_owner: string;
  lease_expires_at: number;
  origin: string;
  parent_run_id: string | null;
  parent_tool_call_id: string | null;
  cancellation_requested_at: number | null;
}

/** Whether a new run was created, or the reason it was not. */
export type AdmitRunOutcome =
  | { outcome: "admitted" }
  /** A newer run has taken the work stream since the caller last looked. */
  | { outcome: "stale" }
  /** This exact run id is already here. Creation is idempotent by id. */
  | { outcome: "exists" };

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
  final_turn_id: string | null;
  error_json: string | null;
  workflow_instance_id: string | null;
  substream_loop_id: string | null;
  chain_root_run_id: string | null;
  chain_depth: number;
  delegated_task_hash: string | null;
  inherited_scope_hash: string | null;
  child_result_json: string | null;
  child_result_hash: string | null;
  execution_principal_json: string;
  trigger_part_id: string | null;
  model: string | null;
  usage_json: string | null;
  created_at: number;
}

/** The terminal run facts needed by product telemetry, in object vocabulary. */
export interface RunOutcomeTelemetryRow extends Record<string, SqlStorageValue> {
  status: string;
  started_at: number;
  completed_at: number | null;
  created_at: number;
  origin: string;
  execution_principal_json: string;
  model: string | null;
  usage_json: string | null;
  first_inference_started_at: number | null;
  first_ttft_ms: number | null;
  turn_count: number;
  tool_call_count: number;
  write_tool_call_count: number;
  fallback_used: number;
}

/** One settled tool receipt joined to the run authority that admitted it. */
export interface ToolTerminalTelemetryRow extends Record<string, SqlStorageValue> {
  effect_intent_id: string;
  run_id: string;
  status: string;
  started_at: number | null;
  settled_at: number | null;
  error_json: string | null;
  execution_plan_json: string | null;
  origin: string;
  parent_tool_call_id: string | null;
  execution_principal_json: string;
}

export interface RecoverableAttempt {
  runId: string;
  attemptId: string;
}

export const PREVIOUS_INSTANCE_RECOVERY_OWNER_PREFIX =
  "substream-agent:previous-instance-recovery-pending:";

export function previousInstanceRecoveryOwner(attemptId: string): string {
  return `${PREVIOUS_INSTANCE_RECOVERY_OWNER_PREFIX}${attemptId}`;
}

const RUN_COLUMNS = `run_id, status, origin, parent_run_id, parent_tool_call_id,
  legacy_attempt_id, attempt_epoch, lease_owner, lease_expires_at,
  cancellation_requested_at, cancellation_reason, terminalized_at, started_at,
  completed_at, final_turn_id, error_json, workflow_instance_id, substream_loop_id,
  chain_root_run_id,
  chain_depth, delegated_task_hash, inherited_scope_hash, child_result_json,
  child_result_hash, execution_principal_json, trigger_part_id, model, usage_json, created_at`;

function first<T>(cursor: SqlStorageCursor<T extends Record<string, SqlStorageValue> ? T : never>) {
  return cursor.toArray()[0];
}

/**
 * Give a replacement AgentLoopDO the attempts its predecessor owned.
 *
 * Cloudflare may stop an object while an external await is in flight. The
 * await may still return, but the next storage operation is rejected because
 * the old instance no longer owns the object. When the constructor runs
 * again, any still-live local-agent lease belongs to an executor that cannot
 * write again. Replacing its owner with a durable recovery marker and expiring
 * it here lets the replacement reclaim the same attempt immediately,
 * preserving its frozen scope and tool receipts rather than waiting five
 * minutes. A second replacement recognizes that marker even though the lease
 * is expired, so repeated evictions cannot turn recovery into a stale-run
 * failure. A lease already expired without the marker remains the stale-run
 * reaper's authority and is not resumed.
 *
 * Descendants of a local root are included so the resumed parent can reclaim
 * the same child attempt when it reaches that tool call.
 */
export function expireLocalAttemptLeasesFromPreviousInstance(
  storage: DurableObjectStorage,
  now: number,
): RecoverableAttempt[] {
  return storage.transactionSync(() => {
    const roots = storage.sql.exec<{
      run_id: string;
      attempt_id: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT run_id, legacy_attempt_id AS attempt_id
         FROM runs
        WHERE parent_tool_call_id IS NULL
          AND terminalized_at IS NULL
          AND legacy_attempt_id IS NOT NULL
          AND lease_owner IS NOT NULL
          AND (
            lease_expires_at > ?1
            OR lease_owner = ?2 || legacy_attempt_id
          )`,
      now,
      PREVIOUS_INSTANCE_RECOVERY_OWNER_PREFIX,
    ).toArray();
    if (roots.length === 0) return [];
    storage.sql.exec(
      `UPDATE runs
          SET lease_owner = ?2 || legacy_attempt_id,
              lease_expires_at = ?1,
              updated_at = ?1
        WHERE terminalized_at IS NULL
          AND legacy_attempt_id IS NOT NULL
          AND lease_owner IS NOT NULL
          AND lease_expires_at IS NOT NULL
          AND (
            run_id IN (
              SELECT run_id FROM runs
               WHERE parent_tool_call_id IS NULL
                 AND terminalized_at IS NULL
                 AND legacy_attempt_id IS NOT NULL
                 AND lease_owner IS NOT NULL
                 AND (
                   lease_expires_at > ?1
                   OR lease_owner = ?2 || legacy_attempt_id
                 )
            )
            OR chain_root_run_id IN (
              SELECT run_id FROM runs
               WHERE parent_tool_call_id IS NULL
                 AND terminalized_at IS NULL
                 AND legacy_attempt_id IS NOT NULL
                 AND lease_owner IS NOT NULL
                 AND (
                   lease_expires_at > ?1
                   OR lease_owner = ?2 || legacy_attempt_id
                 )
            )
          )`,
      now,
      PREVIOUS_INSTANCE_RECOVERY_OWNER_PREFIX,
    );
    return roots.map((row) => ({ runId: row.run_id, attemptId: row.attempt_id }));
  });
}

/**
 * The run's token and cost columns, derived from `usage_json` in the same
 * statement that writes it, so they cannot disagree with it.
 *
 * The mid-run flush spells the totals `inputTokens`, `outputTokens`,
 * `costCents`; the run's end spells them `prompt_tokens`, `completion_tokens`,
 * `cost_cents`. Both are read. A cent is 10,000 micro-dollars. A missing key
 * keeps the column's value. `usageExpression` is code-owned SQL, never a
 * caller's value.
 */
function usageCounterAssignments(usageExpression: string): string {
  const counter = (column: string, paths: readonly [string, string], scale: number) => {
    const value = paths.map((path) => `json_extract(${usageExpression}, '${path}')`).join(", ");
    return `${column} = MAX(0, COALESCE(CAST(ROUND(COALESCE(${value}) * ${scale}) AS INTEGER), ${column}))`;
  };
  return [
    counter("input_tokens", ["$.prompt_tokens", "$.inputTokens"], 1),
    counter("output_tokens", ["$.completion_tokens", "$.outputTokens"], 1),
    counter("cost_micros", ["$.cost_cents", "$.costCents"], 10_000),
  ].join(",\n                ");
}

/** A conversation's model calls, as the provider counted them. */
export type ModelUsage = SidekickRunUsage["model"];

export class WorkstreamHarnessRunStorage {
  /**
   * The ordered transcript authority, over this same object storage.
   *
   * Composed rather than reimplemented, because publishing a run's final
   * message is one transaction that has to touch two authorities' tables. The
   * decision is this one's — whether the attempt may still speak — and the
   * assistant turn belongs to the transcript class. Both wrap the same
   * `DurableObjectStorage`, so the
   * nested `transactionSync` is the same transaction rather than a second one.
   */
  private readonly transcript: WorkstreamTranscriptStorage;

  constructor(private readonly storage: DurableObjectStorage) {
    this.transcript = new WorkstreamTranscriptStorage(storage);
  }

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  /**
   * What this conversation's model calls cost, from the provider's own counts
   * on each attempt. A call is a successful attempt; the others were retried
   * or fell back. Input tokens are the whole conversation each call sent, so
   * the first and last show how far the context grew.
   */
  modelUsage(): ModelUsage {
    const totals = this.sql.exec<{ calls: number; failed: number; input: number | null; output: number | null;
      cached: number | null; cost: number | null; ms: number | null; max_input: number | null } & Record<string, SqlStorageValue>>(
      `SELECT sum(outcome = 'success') AS calls, sum(outcome <> 'success') AS failed,
              sum(input_tokens) AS input, sum(output_tokens) AS output, sum(cached_tokens) AS cached,
              sum(cost_micros) AS cost, sum(latency_ms) AS ms, max(input_tokens) AS max_input
         FROM inference_attempts`,
    ).one();
    const end = (order: "ASC" | "DESC") => this.sql.exec<{ input_tokens: number | null } & Record<string, SqlStorageValue>>(
      `SELECT input_tokens FROM inference_attempts WHERE outcome = 'success'
        ORDER BY created_at ${order}, inference_attempt_id ${order} LIMIT 1`,
    ).toArray()[0]?.input_tokens ?? null;
    return { calls: totals.calls ?? 0, failedAttempts: totals.failed ?? 0, inputTokens: totals.input ?? 0,
      outputTokens: totals.output ?? 0, cachedInputTokens: totals.cached ?? 0, costUsd: (totals.cost ?? 0) / 1_000_000,
      firstCallInputTokens: end("ASC"), lastCallInputTokens: end("DESC"),
      largestCallInputTokens: totals.max_input, ms: totals.ms ?? 0 };
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
                attempt_epoch = CASE WHEN legacy_attempt_id = ?2 AND lease_owner = ?3
                  THEN attempt_epoch ELSE attempt_epoch + 1 END,
                legacy_attempt_id = ?2,
                lease_owner = ?3,
                heartbeat_at = ?5,
                lease_expires_at = ?4,
                updated_at = ?5
          WHERE run_id = ?1
            AND parent_tool_call_id IS NULL
            AND status IN ${OPEN_RUN_STATUSES}
            AND terminalized_at IS NULL
            AND cancellation_requested_at IS NULL
            AND (
              legacy_attempt_id IS NULL
              OR (legacy_attempt_id = ?2 AND lease_owner = ?3)
              OR lease_expires_at IS NULL
              OR lease_expires_at <= ?5
            )
            -- A receipt may claim a harness attempt only while no other root
            -- receipt holds a live attempt lease. The stable substream-loop
            -- lease is the lifecycle authority; this remains a subordinate
            -- provider/effect fence rather than a second loop identity.
            AND NOT EXISTS (
              SELECT 1 FROM runs active
               WHERE active.run_id != ?1
                 AND active.parent_tool_call_id IS NULL
                 AND active.status IN ${BUSY_RUN_STATUSES}
                 AND active.terminalized_at IS NULL
                 AND active.lease_expires_at > ?5
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
          activeLeaseExpiresAt: this.activeLeaseExpiresAt(),
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
      this.markWorkstreamRunning(input.now);
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
   * writing.
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
   * **The contended run is deliberately not excluded.** A duplicate dispatch of
   * a run that is already being worked on is refused by the same `busy` branch
   * as a work stream held by someone else, and in that case the live lease this
   * caller needs to wait for is *this run's own*. Excluding it returns null,
   * and both agents read null as "retry in five seconds" — so a duplicate
   * dispatch would wake and reattempt every five seconds for the whole
   * five-minute lease. The `status = 'running' AND lease_expires_at` predicates
   * already exclude a run that is not holding anything, which is why the
   * routed version this replaces had no such exclusion either.
   */
  private activeLeaseExpiresAt(): number | null {
    const row = first(this.sql.exec<{ lease_expires_at: number | null } & Record<string, SqlStorageValue>>(
      `SELECT MAX(lease_expires_at) AS lease_expires_at FROM runs
        WHERE parent_tool_call_id IS NULL
          AND status IN ${BUSY_RUN_STATUSES} AND terminalized_at IS NULL`,
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
   * Record this run's scope once, at admission. A later attempt reuses it.
   *
   * The routed version was the plainest example of the fence being a join:
   * `INSERT INTO harness_run_scopes … SELECT … FROM harness_runs WHERE
   * lease_owner = ?`, so a row was written only if the writer still held the
   * run — and a zero-change result meant either "already recorded" or "lost the
   * run", which took a second statement to tell apart. Here the fence is read,
   * the existing row is read, and the answer names which of the two it is.
   *
   * **An existing row is reused whatever the caller passes.** This used to
   * compare the incoming `scopeHash` against the stored one and answer
   * `mismatch`, which the runtime turned into a bare `immutable_run_scope_mismatch`
   * and, through the uncoded-exception path, a terminal `harness_execution_failed`
   * telling the member not to retry. The comparison was unsound, because the
   * two sides are not the same kind of value: the stored hash is what the run
   * was admitted with, while the incoming one is recomputed from whatever code
   * the *current* attempt is running. Cloudflare resets a Durable Object when
   * the Worker is deployed, so a run in flight across any deploy resumes on a
   * new bundle — and `scopeHash` mixes the deployed build (tool-surface hash,
   * prompt version, routing policy version, limits) into the authority it was
   * meant to be about. On 2026-09-02 a connector schema edit no larger than
   * adding `minLength: 1` to a Linear cursor killed a live run this way, after
   * its own recovery had already repaired it twice and was about to succeed.
   *
   * So a resumed attempt now simply restarts the loop against the recorded
   * scope. The residual is real and accepted: nothing here re-checks that a
   * later attempt's authority did not widen between attempts. Live
   * revalidation before every tool call still applies.
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
    limitsJson: string;
  }): FencedWriteOutcome {
    return this.storage.transactionSync(() => {
      // The fence comes first, and covers the reuse path as well as the insert.
      // While the old comparison stood it was doing this job by accident: a
      // stale executor carries a different `attemptId`, so it fell to
      // `mismatch` and threw. Reusing on the row alone would have answered it
      // with success and let it keep setting up against a run it no longer
      // holds. A legitimate replacement attempt has claimed the lease and
      // passes here.
      if (this.attemptOwnership(input).outcome !== "owned") {
        return { outcome: "ownership_lost" as const };
      }
      const existing = first(this.sql.exec<{ attempt_id: string } & Record<string, SqlStorageValue>>(
        `SELECT attempt_id FROM run_scopes WHERE run_id = ?`,
        input.runId,
      ));
      if (existing) return { outcome: "reused" as const };
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
        // Admission recall and its frozen hash were retired with the agent-memory
        // redesign; the column stays, always empty, until a migration drops it.
        null,
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
   * re-read the row to tell a replay from a lost run.
   *
   * An activation is recorded once per `(run, plugin)`, and a later attempt
   * reuses it. This used to answer `mismatch` when the incoming
   * `toolSurfaceHash` differed from the stored one, on the reading that the
   * surface had moved under a frozen scope. That is the same unsound
   * comparison `persistScope` carried, on the same value and with the same
   * blast radius: the stored hash belongs to the bundle the run was admitted
   * on, the incoming one to the bundle the current attempt is running, and a
   * deploy makes them differ for every in-flight run. It is a second landmine
   * on the same boundary — during the 2026-09-02 incident this threw too, and
   * fixing only `persistScope` would have moved the next deploy's failure here.
   */
  persistPluginActivation(input: AttemptFence & {
    pluginId: string;
    toolSurfaceHash: string;
  }): FencedWriteOutcome {
    return this.storage.transactionSync(() => {
      // Fenced before the reuse path, for the reason given in `persistScope`:
      // an executor that has lost its lease must not be told its activation is
      // durable and go on preparing the plugin.
      if (this.attemptOwnership(input).outcome !== "owned") {
        return { outcome: "ownership_lost" as const };
      }
      const existing = first(this.sql.exec<{ attempt_id: string } & Record<string, SqlStorageValue>>(
        `SELECT attempt_id FROM run_plugin_activations
          WHERE run_id = ? AND plugin_id = ?`,
        input.runId,
        input.pluginId,
      ));
      if (existing) return { outcome: "reused" as const };
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

  /**
   * Mark a run started, and bind the Workflow that is driving it.
   *
   * `bindWorkflowInstance` plus the transition an admitted run makes when its
   * Workflow actually begins. The sidebar promotion is narrower than
   * `markWorkstreamRunning`: it only lifts a work stream that is still showing
   * `scheduled`, because a work stream already in a more exact busy state is
   * further along than this launch knows about.
   */
  launchRun(input: {
    runId: string;
    workflowInstanceId: string;
    executionContextJson: string;
    executionAvailableAt: number;
    startedAt: number;
    now: number;
  }): { outcome: "launched" | "not_found" } {
    return this.storage.transactionSync(() => {
      const run = this.run({ runId: input.runId });
      if (!run) return { outcome: "not_found" as const };
      if (run.terminalized_at !== null) throw new Error("substream_loop_execution_receipt_terminal");
      const existing = first(this.sql.exec<{
        execution_context_json: string | null;
      } & Record<string, SqlStorageValue>>(
        `SELECT execution_context_json FROM runs WHERE run_id = ?`,
        input.runId,
      ));
      if (run.workflow_instance_id !== null && run.workflow_instance_id !== input.workflowInstanceId) {
        throw new Error("substream_loop_execution_workflow_mismatch");
      }
      if (existing?.execution_context_json !== null
        && existing?.execution_context_json !== input.executionContextJson) {
        throw new Error("substream_loop_execution_context_mismatch");
      }
      const launched = first(this.sql.exec<{ run_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE runs
            SET workflow_instance_id = ?2,
                status = CASE WHEN status = 'admitted' THEN 'running' ELSE status END,
                started_at = CASE WHEN started_at = 0 THEN ?3 ELSE started_at END,
                execution_context_json = ?4,
                execution_available_at = COALESCE(execution_available_at, ?5),
                updated_at = ?6
          WHERE run_id = ?1 AND terminalized_at IS NULL
        RETURNING run_id`,
        input.runId,
        input.workflowInstanceId,
        input.startedAt,
        input.executionContextJson,
        input.executionAvailableAt,
        input.now,
      ));
      if (launched?.run_id !== input.runId) {
        throw new Error("substream_loop_execution_receipt_changed");
      }
      this.sql.exec(
        `UPDATE workstream
            SET exact_state = 'running',
                state_reason_code = 'runtime_running',
                state_changed_at = ?1,
                updated_at = ?1
          WHERE id = 1 AND exact_state = 'scheduled'`,
        input.now,
      );
      return { outcome: "launched" as const };
    });
  }

  /**
   * Record what the model cost so far, fenced by the live attempt.
   *
   * Progress metadata, not a state transition: the host may write it while its
   * lease is live and must never write it after. The fence is the whole point,
   * and it is why this is not a plain update — a flush that arrives after the
   * attempt was taken over would overwrite its successor's numbers.
   */
  recordRunProgress(input: AttemptFence & {
    model: string | null;
    usageJson: string;
  }): { outcome: "recorded" | "ownership_lost" } {
    return this.storage.transactionSync(() => {
      const run = this.run({ runId: input.runId });
      if (!run
        || run.legacy_attempt_id !== input.attemptId
        || run.lease_owner !== input.owner
        || run.status !== "running"
        || run.terminalized_at !== null) {
        return { outcome: "ownership_lost" as const };
      }
      this.sql.exec(
        `UPDATE runs SET usage_json = ?2, model = COALESCE(?3, model), updated_at = ?4,
                ${usageCounterAssignments("?2")}
          WHERE run_id = ?1`,
        input.runId,
        input.usageJson,
        input.model,
        input.now,
      );
      return { outcome: "recorded" as const };
    });
  }

  /** The newest root run a member would recognise as "this conversation's". */
  latestRootRun(): RunRow | undefined {
    return first(this.sql.exec<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM runs
        WHERE parent_tool_call_id IS NULL
        ORDER BY created_at DESC, run_id DESC LIMIT 1`,
    ));
  }

  /** The newest still-live root receipt for one producer family. */
  latestActiveRootRun(input: { origin: string }): RunRow | undefined {
    return first(this.sql.exec<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM runs
        WHERE parent_tool_call_id IS NULL AND origin = ?
          AND status IN ('admitted', 'running') AND terminalized_at IS NULL
        ORDER BY started_at DESC, run_id DESC LIMIT 1`,
      input.origin,
    ));
  }

  /**
   * Terminal run telemetry assembled beside the rows that own every count.
   *
   * This deliberately returns storage vocabulary and unix milliseconds. The
   * retired runtime SQL path exposed a D1-shaped view, converted timestamps to
   * text, joined it back to the same object, and made telemetry depend on a
   * compatibility trigger that had nothing to do with telemetry.
   */
  runOutcomeTelemetry(input: { runId: string }): RunOutcomeTelemetryRow | undefined {
    return first(this.sql.exec<RunOutcomeTelemetryRow>(
      `SELECT CASE run.status WHEN 'cancelled' THEN 'stopped' ELSE run.status END AS status,
              run.started_at, run.completed_at, run.created_at, run.origin,
              run.execution_principal_json, run.model, run.usage_json,
              (SELECT attempt.started_at FROM inference_attempts attempt
                WHERE attempt.run_id = run.run_id AND attempt.ttft_ms IS NOT NULL
                ORDER BY attempt.started_at, attempt.inference_attempt_id LIMIT 1)
                AS first_inference_started_at,
              (SELECT attempt.ttft_ms FROM inference_attempts attempt
                WHERE attempt.run_id = run.run_id AND attempt.ttft_ms IS NOT NULL
                ORDER BY attempt.started_at, attempt.inference_attempt_id LIMIT 1)
                AS first_ttft_ms,
              (SELECT COUNT(DISTINCT attempt.turn_id) FROM inference_attempts attempt
                WHERE attempt.run_id = run.run_id AND attempt.outcome = 'success') AS turn_count,
              (SELECT COUNT(*) FROM tool_effects effect
                WHERE effect.run_id = run.run_id) AS tool_call_count,
              (SELECT COUNT(*) FROM tool_effects effect
                WHERE effect.run_id = run.run_id
                  AND effect.mode = 'write')
                AS write_tool_call_count,
              EXISTS(SELECT 1 FROM inference_attempts attempt
                WHERE attempt.run_id = run.run_id AND attempt.fallback_attempt > 0)
                AS fallback_used
         FROM runs run
        WHERE run.run_id = ? AND run.parent_tool_call_id IS NULL`,
      input.runId,
    ));
  }

  /** A settled tool receipt with the exact run facts used by terminal telemetry. */
  toolTerminalTelemetry(input: {
    runId: string;
    effectIntentId: string;
  }): ToolTerminalTelemetryRow | undefined {
    return first(this.sql.exec<ToolTerminalTelemetryRow>(
      `SELECT effect.effect_intent_id, effect.run_id, effect.status,
              effect.started_at, effect.settled_at, effect.error_json,
              effect.execution_plan_json, run.origin, run.parent_tool_call_id,
              run.execution_principal_json
         FROM tool_effects effect
         JOIN runs run ON run.run_id = effect.run_id
        WHERE effect.effect_intent_id = ? AND effect.run_id = ?`,
      input.effectIntentId,
      input.runId,
    ));
  }

  /** Whether a run is still on its way to a terminal state. */
  runIsActive(input: { runId: string }): boolean {
    const run = this.run({ runId: input.runId });
    return run !== undefined && ["admitted", "running"].includes(run.status);
  }

  /** The transcript part that triggered a run, if it recorded one. */
  triggerPartId(input: { runId: string }): string | null {
    return first(this.sql.exec<{ trigger_part_id: string | null } & Record<string, SqlStorageValue>>(
      `SELECT trigger_part_id FROM runs WHERE run_id = ?`,
      input.runId,
    ))?.trigger_part_id ?? null;
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
   * Commit this attempt's participant-visible output and recoverable outcome.
   *
   * The last of the guarded batches, and the only one that spanned two
   * authorities. Three statements: the transcript insert, a lifecycle event
   * that `JOIN`ed `messages` to check the insert had landed, and a work-stream
   * update whose `EXISTS (SELECT 1 FROM messages …)` checked the same thing
   * again. Both checks exist because a D1 batch cannot branch on its own
   * progress; inside one transaction there is nothing to check.
   *
   * Ordered Bind projection later made the transcript insert redundant for a
   * completed turn. This operation adopts an accepted turn, or finalizes the
   * explicitly identified provider bytes left by an interrupted stream, and
   * assigns attention. Host-authored terminal guidance is a separate system
   * turn, not assistant text wearing a nearby stream identity. Either turn is
   * optional, while the lifecycle event is not: a failure before any assistant
   * output still needs an immutable recovery checkpoint. All three facts
   * remain one transaction.
   *
   * `status` on the lifecycle event is the *published* spelling, unlike the
   * `terminal` event's. That is deliberate and load-bearing: this event records
   * the host outcome the caller reported, and recovery reads it back and
   * compares it against the published terminal set. The `terminal` event
   * records the run's own state, which is the object's vocabulary.
   */
  async prepareHostOutcome(input: PublishHostOutcomeInput): Promise<PreparedHostOutcome> {
    const messages = new WorkstreamMessageStorage(this.storage);
    return {
      finalTurn: input.finalTurn
        ? await this.transcript.prepareParticipantMessage({
          turnId: input.finalTurn.turnId,
          actor: "assistant",
          authorUserId: null,
          authorSnapshot: null,
          messageType: "text",
          text: input.finalTurn.text,
          structuredContentJson: null,
          producedByRunId: input.runId,
          createdAtUtc: new Date(input.now).toISOString(),
          attentionOrdinal: null,
        })
        : null,
      participantNotice: input.participantNotice
        ? await messages.prepareMessage({
          messageId: input.participantNotice.turnId,
          clientMessageId: input.participantNotice.turnId,
          authorType: "system",
          authorUserId: null,
          externalActorJson: null,
          messageType: "system",
          text: input.participantNotice.text,
          structuredContentJson: null,
          producedByRunId: input.runId,
          now: input.now,
        })
        : null,
    };
  }

  async publishHostOutcome(input: PublishHostOutcomeInput): Promise<
    {
      outcome: "published" | "replayed";
      finalTurnSequenceNumber: number | null;
      participantNoticeSequenceNumber: number | null;
    }
    | { outcome: "content_mismatch"; reasons: Array<"actor" | "run_id" | "role" | "content" | "notice"> }
    | { outcome: "ownership_lost" }
  > {
    const prepared = await this.prepareHostOutcome(input);
    return this.storage.transactionSync(() => this.publishPreparedHostOutcome(input, prepared));
  }

  publishPreparedHostOutcome(
    input: PublishHostOutcomeInput,
    prepared: PreparedHostOutcome,
  ): {
      outcome: "published" | "replayed";
      finalTurnSequenceNumber: number | null;
      participantNoticeSequenceNumber: number | null;
    }
    | { outcome: "content_mismatch"; reasons: Array<"actor" | "run_id" | "role" | "content" | "notice"> }
    | { outcome: "ownership_lost" } {
      const run = this.run({ runId: input.runId });
      if (!run
        || run.parent_tool_call_id !== null
        || run.legacy_attempt_id !== input.attemptId
        || run.lease_owner !== input.owner
        || run.status !== "running"
        || run.terminalized_at !== null
        || (!input.allowCancellationRequested && run.cancellation_requested_at !== null)
        || run.lease_expires_at === null
        || run.lease_expires_at <= input.now) {
        return { outcome: "ownership_lost" as const };
      }
      if (
        input.finalTurn !== null
        && input.participantNotice !== null
        && input.finalTurn.turnId === input.participantNotice.turnId
      ) {
        return { outcome: "content_mismatch" as const, reasons: ["notice" as const] };
      }

      const priorEvent = this.lifecycleEvent({ runId: input.runId, eventKey: "host_outcome" });
      const eventPayloadJson = JSON.stringify({
        finalTurnId: input.finalTurn?.turnId ?? null,
        participantNoticeTurnId: input.participantNotice?.turnId ?? null,
        ...(input.hostOutcomeError ? {
          error: {
            code: input.hostOutcomeError.code,
            message: input.hostOutcomeError.message,
          },
        } : {}),
      });
      if (priorEvent && (
        priorEvent.event_type !== "host_outcome_persisted"
        || priorEvent.status !== input.hostOutcomeStatus
        || priorEvent.member_safe_payload_json !== eventPayloadJson
      )) {
        return { outcome: "content_mismatch" as const, reasons: ["content" as const] };
      }

      const messages = new WorkstreamMessageStorage(this.storage);
      const existingNotice = prepared.participantNotice
        ? messages.messageByClientId({
          clientMessageId: prepared.participantNotice.input.clientMessageId,
        })
        : undefined;
      if (existingNotice && (
        existingNotice.id !== prepared.participantNotice?.input.messageId
        || existingNotice.author_type !== "system"
        || existingNotice.message_type !== "system"
        || existingNotice.text_content !== prepared.participantNotice.input.text
        || existingNotice.harness_run_id !== input.runId
      )) {
        return { outcome: "content_mismatch" as const, reasons: ["notice" as const] };
      }

      const finalized = prepared.finalTurn
        ? this.transcript.finalizePreparedAssistantTurn(prepared.finalTurn)
        : null;
      if (finalized?.outcome === "content_mismatch") {
        return finalized;
      }
      const notice = prepared.participantNotice
        ? messages.appendPreparedMessage(prepared.participantNotice)
        : null;
      const lifecycle = this.recordLifecycleEvent({
        eventId: input.lifecycleEventId,
        runId: input.runId,
        attemptId: input.attemptId,
        eventKey: "host_outcome",
        eventType: "host_outcome_persisted",
        status: input.hostOutcomeStatus,
        memberSafePayloadJson: eventPayloadJson,
        now: input.now,
      });
      return {
        outcome: lifecycle.outcome === "recorded"
          || finalized?.outcome === "published"
          || notice?.outcome === "appended"
          ? "published"
          : "replayed",
        finalTurnSequenceNumber: finalized?.transcriptSequence ?? null,
        participantNoticeSequenceNumber: notice?.sequenceNumber ?? null,
      };
  }

  /**
   * Settle a root run: the event, the run, the sidebar and the descendants.
   *
   * The routed version was a four-statement batch in which the third and fourth
   * statements each carried `EXISTS (SELECT 1 FROM harness_runs … AND
   * terminalized_at = ?)` — a correlated subquery whose only job was to ask
   * whether the batch's *own* second statement had landed, since D1 gives a
   * batch no way to branch on its own progress. Here the fence is checked once
   * and the four writes follow it.
   *
   * The caller still has work after this returns, and deliberately outside the
   * transaction: a stopped run's open tool receipts belong to another
   * authority, and of the two possible orderings only "terminalize, then
   * settle" fails safe. `already_terminal` therefore reports whether that
   * settlement was ever recorded, so a crash between the two is repaired on
   * the next attempt rather than leaving a tool card spinning forever.
   */
  terminalizeAttempt(input: AttemptFence & {
    status: TerminalRunStatus;
    finalTurnId: string | null;
    model: string | null;
    usageJson: string | null;
    errorJson: string | null;
    memberSafePayloadJson: string;
    lifecycleEventId: string;
    receiptMarkerEventKey: string;
    loopExecutionFence: TerminalLoopExecutionFence | null;
  }): TerminalizeOutcome {
    assertTerminalRunStatus(input.status);
    return this.storage.transactionSync(() => {
      const run = this.run({ runId: input.runId });
      if (!run || run.parent_tool_call_id !== null) return { outcome: "not_found" as const };
      const stopping = input.status === "cancelled";
      // A linked persistent-loop execution owns the terminal outcome. A
      // cancellation marker on its subordinate receipt is provenance from an
      // earlier request, not authority to replace or veto the outcome chosen
      // when the loop reached its safe boundary. The exact loop fence below is
      // what proves that this caller still owns terminalization.
      const loopOwnsTerminalOutcome = input.loopExecutionFence !== null;
      const stoppingRecoveredAttempt = stopping
        && run.cancellation_requested_at !== null
        && run.lease_owner === previousInstanceRecoveryOwner(input.attemptId);
      if (run.legacy_attempt_id === input.attemptId
        && run.terminalized_at !== null
        && run.status === input.status) {
        if (!this.#closeLinkedLoopForTerminalReceipt(
          input.runId,
          input.loopExecutionFence,
          input.now,
          true,
        )) {
          return { outcome: "ownership_lost" as const };
        }
        this.#repairTerminalExecutionState(input.runId, input.status, run.terminalized_at);
        const terminal = this.lifecycleEvent({ runId: input.runId, eventKey: "terminal" });
        return {
          outcome: "already_terminal" as const,
          status: run.status,
          terminalizedAt: run.terminalized_at,
          errorJson: run.error_json,
          memberSafePayloadJson: terminal?.member_safe_payload_json ?? "{}",
          receiptsReconciled: this.lifecycleEvent({
            runId: input.runId,
            eventKey: input.receiptMarkerEventKey,
          })?.attempt_id === run.legacy_attempt_id,
        };
      }
      if (run.legacy_attempt_id !== input.attemptId
        || run.lease_owner !== input.owner
        || run.terminalized_at !== null
        || (!loopOwnsTerminalOutcome && !stopping && run.cancellation_requested_at !== null)
        || run.lease_expires_at === null
        || (run.lease_expires_at <= input.now && !stoppingRecoveredAttempt)) {
        return { outcome: "ownership_lost" as const };
      }
      if (!this.#closeLinkedLoopForTerminalReceipt(input.runId, input.loopExecutionFence, input.now)) {
        return { outcome: "ownership_lost" as const };
      }
      this.#commitTerminalState({
        runId: input.runId,
        attemptId: input.attemptId,
        claimAttempt: false,
        status: input.status,
        finalTurnId: input.finalTurnId,
        model: input.model,
        usageJson: input.usageJson,
        errorJson: input.errorJson,
        memberSafePayloadJson: input.memberSafePayloadJson,
        lifecycleEventId: input.lifecycleEventId,
        terminalizedAt: input.now,
        activityStoppedAt: input.now,
        descendantReason: "parent_terminalized",
      });
      return { outcome: "terminalized" as const };
    });
  }

  /**
   * Terminalize the exact persistent-loop execution from the product failure
   * transaction. The caller owns the surrounding transaction because it also
   * enqueues the regional projection derived from the resulting workstream
   * row. Keeping this operation synchronous lets that projection and every
   * local terminal invariant commit or roll back together.
   */
  terminalizeWorkflowFailureInCurrentTransaction(input: {
    runId: string;
    errorJson: string;
    memberSafePayloadJson: string;
    lifecycleEventId: string;
    stateReasonCode: string;
    loopExecutionFence: TerminalLoopExecutionFence;
    now: number;
  }): { outcome: "terminalized" | "ownership_lost" } {
    const run = this.run({ runId: input.runId });
    if (!run
      || run.parent_tool_call_id !== null
      || !["admitted", "running"].includes(run.status)
      || run.terminalized_at !== null) {
      return { outcome: "ownership_lost" };
    }
    if (!this.#closeLinkedLoopForTerminalReceipt(
      input.runId,
      input.loopExecutionFence,
      input.now,
    )) {
      return { outcome: "ownership_lost" };
    }
    const terminalAttemptId = run.legacy_attempt_id ?? `workflow-failure:${input.runId}`;
    this.#commitTerminalState({
      runId: input.runId,
      attemptId: terminalAttemptId,
      claimAttempt: run.legacy_attempt_id === null,
      status: "failed",
      finalTurnId: null,
      model: null,
      usageJson: null,
      errorJson: input.errorJson,
      memberSafePayloadJson: input.memberSafePayloadJson,
      lifecycleEventId: input.lifecycleEventId,
      terminalizedAt: input.now,
      activityStoppedAt: input.now,
      descendantReason: "parent_terminalized",
      stateReasonCode: input.stateReasonCode,
    });
    return { outcome: "terminalized" };
  }

  /**
   * The one local terminal commit. Entry points establish their own authority
   * first; after that there is no smaller valid ending than this complete set
   * of writes. External tool-receipt settlement remains outside because it is
   * owned by another Durable Object and is recovered by its durable marker.
   */
  #commitTerminalState(input: TerminalCommitInput): void {
    this.#repairTerminalExecutionState(
      input.runId,
      input.status,
      input.activityStoppedAt,
    );
    this.recordLifecycleEvent({
      eventId: input.lifecycleEventId,
      runId: input.runId,
      attemptId: input.attemptId,
      eventKey: "terminal",
      eventType: "terminal",
      status: input.status,
      memberSafePayloadJson: input.memberSafePayloadJson,
      now: input.terminalizedAt,
    });
    this.sql.exec(
      `UPDATE runs
          SET legacy_attempt_id = CASE WHEN ?8 = 1 THEN ?9 ELSE legacy_attempt_id END,
              attempt_epoch = attempt_epoch + CASE WHEN ?8 = 1 THEN 1 ELSE 0 END,
              status = ?2, terminal_reason = ?2,
              completed_at = ?3, terminalized_at = ?3, final_turn_id = ?4,
              model = COALESCE(?5, model), usage_json = COALESCE(?6, usage_json),
              ${usageCounterAssignments("COALESCE(?6, usage_json)")},
              error_json = ?7, lease_owner = NULL, lease_expires_at = NULL,
              updated_at = ?3
        WHERE run_id = ?1`,
      input.runId,
      input.status,
      input.terminalizedAt,
      input.finalTurnId,
      input.model,
      input.usageJson,
      input.errorJson,
      input.claimAttempt ? 1 : 0,
      input.attemptId,
    );
    this.settleWorkstreamState(
      input.runId,
      input.status,
      input.terminalizedAt,
      input.stateReasonCode,
    );
    this.cancelDescendants({
      rootRunId: input.runId,
      reason: input.descendantReason,
      now: input.terminalizedAt,
    });
  }

  /** Repair the participant-visible state subordinate to a terminal receipt. */
  #repairTerminalExecutionState(
    runId: string,
    status: TerminalRunStatus,
    activityStoppedAt: number,
  ): void {
    this.#closeExecutionActivities(runId, status, activityStoppedAt);
    this.sql.exec(`DELETE FROM active_output_turns WHERE run_id = ?`, runId);
    this.sql.exec(`DELETE FROM active_agent_compaction WHERE run_id = ?`, runId);
    this.sql.exec(`DELETE FROM inference_delay_status WHERE run_id = ?`, runId);
  }

  /**
   * Close the exact persistent-loop execution in the receipt terminalization
   * transaction. Safe-step settlement deliberately keeps this execution owned;
   * terminal receipt publication is the sole executing-to-idle authority. A
   * newer cycle can only exist after this transaction has closed the old one.
   */
  #closeLinkedLoopForTerminalReceipt(
    runId: string,
    fence: TerminalLoopExecutionFence | null,
    now: number,
    allowAlreadyClosed = false,
  ): boolean {
    const receipt = first(this.sql.exec<{
      substream_loop_id: string | null;
      loop_cycle_ordinal: number | null;
      loop_execution_id: string | null;
      loop_execution_epoch: number | null;
    } & Record<string, SqlStorageValue>>(
      `SELECT substream_loop_id, loop_cycle_ordinal, loop_execution_id, loop_execution_epoch
         FROM runs WHERE run_id = ?`,
      runId,
    ));
    if (!receipt || receipt.substream_loop_id === null) return fence === null;
    if (!fence
      || receipt.substream_loop_id !== fence.loopId
      || receipt.loop_execution_id !== fence.executionId
      || receipt.loop_execution_epoch !== fence.executionEpoch
      || fence.executionId !== runId
      || receipt.loop_cycle_ordinal === null) return false;
    const loop = first(this.sql.exec<{
      loop_id: string;
      status: string;
      cycle_ordinal: number;
      active_execution_id: string | null;
      active_execution_epoch: number | null;
      lease_owner: string | null;
      lease_expires_at: number | null;
    } & Record<string, SqlStorageValue>>(
      `SELECT loop_id, status, cycle_ordinal, active_execution_id,
              active_execution_epoch, lease_owner, lease_expires_at
         FROM substream_loops WHERE id = 1`,
    ));
    if (!loop || loop.loop_id !== fence.loopId) return false;
    if (loop.status === "idle" || loop.cycle_ordinal > receipt.loop_cycle_ordinal) {
      return allowAlreadyClosed;
    }
    if (loop.status !== "executing"
      || loop.cycle_ordinal !== receipt.loop_cycle_ordinal
      || loop.active_execution_id !== fence.executionId
      || loop.active_execution_epoch !== fence.executionEpoch
      || loop.lease_owner !== fence.leaseOwner
      || loop.lease_expires_at === null
      || loop.lease_expires_at <= now) return false;
    const activeReservation = first(this.sql.exec<{ turn_id: string } & Record<string, SqlStorageValue>>(
      `SELECT turn_id FROM assistant_turn_reservations
        WHERE loop_id = ? AND cycle_ordinal = ? AND state IN ('reserved', 'streaming')
        LIMIT 1`,
      fence.loopId,
      receipt.loop_cycle_ordinal,
    ));
    if (activeReservation) throw new Error("substream_loop_has_unmaterialized_turn");
    const withheld = this.transcript.unsettledToolBatchBlockingRelease(fence.loopId);
    if (withheld) throw new UnsettledToolBatchError(withheld);
    const closed = first(this.sql.exec<{ loop_id: string } & Record<string, SqlStorageValue>>(
      `UPDATE substream_loops
          SET status = 'idle', active_execution_id = NULL,
              active_execution_epoch = NULL, lease_owner = NULL,
              lease_expires_at = NULL, stop_requested_at = NULL,
              stop_after_step_ordinal = NULL, stop_reason = NULL,
              revision = revision + 1, updated_at = ?
        WHERE id = 1 AND loop_id = ? AND status = 'executing'
          AND cycle_ordinal = ? AND active_execution_id = ?
          AND active_execution_epoch = ? AND lease_owner = ?
          AND lease_expires_at > ?
        RETURNING loop_id`,
      now,
      fence.loopId,
      receipt.loop_cycle_ordinal,
      fence.executionId,
      fence.executionEpoch,
      fence.leaseOwner,
      now,
    ));
    return closed?.loop_id === fence.loopId;
  }

  /**
   * Close every still-active interval owned by this execution in the same
   * transaction as its terminal receipt. Normal lifecycle edges have already
   * closed observed intervals. Anything left active here crossed an isolate or
   * process boundary, so the receipt timestamp is only the earliest durable
   * observation by which Rally knows the work had ended: its duration is an
   * upper bound, never a falsely precise observation.
   */
  #closeExecutionActivities(
    runId: string,
    status: TerminalRunStatus,
    terminalizedAt: number,
  ): void {
    this.sql.exec(
      `WITH RECURSIVE execution_activities(activity_id) AS (
         SELECT activity_id FROM transcript_activities
          WHERE scope = 'response' AND subject_id = ?
         UNION ALL
         SELECT child.activity_id
           FROM transcript_activities child
           JOIN execution_activities parent
             ON child.parent_activity_id = parent.activity_id
       )
       UPDATE transcript_activity_intervals
          SET stopped_at = ?, duration_ms = MAX(0, ? - started_at),
              boundary_source = 'recovered', timing_accuracy = 'upper_bound',
              revision = revision + 1
        WHERE activity_id IN (SELECT activity_id FROM execution_activities)
          AND stopped_at IS NULL`,
      runId,
      terminalizedAt,
      terminalizedAt,
    );
    const lifecycleState = status === "cancelled"
      ? "cancelled"
      : status === "failed"
        ? "failed"
        : "completed";
    const closed = this.sql.exec<{ activity_id: string } & Record<string, SqlStorageValue>>(
      `WITH RECURSIVE execution_activities(activity_id) AS (
         SELECT activity_id FROM transcript_activities
          WHERE scope = 'response' AND subject_id = ?
         UNION ALL
         SELECT child.activity_id
           FROM transcript_activities child
           JOIN execution_activities parent
             ON child.parent_activity_id = parent.activity_id
       )
       UPDATE transcript_activities
          SET lifecycle_state = CASE
                WHEN scope = 'tool_call' THEN COALESCE((
                  SELECT CASE
                    WHEN block.lifecycle_state = 'completed' THEN 'completed'
                    WHEN block.lifecycle_state = 'cancelled' THEN 'cancelled'
                    WHEN block.lifecycle_state = 'ambiguous' THEN 'ambiguous'
                    ELSE 'failed'
                  END
                    FROM participant_transcript_blocks block
                   WHERE block.tool_call_id = transcript_activities.subject_id
                ), ?)
                WHEN scope = 'plugin' THEN CASE
                  WHEN EXISTS (
                    SELECT 1
                      FROM transcript_activities assistant
                      JOIN participant_transcript_blocks block
                        ON block.turn_id = assistant.subject_id
                     WHERE assistant.activity_id = transcript_activities.parent_activity_id
                       AND block.plugin_id = transcript_activities.subject_id
                       AND block.lifecycle_state = 'ambiguous'
                  ) THEN 'ambiguous'
                  WHEN EXISTS (
                    SELECT 1
                      FROM transcript_activities assistant
                      JOIN participant_transcript_blocks block
                        ON block.turn_id = assistant.subject_id
                     WHERE assistant.activity_id = transcript_activities.parent_activity_id
                       AND block.plugin_id = transcript_activities.subject_id
                       AND block.lifecycle_state = 'failed'
                  ) THEN 'failed'
                  WHEN EXISTS (
                    SELECT 1
                      FROM transcript_activities assistant
                      JOIN participant_transcript_blocks block
                        ON block.turn_id = assistant.subject_id
                     WHERE assistant.activity_id = transcript_activities.parent_activity_id
                       AND block.plugin_id = transcript_activities.subject_id
                       AND block.lifecycle_state = 'cancelled'
                  ) THEN 'cancelled'
                  ELSE 'completed'
                END
                WHEN scope = 'assistant_turn' THEN CASE
                  WHEN EXISTS (
                    SELECT 1 FROM participant_transcript_blocks block
                     WHERE block.turn_id = transcript_activities.subject_id
                       AND block.block_kind = 'tool'
                       AND block.lifecycle_state = 'ambiguous'
                  ) THEN 'ambiguous'
                  WHEN EXISTS (
                    SELECT 1 FROM participant_transcript_blocks block
                     WHERE block.turn_id = transcript_activities.subject_id
                       AND block.block_kind = 'tool'
                       AND block.lifecycle_state = 'failed'
                  ) THEN 'failed'
                  WHEN EXISTS (
                    SELECT 1 FROM participant_transcript_blocks block
                     WHERE block.turn_id = transcript_activities.subject_id
                       AND block.block_kind = 'tool'
                       AND block.lifecycle_state = 'cancelled'
                  ) THEN 'cancelled'
                  ELSE ?
                END
                ELSE ?
              END,
              revision = revision + 1, updated_at = ?
        WHERE activity_id IN (SELECT activity_id FROM execution_activities)
          AND lifecycle_state = 'active'
        RETURNING activity_id`,
      runId,
      lifecycleState,
      lifecycleState,
      lifecycleState,
      terminalizedAt,
    ).toArray();
    for (const activity of closed) {
      enqueueSemanticRealtimeReference(this.sql, {
        kind: "transcript_activity",
        activityId: activity.activity_id,
        snapshotAtUtc: new Date(terminalizedAt).toISOString(),
      }, terminalizedAt);
    }
  }

  /**
   * Terminal runs whose residual receipts were never reconciled.
   *
   * Terminalization and receipt settlement are two authorities, so a crash
   * between them leaves a run permanently terminal with a member-visible tool
   * card still spinning. The absent marker is how those rows are found, and
   * recording it is what makes the bounded walk advance instead of rescanning
   * the same history on every activation.
   */
  residualRepairCandidates(input: {
    markerEventKey: string;
    limit: number;
  }): ResidualRepairRow[] {
    return this.sql.exec<ResidualRepairRow>(
      `SELECT run.run_id, run.legacy_attempt_id AS attempt_id, run.origin, run.status,
              run.terminalized_at, run.error_json, run.parent_tool_call_id,
              COALESCE(terminal.member_safe_payload_json, '{}') AS member_safe_payload_json
         FROM runs run
         LEFT JOIN run_lifecycle_events terminal
           ON terminal.run_id = run.run_id AND terminal.event_key = 'terminal'
        WHERE run.status IN ('completed', 'needs_input', 'failed', 'cancelled')
          AND run.terminalized_at IS NOT NULL
          AND run.legacy_attempt_id IS NOT NULL
          -- Every terminal-first path attempts residual settlement, so every
          -- terminal row is a candidate for the retry. The predicate used to
          -- name the three paths that did -- member-stopped roots, reaped
          -- children, stale-lease roots -- which meant a completed or directly
          -- failed root that lost its settlement response was matched by
          -- nothing at all and kept a tool card spinning forever. Naming paths
          -- here is what made that possible; do not narrow it back to a list.
          --
          -- The four statuses are the object's vocabulary for the published set
          -- the routed predicate named: 'cancelled' is how 'stopped' is stored.
          -- The cost of the width is that rows terminalized before this
          -- became universal have no marker either, so the walk backfills them
          -- a bounded page at a time. Each repaired row records its marker, so
          -- it is paid once rather than on every activation.
          AND NOT EXISTS (
            SELECT 1 FROM run_lifecycle_events settled
             WHERE settled.run_id = run.run_id
               AND settled.attempt_id = run.legacy_attempt_id
               AND settled.event_key = ?1
          )
        -- Newest first, for one reason: a card stranded minutes ago is the one
        -- a member is looking at, and it must not wait behind every historical
        -- row in the work stream.
        --
        -- Not because it helps with a row that can never settle. One whose
        -- terminal stamp does not match records no marker however often it is
        -- tried, so it is re-selected forever and holds a slot in every page;
        -- ordering only decides which such rows do the holding, and neither
        -- direction drops them. Paginating past them needs durable per-row
        -- retry state and a backoff nobody here can derive a number for, so it
        -- is not built on speculation: each failure reports through the
        -- caller's onReceiptRepairFailure hook, and a wedged page is that
        -- warning repeating the same run id.
        ORDER BY run.terminalized_at DESC, run.run_id DESC
        LIMIT ?2`,
      input.markerEventKey,
      input.limit,
    ).toArray();
  }

  /**
   * Root runs whose lease has run out.
   *
   * Ordinary attempts are the only runs whose expired lease is itself a
   * terminal condition. Historical inline-child rows remain excluded from this pass.
   * New background agents own ordinary independent runs.
   */
  //
  // This pass is the only recovery for an executor that died without
  // terminalizing at all, and nothing schedules it: `reapStaleHarnessRuns` is
  // called from one place, immediately before a new attempt is claimed
  // (`agent-loop-do.ts`). A work stream nobody
  // sends another message to therefore keeps such a run `running` and its tool
  // card spinning indefinitely. Closing that needs the object to wake on its
  // own expired lease, which is a wake reason and belongs to
  // `docs/durable-object-alarms.md` rather than to this operation.
  staleLeaseRuns(input: {
    now: number;
    limit: number;
  }): StaleRunRow[] {
    return this.sql.exec<StaleRunRow>(
      `SELECT run_id, legacy_attempt_id AS attempt_id, lease_owner, lease_expires_at,
              origin, parent_run_id, parent_tool_call_id, cancellation_requested_at
         FROM runs
        WHERE status IN ${BUSY_RUN_STATUSES} AND terminalized_at IS NULL
          AND parent_tool_call_id IS NULL
          -- A linked receipt is subordinate to the persistent loop. Its loop
          -- execution, provider protocol, and run must be recovered together;
          -- an expired receipt lease alone is not terminal authority.
          AND substream_loop_id IS NULL
          AND legacy_attempt_id IS NOT NULL AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?1
        ORDER BY lease_expires_at ASC
        LIMIT ?2`,
      input.now,
      input.limit,
    ).toArray();
  }

  /**
   * End a root run whose executor lost its lease.
   *
   * The routed version was another four-statement batch whose last two asked,
   * through `EXISTS (… terminalized_at = ?)`, whether its own second statement
   * had landed. `leaseExpiresAt` is the compare-and-swap: the row must still
   * carry the exact deadline the scan saw, or a heartbeat won the race and this
   * run is not stale after all.
   */
  reapStaleRoot(input: {
    runId: string;
    attemptId: string;
    leaseExpiresAt: number;
    lifecycleEventId: string;
    now: number;
  }): { outcome: "reaped" | "not_stale" } {
    return this.storage.transactionSync(() => {
      const run = this.run({ runId: input.runId });
      if (!run
        || run.parent_tool_call_id !== null
        || run.substream_loop_id !== null
        || run.legacy_attempt_id !== input.attemptId
        || run.lease_expires_at !== input.leaseExpiresAt
        || run.lease_expires_at > input.now
        || run.status !== "running"
        || run.terminalized_at !== null) {
        return { outcome: "not_stale" as const };
      }
      this.#commitTerminalState({
        runId: input.runId,
        attemptId: input.attemptId,
        claimAttempt: false,
        status: "failed",
        finalTurnId: null,
        model: null,
        usageJson: null,
        errorJson: '{"code":"stale_run_reaped","message":"The prior executor lost its durable lease"}',
        memberSafePayloadJson: '{"code":"stale_run_reaped"}',
        lifecycleEventId: input.lifecycleEventId,
        terminalizedAt: input.now,
        activityStoppedAt: input.leaseExpiresAt,
        descendantReason: "parent_stale_run_reaped",
      });
      return { outcome: "reaped" as const };
    });
  }

  /** Whether a sub-agent's parent has stopped being able to look after it. */
  private parentCannotSupervise(child: RunRow, now: number): boolean {
    if (child.cancellation_requested_at !== null) return true;
    const parent = child.parent_run_id === null
      ? undefined
      : this.run({ runId: child.parent_run_id });
    return !parent
      || parent.status !== "running"
      || parent.terminalized_at !== null
      || parent.cancellation_requested_at !== null
      || parent.legacy_attempt_id === null
      || parent.lease_owner === null
      || parent.lease_expires_at === null
      || parent.lease_expires_at <= now;
  }

  /**
   * Create one root execution receipt without changing the substream loop.
   *
   * Four callers formerly built this out of the same routed batch — a legacy
   * supersede, an `INSERT … SELECT … WHERE ? = (SELECT latest.id …)` whose
   * subquery *was* the staleness check, and a sidebar update guarded on
   * `EXISTS (SELECT 1 FROM harness_runs WHERE id = ?)` to ask whether the
   * insert had landed. The staleness check is the interesting one: expressed as
   * a subquery inside the insert it could only answer by writing nothing, which
   * is also what a duplicate id does, so the caller could not tell "someone
   * else got here first" from "this is a retry of my own request".
   *
   * `expectedLatestRunId` is how a caller says which receipt it believed was
   * newest. Null means it does not care — a scheduled or automation run is not
   * racing a member.
   */
  admitRun(input: {
    runId: string;
    origin: string;
    executionPrincipalJson: string;
    status: AdmittedRunStatus;
    startedAt: number | null;
    model: string | null;
    triggerPartId: string | null;
    parentRunId: string | null;
    expectedLatestRunId: string | null;
    now: number;
  }): AdmitRunOutcome {
    assertAdmittedRunStatus(input.status);
    return this.storage.transactionSync(() => {
      if (this.run({ runId: input.runId })) return { outcome: "exists" as const };
      if (input.expectedLatestRunId !== null
        && this.latestRootRun()?.run_id !== input.expectedLatestRunId) {
        return { outcome: "stale" as const };
      }
      // Execution receipts do not own substream lifecycle. More than one may
      // wait while the singleton substream loop executes exactly one receipt;
      // admitting a successor must never cancel the in-flight execution.
      this.sql.exec(
        `INSERT INTO runs
           (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
            next_action_cursor, input_fence_seq, revision, started_at,
            active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
            tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
            origin, execution_principal_json, parent_run_id, chain_depth, model,
            usage_json, trigger_part_id, created_at, updated_at)
         VALUES (?1, '0', ?2, '{}', 0, 0, '', 0, 0, ?3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                 ?4, ?5, ?6, 0, ?7, '{}', ?8, ?9, ?9)`,
        input.runId,
        input.status,
        input.startedAt ?? input.now,
        input.origin,
        input.executionPrincipalJson,
        input.parentRunId,
        input.model,
        input.triggerPartId,
        input.now,
      );
      if (input.status === "running") {
        this.markWorkstreamRunning(input.now);
      }
      return { outcome: "admitted" as const };
    });
  }

  /** Restore the one checked-in development receipt without a runtime SQL backdoor. */
  seedDevelopmentRun(input: {
    runId: string;
    origin: string;
    executionPrincipalJson: string;
    status: PersistedRunStatus;
    startedAt: number;
    completedAt: number | null;
    terminalizedAt: number | null;
    createdAt: number;
  }): { outcome: "inserted" | "exists" } {
    assertPersistedRunStatus(input.status);
    if (this.run({ runId: input.runId })) return { outcome: "exists" as const };
    this.sql.exec(
      `INSERT INTO runs
         (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
          next_action_cursor, input_fence_seq, revision, started_at,
          active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
          tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
          terminal_reason, origin, execution_principal_json, chain_depth, usage_json,
          completed_at, terminalized_at, created_at, updated_at)
       VALUES (?, '0', ?, '{}', 0, 0, '', 0, 0, ?, 0, 0, 0, 0, 0,
               0, 0, 0, 0, 0, ?, ?, ?, 0, '{}', ?, ?, ?, ?)`,
      input.runId,
      input.status,
      input.startedAt,
      ["completed", "failed", "cancelled", "needs_input"].includes(input.status)
        ? input.status : null,
      input.origin,
      input.executionPrincipalJson,
      input.completedAt,
      input.terminalizedAt,
      input.createdAt,
      input.terminalizedAt ?? input.completedAt ?? input.createdAt,
    );
    return { outcome: "inserted" as const };
  }

  /**
   * Record which Workflow instance is driving a run.
   *
   * Three callers launch a Workflow and then write its id back. It is a plain
   * write with no fence, because the launch has already happened: refusing here
   * would leave a running Workflow nobody can find.
   */
  bindWorkflowInstance(input: {
    runId: string;
    workflowInstanceId: string;
    now: number;
  }): { outcome: "bound" | "not_found" } {
    return this.storage.transactionSync(() => {
      if (!this.run({ runId: input.runId })) return { outcome: "not_found" as const };
      this.sql.exec(
        `UPDATE runs SET workflow_instance_id = ?2, updated_at = ?3 WHERE run_id = ?1`,
        input.runId,
        input.workflowInstanceId,
        input.now,
      );
      return { outcome: "bound" as const };
    });
  }

  /**
   * Settle a run that was never claimed.
   *
   * `terminalizeAttempt`'s fence inverted: the run must have *no* attempt at
   * all, because this is how a queued run dies before its executor acquires the
   * harness lease — a rejected admission, a Workflow that failed to start, or
   * a cancellation observed after the persistent loop activated but before the
   * attempt claim. A loop-linked receipt additionally has to prove and release
   * that exact execution. The ending still stamps an attempt id, so the
   * terminal event and the run agree on who ended it and a retry of the same
   * identity is a replay rather than a second ending.
   */
  terminalizeQueuedRun(input: {
    runId: string;
    attemptId: string;
    status: TerminalRunStatus;
    errorJson: string | null;
    memberSafePayloadJson: string;
    lifecycleEventId: string;
    loopExecutionFence: TerminalLoopExecutionFence | null;
    now: number;
  }): { outcome: "terminalized" | "already_terminal" | "ownership_lost" | "not_found" } {
    assertTerminalRunStatus(input.status);
    return this.storage.transactionSync(() => {
      const run = this.run({ runId: input.runId });
      if (!run || run.parent_tool_call_id !== null) return { outcome: "not_found" as const };
      if (run.legacy_attempt_id === input.attemptId
        && run.status === input.status
        && run.terminalized_at !== null) {
        if (!this.#closeLinkedLoopForTerminalReceipt(
          input.runId,
          input.loopExecutionFence,
          input.now,
          true,
        )) {
          return { outcome: "ownership_lost" as const };
        }
        this.#repairTerminalExecutionState(input.runId, input.status, run.terminalized_at);
        return { outcome: "already_terminal" as const };
      }
      if (run.legacy_attempt_id !== null
        || !["admitted", "running"].includes(run.status)
        || run.terminalized_at !== null) {
        return { outcome: "ownership_lost" as const };
      }
      if (!this.#closeLinkedLoopForTerminalReceipt(
        input.runId,
        input.loopExecutionFence,
        input.now,
      )) {
        return { outcome: "ownership_lost" as const };
      }
      this.#commitTerminalState({
        runId: input.runId,
        attemptId: input.attemptId,
        claimAttempt: true,
        status: input.status,
        finalTurnId: null,
        model: null,
        usageJson: null,
        errorJson: input.errorJson,
        memberSafePayloadJson: input.memberSafePayloadJson,
        lifecycleEventId: input.lifecycleEventId,
        terminalizedAt: input.now,
        activityStoppedAt: input.now,
        descendantReason: "parent_terminalized",
      });
      return { outcome: "terminalized" as const };
    });
  }

  /**
   * Hand the work stream back to the member, if nothing else still holds it.
   *
   * The claim batch's third statement in reverse — `markWorkstreamRunning`'s
   * counterpart. The `NOT EXISTS` matters: a superseding turn admitted while
   * this one was finishing must keep the sidebar busy, or the member watches a
   * work stream go idle and then immediately start again. A stopped run leaves
   * it `idle` rather than recording a terminal state, because a stop is the
   * member taking the conversation back rather than an outcome to report.
   */
  private settleWorkstreamState(
    runId: string,
    status: string,
    now: number,
    reasonCode = `runtime_${status === "cancelled" ? "idle" : status}`,
  ): void {
    const stillBusy = first(this.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count FROM runs
        WHERE run_id != ?
          AND parent_tool_call_id IS NULL
          AND status IN ('admitted', 'running')
          AND terminalized_at IS NULL
          AND cancellation_requested_at IS NULL`,
      runId,
    ))?.count ?? 0;
    if (stillBusy > 0) return;
    const state = status === "cancelled" ? "idle" : status;
    this.sql.exec(
      `UPDATE workstream
          SET exact_state = ?1,
              state_reason_code = ?2,
              state_changed_at = ?3,
              completed_at = CASE WHEN ?1 = 'completed' THEN COALESCE(completed_at, ?3) ELSE completed_at END,
              last_people_activity_at = ?3,
              updated_at = ?3
        WHERE id = 1`,
      state,
      reasonCode,
      now,
    );
  }

  /**
   * Mark this attempt's residual receipts reconciled, fenced on the settlement.
   *
   * `terminalized_at` is the fence rather than the attempt alone: the marker
   * must belong to the terminalization the caller just made or observed, so a
   * late repair for a superseded attempt cannot claim a newer one's work.
   *
   * The `replayed` answer is fenced on the attempt too. The routed version
   * compared `attempt_id` in its fallback read, and dropping that here would
   * report success to a caller whose own marker was never written, because some
   * *other* attempt had written one under the same key. That row is then
   * re-selected by every sweep forever while each sweep calls it settled — a
   * wedged page that never emits the repair-failure warning the reap's own
   * comment promises is how you would find it.
   */
  recordReceiptReconciliation(input: {
    runId: string;
    attemptId: string;
    terminalizedAt: number;
    eventKey: string;
    eventId: string;
    now: number;
  }): { outcome: "recorded" | "replayed" | "not_terminal" } {
    return this.storage.transactionSync(() => {
      const run = this.run({ runId: input.runId });
      if (!run
        || run.legacy_attempt_id !== input.attemptId
        || run.terminalized_at !== input.terminalizedAt) {
        const marker = this.lifecycleEvent({ runId: input.runId, eventKey: input.eventKey });
        return marker?.attempt_id === input.attemptId
          ? { outcome: "replayed" as const }
          : { outcome: "not_terminal" as const };
      }
      return this.recordLifecycleEvent({
        eventId: input.eventId,
        runId: input.runId,
        attemptId: input.attemptId,
        eventKey: input.eventKey,
        eventType: "receipt_reconciliation",
        status: run.status,
        memberSafePayloadJson: "{}",
        now: input.now,
      });
    });
  }

  /**
   * Ask every live descendant of a run to stop, and say how many were asked.
   *
   * `COALESCE` on both columns keeps the *first* cancellation's reason: a run
   * stopped by a member and then swept again by its parent's terminalization
   * should still say the member stopped it.
   *
   * The count is read before the write rather than from the cursor.
   * `rowsWritten` counts index rows on this engine, and `updated_at` is a
   * column of both `runs_status_idx` and `runs_substream_idx` — so the cursor
   * reports three writes per descendant, not one. The Node fixture hides that
   * by reporting SQLite's true `changes`, which is why the existing specs pass
   * either way; `terminal-authority.test.ts` documents the same trap from the
   * other side. Counting the rows the predicate matches answers the question
   * the caller is actually asking.
   */
  cancelDescendants(input: {
    rootRunId: string;
    reason: string;
    now: number;
  }): { cancelled: number } {
    return this.storage.transactionSync(() => {
      const cancelled = first(this.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
        `SELECT COUNT(*) AS count FROM runs
          WHERE (chain_root_run_id = ?1 OR parent_run_id = ?1)
            AND parent_tool_call_id IS NOT NULL
            AND status IN ${OPEN_RUN_STATUSES}
            AND terminalized_at IS NULL`,
        input.rootRunId,
      ))?.count ?? 0;
      this.sql.exec(
        `UPDATE runs
            SET cancellation_requested_at = COALESCE(cancellation_requested_at, ?2),
                cancellation_reason = COALESCE(cancellation_reason, ?3),
                updated_at = ?2
          WHERE (chain_root_run_id = ?1 OR parent_run_id = ?1)
            AND parent_tool_call_id IS NOT NULL
            AND status IN ${OPEN_RUN_STATUSES}
            AND terminalized_at IS NULL`,
        input.rootRunId,
        input.now,
        input.reason,
      );
      return { cancelled };
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

  /** The canonical assistant turn a final checkpoint is allowed to name. */
  finalAssistantTurn(input: { runId: string; turnId: string }): { turn_id: string } | undefined {
    return first(this.sql.exec<{ turn_id: string } & Record<string, SqlStorageValue>>(
      `SELECT turn.turn_id
         FROM participant_transcript_turns turn
         JOIN transcript_facts fact ON fact.fact_id = turn.root_fact_id
         LEFT JOIN assistant_turn_reservations reservation ON reservation.turn_id = turn.turn_id
        WHERE turn.turn_id = ? AND turn.actor = 'assistant'
          AND turn.entry_kind = 'conversation'
          AND COALESCE(reservation.execution_id, fact.run_id) = ?`,
      input.turnId,
      input.runId,
    ));
  }

  /** The participant-visible system notice committed with a host outcome. */
  hostOutcomeParticipantNotice(input: {
    runId: string;
    turnId: string;
  }): { turn_id: string } | undefined {
    return first(this.sql.exec<{ turn_id: string } & Record<string, SqlStorageValue>>(
      `SELECT turn.turn_id
         FROM participant_transcript_turns turn
         JOIN transcript_facts fact ON fact.fact_id = turn.root_fact_id
        WHERE turn.turn_id = ? AND turn.actor = 'system'
          AND turn.entry_kind = 'conversation' AND turn.message_type = 'system'
          AND fact.run_id = ?`,
      input.turnId,
      input.runId,
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
