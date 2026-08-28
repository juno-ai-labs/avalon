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
import { WorkstreamMessageStorage } from "./workstream-message-storage";
import {
  type PreparedWorkstreamMessageRecord,
  WorkstreamTranscriptStorage,
} from "./workstream-transcript-storage";

/** What a caller proved before it was allowed to write. */
export interface AttemptFence {
  runId: string;
  attemptId: string;
  owner: string;
  /** The instant the caller is asking about; a lease is live relative to it. */
  now: number;
}

export interface PublishFinalMessageInput extends AttemptFence {
  messageId: string;
  text: string;
  hostOutcomeStatus: string;
  eventPayloadJson: string;
  lifecycleEventId: string;
  /** A stopped run may still publish: the member asked it to stop, not to vanish. */
  allowCancellationRequested: boolean;
  /**
   * The accepted assistant turn this aggregate is expected to repeat, or null
   * when the run accepted none. Checked rather than trusted — see
   * `acceptedTurnAlreadyCarries`.
   */
  answeredByTurnId: string | null;
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
export const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "needs_input",
  "failed",
  "cancelled",
]);

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
      reason: "depth_limit" | "chain_budget_exhausted";
    }
  /** The parent has no frozen scope, so there is nothing to narrow from. */
  | { outcome: "parent_scope_missing" }
  | { outcome: "ownership_lost" };

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
/**
 * The run statuses that mean a run is busy, as SQL.
 *
 * The retired `_runtime_harness_runs` view projected `waiting` and `steering`
 * onto `running`, so every routed predicate these fences replace accepted all
 * three. `docs/workstream-durable-object.md` carries the rule an earlier slice
 * wrote after review caught the same narrowing in the receipt and
 * block-dashboard fences: a new fence written against `runs.status` decides the
 * same question, and `running` alone is the wrong default — a busy run is any
 * of the three.
 *
 * Nothing writes `waiting` or `steering` today, so every one of these reads the
 * same as `= 'running'` would. It is spelled out because the directions are not
 * equally safe: a fence that does not recognise a status refuses, and every
 * refusal here is reported as a lost lease or an unsupervised child — the two
 * answers nobody investigates, because they are the expected ones. If the
 * product settles on a single busy status, retire the other two from the CHECK
 * constraint rather than from the fences.
 */
const BUSY_RUN_STATUSES = `('running', 'waiting', 'steering')`;

/** The same three, for a fence that reads a row rather than filtering in SQL. */
const BUSY_RUN_STATUS_SET = new Set(["running", "waiting", "steering"]);

/** The same set, plus the status a claimed-but-unlaunched run still holds. */
const OPEN_RUN_STATUSES = `('admitted', 'running', 'waiting', 'steering')`;

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
  | { outcome: "exists" }
  /**
   * A mutating run still holds the work stream's main substream.
   *
   * Distinct from `stale`: the caller's view of "newest" was right, and the
   * incumbent has been asked to stop — it simply has not stopped yet.
   */
  | { outcome: "busy" };

/** One attempt's frozen memory recall. */
export interface MemoryContextRow extends Record<string, SqlStorageValue> {
  run_id: string;
  attempt_id: string;
  memory_scope_ids_json: string;
  query_text: string;
  retrieval_mode: string;
  results_json: string;
  memory_context_hash: string;
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
  chain_depth: number;
  delegated_task_hash: string | null;
  inherited_scope_hash: string | null;
  child_result_json: string | null;
  child_result_hash: string | null;
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
  completed_at, final_part_id, error_json, workflow_instance_id, chain_root_run_id,
  chain_depth, delegated_task_hash, inherited_scope_hash, child_result_json,
  child_result_hash`;

function first<T>(cursor: SqlStorageCursor<T extends Record<string, SqlStorageValue> ? T : never>) {
  return cursor.toArray()[0];
}

/**
 * Give a replacement SubstreamAgent the attempts its predecessor owned.
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
 * HyperSight roots are deliberately excluded: their executor is a separate
 * BlockDashboardAgent, so this object's restart says nothing about whether
 * that owner is alive. Descendants of a local root are included so the resumed
 * parent can reclaim the same child attempt when it reaches that tool call.
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
          AND origin != 'block_dashboard_block'
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
                 AND origin != 'block_dashboard_block'
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
                 AND origin != 'block_dashboard_block'
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

export class WorkstreamHarnessRunStorage {
  /**
   * The transcript authority, over this same object storage.
   *
   * Composed rather than reimplemented, because publishing a run's final
   * message is one transaction that has to touch two authorities' tables. The
   * decision is this one's — whether the attempt may still speak — and the
   * transcript row belongs to the class that owns `workstream_message_records`,
   * so that record still has exactly one writer. Both wrap the same
   * `DurableObjectStorage`, so the
   * nested `transactionSync` is the same transaction rather than a second one.
   */
  private readonly messages: WorkstreamMessageStorage;

  /**
   * The turn projection, over that same object storage, for the one question
   * publishing an aggregate has to ask of it: is this answer already in the
   * feed?
   */
  private readonly transcript: WorkstreamTranscriptStorage;

  constructor(private readonly storage: DurableObjectStorage) {
    this.messages = new WorkstreamMessageStorage(storage);
    this.transcript = new WorkstreamTranscriptStorage(storage);
  }

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
                   AND active.status IN ${BUSY_RUN_STATUSES}
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
          activeLeaseExpiresAt: this.activeLeaseExpiresAt(claimed.origin),
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
   * uses.
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
  private activeLeaseExpiresAt(origin: string): number | null {
    const row = first(this.sql.exec<{ lease_expires_at: number | null } & Record<string, SqlStorageValue>>(
      `SELECT MAX(lease_expires_at) AS lease_expires_at FROM runs
        WHERE (? = 'block_dashboard_block' OR origin != 'block_dashboard_block')
          AND parent_tool_call_id IS NULL
          AND status IN ${BUSY_RUN_STATUSES} AND terminalized_at IS NULL`,
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
    startedAt: number;
    now: number;
  }): { outcome: "launched" | "not_found" } {
    return this.storage.transactionSync(() => {
      const run = this.run({ runId: input.runId });
      if (!run) return { outcome: "not_found" as const };
      this.sql.exec(
        `UPDATE runs
            SET workflow_instance_id = ?2,
                status = CASE WHEN status = 'admitted' THEN 'running' ELSE status END,
                started_at = CASE WHEN started_at = 0 THEN ?3 ELSE started_at END,
                updated_at = ?4
          WHERE run_id = ?1`,
        input.runId,
        input.workflowInstanceId,
        input.startedAt,
        input.now,
      );
      if (run.origin !== "block_dashboard_block") {
        this.sql.exec(
          `UPDATE workstream
              SET exact_state = 'running',
                  state_reason_code = 'runtime_running',
                  state_changed_at = ?1,
                  updated_at = ?1
            WHERE id = 1 AND exact_state = 'scheduled'`,
          input.now,
        );
      }
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
        `UPDATE runs SET usage_json = ?2, model = COALESCE(?3, model), updated_at = ?4
          WHERE run_id = ?1`,
        input.runId,
        input.usageJson,
        input.model,
        input.now,
      );
      return { outcome: "recorded" as const };
    });
  }

  /**
   * The newest root run a member would recognise as "this conversation's".
   *
   * HyperSight blocks are excluded for the reason the claim excludes them: they
   * run beside the conversation rather than being it. Three callers ask this —
   * two to find the run they should be reconciling, and `admitRun` to decide
   * whether the caller's view of "newest" is still true.
   */
  latestRootRun(): RunRow | undefined {
    return first(this.sql.exec<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM runs
        WHERE parent_tool_call_id IS NULL AND origin != 'block_dashboard_block'
        ORDER BY created_at DESC, run_id DESC LIMIT 1`,
    ));
  }

  /** Whether a run is still on its way to a terminal state. */
  runIsActive(input: { runId: string }): boolean {
    const run = this.run({ runId: input.runId });
    return run !== undefined && ["admitted", "running", "waiting", "steering"].includes(run.status);
  }

  /** The transcript part that triggered a run, if it recorded one. */
  triggerPartId(input: { runId: string }): string | null {
    return first(this.sql.exec<{ trigger_part_id: string | null } & Record<string, SqlStorageValue>>(
      `SELECT trigger_part_id FROM runs WHERE run_id = ?`,
      input.runId,
    ))?.trigger_part_id ?? null;
  }

  /**
   * Mark a run failed because its Workflow never started.
   *
   * No lease fence, because there is no attempt yet — this is the launch itself
   * failing, and the row it is closing is the one the same caller created a
   * moment ago. `terminalizeQueuedRun` is the fenced path for a run that was
   * admitted and then abandoned; this is narrower and deliberately unguarded.
   *
   * The sidebar goes through `settleWorkstreamState` like every other ending,
   * which adds a guard the routed version did not have: it will not report
   * `failed` over a work stream some *other* live run still holds. That case is
   * unreachable from here today — this path runs immediately after an admission
   * that superseded everything else — so the guard changes nothing now and is
   * correct if that ever stops being true.
   */
  failUnlaunchedRun(input: {
    runId: string;
    errorJson: string;
    now: number;
  }): { outcome: "failed" | "not_found" } {
    return this.storage.transactionSync(() => {
      if (!this.run({ runId: input.runId })) return { outcome: "not_found" as const };
      this.sql.exec(
        `UPDATE runs SET status = 'failed', completed_at = ?2, error_json = ?3, updated_at = ?2
          WHERE run_id = ?1`,
        input.runId,
        input.now,
        input.errorJson,
      );
      this.settleWorkstreamState(input.runId, "failed", input.now);
      return { outcome: "failed" as const };
    });
  }

  /**
   * The run's frozen memory recall, if this caller holds it and one exists.
   *
   * The routed version joined `harness_runs` to prove the lease was live, which
   * made "no context yet" and "you lost the run" the same empty result. They
   * still collapse here — the caller's next step is the same either way, and
   * `persistMemoryContext` is where a lost lease is actually refused — but the
   * fence is now read rather than joined.
   *
   * **Keyed by run, not by attempt, and so is the write.** The table is
   * `PRIMARY KEY (run_id)`: there has never been a second row for a second
   * attempt to find. The routed read filtered on `attempt_id` anyway, so a
   * retrying attempt missed this fast path, paid a full vector search, and then
   * threw the result away when the insert came back with the first attempt's
   * row. Freezing recall exists so every attempt of a run sees the same
   * memories — which makes that row this attempt's answer, and looking for it
   * under this attempt's id a way of not finding what is already there.
   */
  memoryContext(input: AttemptFence): MemoryContextRow | undefined {
    if (this.attemptOwnership(input).outcome !== "owned") return undefined;
    return first(this.sql.exec<MemoryContextRow>(
      `SELECT run_id, attempt_id, memory_scope_ids_json, query_text, retrieval_mode,
              results_json, memory_context_hash, created_at
         FROM run_memory_contexts WHERE run_id = ?`,
      input.runId,
    ));
  }

  /**
   * Freeze what memory this attempt recalled, or hand back what won the race.
   *
   * `persistScope`'s shape for a different table, with one difference: the
   * value being written costs a vector search to compute, so the read and the
   * write cannot be one operation. A loser therefore gets the winner's row back
   * rather than an outcome to interpret — the whole point of freezing recall is
   * that every replay of this attempt sees the same memories, so returning the
   * row the run will actually use is the only useful answer.
   */
  persistMemoryContext(input: AttemptFence & {
    memoryScopeIdsJson: string;
    queryText: string;
    retrievalMode: string;
    resultsJson: string;
    memoryContextHash: string;
  }): { outcome: "persisted" | "reused"; row: MemoryContextRow } | { outcome: "ownership_lost" } {
    return this.storage.transactionSync(() => {
      const existing = first(this.sql.exec<MemoryContextRow>(
        `SELECT run_id, attempt_id, memory_scope_ids_json, query_text, retrieval_mode,
                results_json, memory_context_hash, created_at
           FROM run_memory_contexts WHERE run_id = ?`,
        input.runId,
      ));
      if (existing) return { outcome: "reused" as const, row: existing };
      if (this.attemptOwnership(input).outcome !== "owned") {
        return { outcome: "ownership_lost" as const };
      }
      this.sql.exec(
        `INSERT INTO run_memory_contexts
           (run_id, attempt_id, memory_scope_ids_json, query_text, retrieval_mode,
            results_json, memory_context_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        input.runId,
        input.attemptId,
        input.memoryScopeIdsJson,
        input.queryText,
        input.retrievalMode,
        input.resultsJson,
        input.memoryContextHash,
        input.now,
      );
      return {
        outcome: "persisted" as const,
        row: {
          run_id: input.runId,
          attempt_id: input.attemptId,
          memory_scope_ids_json: input.memoryScopeIdsJson,
          query_text: input.queryText,
          retrieval_mode: input.retrievalMode,
          results_json: input.resultsJson,
          memory_context_hash: input.memoryContextHash,
          created_at: input.now,
        },
      };
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

  /** The sub-agent admitted for one of a parent's tool calls, or nothing. */
  inlineChildByToolCall(input: {
    parentRunId: string;
    parentToolCallId: string;
  }): RunRow | undefined {
    return first(this.sql.exec<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM runs
        WHERE parent_run_id = ? AND parent_tool_call_id = ?`,
      input.parentRunId,
      input.parentToolCallId,
    ));
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
   * **There is no concurrency cap on delegated children, deliberately.** The
   * routed version had one, spelled `active_child.workspace_id =
   * parent.workspace_id` and configured as
   * `HARNESS_CHILD_MAX_ACTIVE_WORKSPACE_RUNS` — but it ran against a view of
   * this object's rows alone, where that comparison is true for everything it
   * can see, so it had silently been per-work-stream since the
   * per-workspace-database cutover and enforced nothing the chain budget did
   * not already imply. It was removed rather than renamed. `maxChainRuns` is
   * now the only bound on fan-out, and it is a *lifetime* budget: a chain may
   * create that many runs in total, which caps concurrency at the same number
   * without needing a second limit that frees slots as children settle.
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
    lifecycleEventId: string;
    now: number;
  }): InlineChildAdmissionOutcome {
    return this.storage.transactionSync(() => {
      const parent = this.run({ runId: input.parentRunId });
      if (!parent
        || parent.legacy_attempt_id !== input.parentAttemptId
        || parent.lease_owner !== input.parentOwner
        || !BUSY_RUN_STATUS_SET.has(parent.status)
        || parent.terminalized_at !== null
        || parent.lease_expires_at === null
        || parent.lease_expires_at <= input.now) {
        return { outcome: "ownership_lost" as const };
      }
      // Cancellation is answered separately, and only once the rest of the
      // fence has held. The routed version reached this through
      // `assertHarnessAttemptOwned`, which threw `RunCancelledError` here —
      // folding it into `ownership_lost` tells a member who pressed stop that
      // their run "was superseded by another executor", which is not what
      // happened. A parent that still holds its lease and has been asked to
      // stop is a person stopping the work.
      if (parent.cancellation_requested_at !== null) {
        return { outcome: "cancelled" as const };
      }
      if (!this.scope({ runId: input.parentRunId })) {
        return { outcome: "parent_scope_missing" as const };
      }

      const existing = this.inlineChildByToolCall(input);
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
        // Busy before cancelled, as the routed version answered it. A child
        // under a live lease is still going to write a result, and `busy` is
        // what makes its parent wait for one; answering `cancelled` first
        // abandons a result that is about to exist.
        if (existing.lease_expires_at !== null && existing.lease_expires_at > input.now) {
          return {
            outcome: "busy" as const,
            childRunId: existing.run_id,
            leaseExpiresAt: existing.lease_expires_at,
          };
        }
        if (existing.cancellation_requested_at !== null) return { outcome: "cancelled" as const };
        if (!BUSY_RUN_STATUS_SET.has(existing.status)
          || existing.legacy_attempt_id === null
          || existing.lease_owner === null) {
          return { outcome: "ownership_lost" as const };
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

      // A delegated child owns its own substream. Sharing the parent's would
      // violate `runs_mutating_substream_uq`, which allows one mutating run per
      // substream — the child would be a UNIQUE failure rather than a sub-agent.
      const substreamId = `run:${input.childRunId}`;
      this.sql.exec(
        `INSERT OR IGNORE INTO substreams
           (id, kind, inherit_mode, inherit_from_substream_id, inherit_fence_seq, depth,
            return_mode, origin_message_id, owner_user_id, audience, tool_policy, status, created_at)
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
   * Publish this attempt's final message, and record that it did.
   *
   * The last of the guarded batches, and the only one that spanned two
   * authorities. Three statements: the transcript insert, a lifecycle event
   * that `JOIN`ed `messages` to check the insert had landed, and a work-stream
   * update whose `EXISTS (SELECT 1 FROM messages …)` checked the same thing
   * again. Both checks exist because a D1 batch cannot branch on its own
   * progress; inside one transaction there is nothing to check.
   *
   * The third statement turns out to have done nothing at all. It assigned
   * `latest_attention_sequence_number`, which was never a column — the retired
   * view derived it as `next_attention_ordinal - 1` and its update trigger
   * ignored every caller that assigned to it. What remains of that statement is
   * `last_activity_at` and `updated_at`, which is exactly what `appendMessage`
   * already moves.
   *
   * The sequence number is allocated here rather than passed in. The caller
   * used to reserve one first through a bespoke `UPDATE workstreams SET
   * next_sequence_number = next_sequence_number + 1 … RETURNING` rewrite, which
   * burned a number whenever the write was then refused; taking it inside the
   * transaction that uses it cannot.
   *
   * `status` on the lifecycle event is the *published* spelling, unlike the
   * `terminal` event's. That is deliberate and load-bearing: this event records
   * the host outcome the caller reported, and recovery reads it back and
   * compares it against the published terminal set. The `terminal` event
   * records the run's own state, which is the object's vocabulary.
   */
  async prepareFinalMessage(
    input: PublishFinalMessageInput,
  ): Promise<PreparedWorkstreamMessageRecord> {
    return this.messages.prepareMessage({
      messageId: input.messageId,
      clientMessageId: `harness:${input.runId}`,
      authorType: "agent",
      authorUserId: null,
      externalActorJson: null,
      messageType: "text",
      text: input.text,
      structuredContentJson: null,
      producedByRunId: input.runId,
      now: input.now,
    });
  }

  async publishFinalMessage(input: PublishFinalMessageInput): Promise<
    { outcome: "published" | "replayed"; sequenceNumber: number }
    | { outcome: "ownership_lost" }
  > {
    const prepared = await this.prepareFinalMessage(input);
    return this.storage.transactionSync(() => this.publishPreparedFinalMessage(input, prepared));
  }

  publishPreparedFinalMessage(
    input: PublishFinalMessageInput,
    prepared: PreparedWorkstreamMessageRecord,
  ): { outcome: "published" | "replayed"; sequenceNumber: number }
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
      // Two different rows, chosen by whether the feed already shows this
      // answer. When the closing turn carries it, the aggregate is bookkeeping
      // and takes no feed row; when nothing carries it — a grounding-guard
      // notice, a run cut short before any turn was accepted — the aggregate is
      // the only copy the member gets, and keeps its own.
      const appended = input.answeredByTurnId !== null
        && this.transcript.acceptedTurnAlreadyCarries({
          turnId: input.answeredByTurnId,
          text: input.text,
        })
        ? this.messages.appendPreparedRunAggregateMessage(prepared)
        : this.messages.appendPreparedMessage(prepared);
      this.recordLifecycleEvent({
        eventId: input.lifecycleEventId,
        runId: input.runId,
        attemptId: input.attemptId,
        eventKey: "final_message",
        eventType: "final_message_persisted",
        status: input.hostOutcomeStatus,
        memberSafePayloadJson: input.eventPayloadJson,
        now: input.now,
      });
      return {
        outcome: appended.outcome === "appended" ? "published" as const : "replayed" as const,
        sequenceNumber: appended.sequenceNumber,
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
    status: string;
    finalPartId: string | null;
    model: string | null;
    usageJson: string | null;
    errorJson: string | null;
    memberSafePayloadJson: string;
    lifecycleEventId: string;
    receiptMarkerEventKey: string;
  }): TerminalizeOutcome {
    return this.storage.transactionSync(() => {
      const run = this.run({ runId: input.runId });
      if (!run || run.parent_tool_call_id !== null) return { outcome: "not_found" as const };
      const stopping = input.status === "cancelled";
      const stoppingRecoveredAttempt = stopping
        && run.cancellation_requested_at !== null
        && run.lease_owner === previousInstanceRecoveryOwner(input.attemptId);
      if (run.legacy_attempt_id === input.attemptId
        && run.terminalized_at !== null
        && run.status === input.status) {
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
        || (!stopping && run.cancellation_requested_at !== null)
        || run.lease_expires_at === null
        || (run.lease_expires_at <= input.now && !stoppingRecoveredAttempt)) {
        return { outcome: "ownership_lost" as const };
      }

      this.recordLifecycleEvent({
        eventId: input.lifecycleEventId,
        runId: input.runId,
        attemptId: input.attemptId,
        eventKey: "terminal",
        eventType: "terminal",
        status: input.status,
        memberSafePayloadJson: input.memberSafePayloadJson,
        now: input.now,
      });
      this.sql.exec(
        `UPDATE runs
            SET status = ?2, completed_at = ?3, terminalized_at = ?3, final_part_id = ?4,
                model = COALESCE(?5, model), usage_json = COALESCE(?6, usage_json),
                error_json = ?7, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?3
          WHERE run_id = ?1`,
        input.runId,
        input.status,
        input.now,
        input.finalPartId,
        input.model,
        input.usageJson,
        input.errorJson,
      );
      if (run.origin !== "block_dashboard_block") this.settleWorkstreamState(input.runId, input.status, input.now);
      this.cancelDescendants({
        rootRunId: input.runId,
        reason: "parent_terminalized",
        now: input.now,
      });
      return { outcome: "terminalized" as const };
    });
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
    blockOnly: boolean;
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
          AND (?1 = 0 OR run.parent_tool_call_id IS NOT NULL OR run.origin = 'block_dashboard_block')
          AND NOT EXISTS (
            SELECT 1 FROM run_lifecycle_events settled
             WHERE settled.run_id = run.run_id
               AND settled.attempt_id = run.legacy_attempt_id
               AND settled.event_key = ?2
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
        LIMIT ?3`,
      input.blockOnly ? 1 : 0,
      input.markerEventKey,
      input.limit,
    ).toArray();
  }

  /**
   * Root runs whose lease has run out.
   *
   * Ordinary attempts are the only runs whose expired lease is itself a
   * terminal condition. A sub-agent is deliberately reclaimable while its
   * parent still owns a live attempt, so including children here would race
   * their idempotent takeover path — `reapableInlineChildren` asks the
   * narrower question instead.
   */
  //
  // This pass is the only recovery for an executor that died without
  // terminalizing at all, and nothing schedules it: `reapStaleHarnessRuns` is
  // called from one place, immediately before a new attempt is claimed
  // (`substream-agent.ts`, and its BlockDashboard twin). A work stream nobody
  // sends another message to therefore keeps such a run `running` and its tool
  // card spinning indefinitely. Closing that needs the object to wake on its
  // own expired lease, which is a wake reason and belongs to
  // `docs/durable-object-alarms.md` rather than to this operation.
  staleLeaseRuns(input: {
    blockOnly: boolean;
    now: number;
    limit: number;
  }): StaleRunRow[] {
    return this.sql.exec<StaleRunRow>(
      `SELECT run_id, legacy_attempt_id AS attempt_id, lease_owner, lease_expires_at,
              origin, parent_run_id, parent_tool_call_id, cancellation_requested_at
         FROM runs
        WHERE status IN ${BUSY_RUN_STATUSES} AND terminalized_at IS NULL
          AND parent_tool_call_id IS NULL
          AND legacy_attempt_id IS NOT NULL AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?1
          AND (?2 = 0 OR origin = 'block_dashboard_block')
        ORDER BY lease_expires_at ASC
        LIMIT ?3`,
      input.now,
      input.blockOnly ? 1 : 0,
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
        || run.legacy_attempt_id !== input.attemptId
        || run.lease_expires_at !== input.leaseExpiresAt
        || run.status !== "running"
        || run.terminalized_at !== null) {
        return { outcome: "not_stale" as const };
      }
      this.recordLifecycleEvent({
        eventId: input.lifecycleEventId,
        runId: input.runId,
        attemptId: input.attemptId,
        eventKey: "terminal",
        eventType: "terminal",
        status: "failed",
        memberSafePayloadJson: '{"code":"stale_run_reaped"}',
        now: input.now,
      });
      this.sql.exec(
        `UPDATE runs
            SET status = 'failed', completed_at = ?2, terminalized_at = ?2,
                error_json = '{"code":"stale_run_reaped","message":"The prior executor lost its durable lease"}',
                lease_owner = NULL, lease_expires_at = NULL, updated_at = ?2
          WHERE run_id = ?1`,
        input.runId,
        input.now,
      );
      if (run.origin !== "block_dashboard_block") {
        this.settleWorkstreamState(input.runId, "failed", input.now);
      }
      this.cancelDescendants({
        rootRunId: input.runId,
        reason: "parent_stale_run_reaped",
        now: input.now,
      });
      return { outcome: "reaped" as const };
    });
  }

  /**
   * Sub-agents whose own lease expired *and* whose parent can no longer supervise.
   *
   * A stale child beneath a live parent is deliberately omitted: the same
   * parent tool call can reclaim its durable attempt, and reaping it here would
   * race that. The routed version spelled this parent test three times — once
   * in the scan and twice more inside the batch that acted on it — because a
   * batch cannot carry a decision between its statements.
   */
  reapableInlineChildren(input: { now: number; limit: number }): StaleRunRow[] {
    return this.sql.exec<StaleRunRow>(
      `SELECT child.run_id, child.legacy_attempt_id AS attempt_id, child.lease_owner,
              child.lease_expires_at, child.origin, child.parent_run_id,
              child.parent_tool_call_id, child.cancellation_requested_at
         FROM runs child
        WHERE child.status IN ${BUSY_RUN_STATUSES} AND child.terminalized_at IS NULL
          AND child.parent_run_id IS NOT NULL
          AND child.parent_tool_call_id IS NOT NULL
          AND child.legacy_attempt_id IS NOT NULL AND child.lease_owner IS NOT NULL
          AND child.lease_expires_at IS NOT NULL
          AND child.lease_expires_at <= ?1
          AND (
            child.cancellation_requested_at IS NOT NULL
            OR NOT EXISTS (
              SELECT 1 FROM runs parent
               WHERE parent.run_id = child.parent_run_id
                 AND parent.status IN ${BUSY_RUN_STATUSES} AND parent.terminalized_at IS NULL
                 AND parent.cancellation_requested_at IS NULL
                 AND parent.legacy_attempt_id IS NOT NULL AND parent.lease_owner IS NOT NULL
                 AND parent.lease_expires_at > ?1
            )
          )
        ORDER BY child.lease_expires_at ASC
        LIMIT ?2`,
      input.now,
      input.limit,
    ).toArray();
  }

  /**
   * End a sub-agent its parent can no longer supervise, storing its result.
   *
   * The parent test is re-run here rather than trusted from the scan, because
   * a parent that heartbeats in between is supervising again and its child must
   * be left alone. In the routed version that re-check was the same `NOT
   * EXISTS` block pasted into two statements, with `child.` rewritten to
   * `harness_runs.` in one of them by string replacement.
   */
  reapStaleInlineChild(input: {
    runId: string;
    attemptId: string;
    owner: string;
    leaseExpiresAt: number;
    status: string;
    errorJson: string | null;
    childResultJson: string;
    childResultHash: string;
    memberSafePayloadJson: string;
    lifecycleEventId: string;
    now: number;
  }): { outcome: "reaped" | "not_stale" } {
    return this.storage.transactionSync(() => {
      const child = this.run({ runId: input.runId });
      if (!child
        || child.parent_run_id === null
        || child.parent_tool_call_id === null
        || child.legacy_attempt_id !== input.attemptId
        || child.lease_owner !== input.owner
        || child.lease_expires_at !== input.leaseExpiresAt
        || child.lease_expires_at > input.now
        || child.status !== "running"
        || child.terminalized_at !== null
        || !this.parentCannotSupervise(child, input.now)) {
        return { outcome: "not_stale" as const };
      }
      this.recordLifecycleEvent({
        eventId: input.lifecycleEventId,
        runId: input.runId,
        attemptId: input.attemptId,
        eventKey: "terminal",
        eventType: "terminal",
        status: input.status,
        memberSafePayloadJson: input.memberSafePayloadJson,
        now: input.now,
      });
      this.sql.exec(
        `UPDATE runs
            SET status = ?2, completed_at = ?3, terminalized_at = ?3, error_json = ?4,
                child_result_json = ?5, child_result_hash = ?6,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = ?3
          WHERE run_id = ?1`,
        input.runId,
        input.status,
        input.now,
        input.errorJson,
        input.childResultJson,
        input.childResultHash,
      );
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
   * Create a root run, optionally superseding whatever is running now.
   *
   * Four callers built this out of the same routed batch — a conditional
   * supersede, an `INSERT … SELECT … WHERE ? = (SELECT latest.id …)` whose
   * subquery *was* the staleness check, and a sidebar update guarded on
   * `EXISTS (SELECT 1 FROM harness_runs WHERE id = ?)` to ask whether the
   * insert had landed. The staleness check is the interesting one: expressed as
   * a subquery inside the insert it could only answer by writing nothing, which
   * is also what a duplicate id does, so the caller could not tell "someone
   * else got here first" from "this is a retry of my own request".
   *
   * `expectedLatestRunId` is how a caller says which run it believed was
   * newest. Null means it does not care — a scheduled or automation run is not
   * racing a member.
   */
  admitRun(input: {
    runId: string;
    origin: string;
    executionPrincipalJson: string;
    status: string;
    startedAt: number | null;
    model: string | null;
    triggerPartId: string | null;
    parentRunId: string | null;
    supersedeActive: boolean;
    expectedLatestRunId: string | null;
    now: number;
  }): AdmitRunOutcome {
    return this.storage.transactionSync(() => {
      if (this.run({ runId: input.runId })) return { outcome: "exists" as const };
      if (input.expectedLatestRunId !== null
        && this.latestRootRun()?.run_id !== input.expectedLatestRunId) {
        return { outcome: "stale" as const };
      }
      if (input.supersedeActive) {
        this.sql.exec(
          `UPDATE runs
              SET cancellation_requested_at = COALESCE(cancellation_requested_at, ?1),
                  cancellation_reason = COALESCE(cancellation_reason, 'superseded_by_follow_up'),
                  updated_at = ?1
            WHERE origin != 'block_dashboard_block'
              AND parent_tool_call_id IS NULL
              AND status IN ${OPEN_RUN_STATUSES}
              AND terminalized_at IS NULL`,
          input.now,
        );
      }
      // `runs_mutating_substream_uq` allows one mutating run per substream, and
      // every root run shares substream '0'. Asking first is not defensive
      // tidiness: the insert would throw, and a throw takes the whole
      // transaction with it — including the supersede just above, so a
      // superseding message would neither start its run nor stop the one it
      // meant to replace.
      //
      // A supersede does not clear the way by itself. It stamps
      // `cancellation_requested_at` and leaves the incumbent `running` until
      // that run notices and terminalizes, so the collision is *most* likely in
      // exactly the case supersede exists for. The retired
      // `_runtime_harness_runs_insert` trigger hid this behind `INSERT OR
      // IGNORE`, which turned it into a zero-change result the caller reported
      // as a stale request; this says which of the two it was.
      if (this.mutatingRunHoldsSubstream(input.status, input.origin)) {
        return { outcome: "busy" as const };
      }
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
      if (input.status === "running" && input.origin !== "block_dashboard_block") {
        this.markWorkstreamRunning(input.now);
      }
      return { outcome: "admitted" as const };
    });
  }

  /**
   * Whether inserting this run would collide with the one-mutating-run index.
   *
   * Mirrors `runs_mutating_substream_uq` exactly, including its
   * block-dashboard exemption — a block run is outside the index on both
   * sides, so it neither collides nor blocks.
   */
  private mutatingRunHoldsSubstream(status: string, origin: string): boolean {
    if (origin === "block_dashboard_block") return false;
    if (!["running", "waiting", "steering"].includes(status)) return false;
    return (first(this.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count FROM runs
        WHERE substream_id = '0'
          AND origin != 'block_dashboard_block'
          AND status IN ('running', 'waiting', 'steering')`,
    ))?.count ?? 0) > 0;
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
   * all, because this is how a queued run dies when its executor never arrived
   * — a rejected admission, a Workflow that failed to start. It still stamps an
   * attempt id, so the terminal event and the run agree on who ended it and a
   * retry of the same identity is a replay rather than a second ending.
   */
  terminalizeQueuedRun(input: {
    runId: string;
    attemptId: string;
    status: string;
    errorJson: string | null;
    memberSafePayloadJson: string;
    lifecycleEventId: string;
    now: number;
  }): { outcome: "terminalized" | "already_terminal" | "ownership_lost" | "not_found" } {
    return this.storage.transactionSync(() => {
      const run = this.run({ runId: input.runId });
      if (!run || run.parent_tool_call_id !== null) return { outcome: "not_found" as const };
      if (run.legacy_attempt_id === input.attemptId
        && run.status === input.status
        && run.terminalized_at !== null) {
        return { outcome: "already_terminal" as const };
      }
      if (run.legacy_attempt_id !== null
        || !["admitted", "running"].includes(run.status)
        || run.terminalized_at !== null) {
        return { outcome: "ownership_lost" as const };
      }
      this.recordLifecycleEvent({
        eventId: input.lifecycleEventId,
        runId: input.runId,
        attemptId: input.attemptId,
        eventKey: "terminal",
        eventType: "terminal",
        status: input.status,
        memberSafePayloadJson: input.memberSafePayloadJson,
        now: input.now,
      });
      this.sql.exec(
        `UPDATE runs
            SET legacy_attempt_id = ?2, attempt_epoch = attempt_epoch + 1,
                status = ?3, completed_at = ?4, terminalized_at = ?4, error_json = ?5,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = ?4
          WHERE run_id = ?1`,
        input.runId,
        input.attemptId,
        input.status,
        input.now,
        input.errorJson,
      );
      if (run.origin !== "block_dashboard_block") {
        this.settleWorkstreamState(input.runId, input.status, input.now);
      }
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
  private settleWorkstreamState(runId: string, status: string, now: number): void {
    const stillBusy = first(this.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count FROM runs
        WHERE run_id != ?
          AND origin != 'block_dashboard_block'
          AND parent_tool_call_id IS NULL
          AND status IN ('admitted', 'running', 'waiting', 'steering')
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
      `runtime_${state}`,
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
   * Settle a sub-agent, storing the result its parent will read back.
   *
   * The routed version was two statements where the second was guarded on the
   * first: the `UPDATE`'s `WHERE` carried `EXISTS (SELECT 1 FROM
   * harness_run_lifecycle_events WHERE lifecycle.id = ?1 …)` purely to ask
   * whether the batch's *own* first statement had landed. That is a
   * transaction spelled as a correlated subquery; here it is a transaction.
   *
   * `status === "cancelled"` relaxes the cancellation fence on both sides, and
   * deliberately: a stop is exactly the case where a live owner must still be
   * allowed to settle, or the parent waits forever on a child that will never
   * write its result. It is the same exemption `assertHarnessToolSettlementOwned`
   * makes for a tool call that had already started.
   */
  terminalizeInlineChild(input: {
    parentRunId: string;
    parentAttemptId: string;
    parentOwner: string;
    childRunId: string;
    childAttemptId: string;
    childOwner: string;
    status: string;
    model: string | null;
    usageJson: string | null;
    errorJson: string | null;
    childResultJson: string;
    childResultHash: string;
    memberSafePayloadJson: string;
    lifecycleEventId: string;
    now: number;
  }): { outcome: "terminalized" | "already_terminal" | "ownership_lost" } {
    return this.storage.transactionSync(() => {
      const child = this.run({ runId: input.childRunId });
      const parent = this.run({ runId: input.parentRunId });
      const stopping = input.status === "cancelled";
      if (child
        && child.legacy_attempt_id === input.childAttemptId
        && child.terminalized_at !== null
        && child.status === input.status
        && child.child_result_hash === input.childResultHash) {
        return { outcome: "already_terminal" as const };
      }
      if (!child
        || !parent
        || child.parent_run_id !== input.parentRunId
        || child.parent_tool_call_id === null
        || child.legacy_attempt_id !== input.childAttemptId
        || child.lease_owner !== input.childOwner
        || child.terminalized_at !== null
        || (!stopping && child.cancellation_requested_at !== null)
        || child.lease_expires_at === null
        || child.lease_expires_at <= input.now
        || parent.legacy_attempt_id !== input.parentAttemptId
        || parent.lease_owner !== input.parentOwner
        || parent.status !== "running"
        || parent.terminalized_at !== null
        || (!stopping && parent.cancellation_requested_at !== null)
        || parent.lease_expires_at === null
        || parent.lease_expires_at <= input.now) {
        return { outcome: "ownership_lost" as const };
      }
      this.recordLifecycleEvent({
        eventId: input.lifecycleEventId,
        runId: input.childRunId,
        attemptId: input.childAttemptId,
        eventKey: "terminal",
        eventType: "terminal",
        status: input.status,
        memberSafePayloadJson: input.memberSafePayloadJson,
        now: input.now,
      });
      this.sql.exec(
        `UPDATE runs
            SET status = ?2, completed_at = ?3, terminalized_at = ?3,
                model = COALESCE(?4, model), usage_json = COALESCE(?5, usage_json),
                error_json = ?6, child_result_json = ?7, child_result_hash = ?8,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = ?3
          WHERE run_id = ?1`,
        input.childRunId,
        input.status,
        input.now,
        input.model,
        input.usageJson,
        input.errorJson,
        input.childResultJson,
        input.childResultHash,
      );
      return { outcome: "terminalized" as const };
    });
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
