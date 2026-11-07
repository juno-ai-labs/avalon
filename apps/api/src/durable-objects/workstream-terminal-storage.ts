import { uuidV7 } from "../lib/uuid-v7";

/**
 * Object-local Terminal authority for one work stream.
 *
 * Every Terminal row a work stream owns — the sandbox generation, its command
 * tasks, imported-resource provenance, the selected repository, publication
 * grants and their receipts — lives in this object's SQLite database. This
 * module is the only thing that writes them, and the only thing outside the
 * object that reads them. `WorkstreamObjectProductService` reads
 * `terminal_workspace` directly for the directory projection's next-action
 * deadline; that read is in-object and deliberately not routed through here.
 *
 * It exists because the Terminal services previously reached the same rows by
 * preparing D1-shaped SQL against a routed handle: statements naming
 * `workstream_sandboxes` were rewritten onto `_runtime_terminal_workspace`, a
 * compatibility view whose INSTEAD OF triggers converted ISO-8601 strings to
 * unix milliseconds and packed nine lifecycle fields into a `lifecycle_json`
 * blob. That indirection was the price of running one body of code against
 * both D1 and the object during the cutover. D1 no longer holds these tables,
 * so the only thing the compatibility layer still bought was the ability to
 * keep writing the old vocabulary — at the cost of a schema in which
 * `archive_due_at` had no type, no CHECK, and no index because it was a JSON
 * key rather than a column.
 *
 * Timestamps here are unix milliseconds, which is the object's convention
 * everywhere except the dictation ticket columns. Callers that surface a time
 * to a person format it at their own edge.
 */

export type TerminalLifecycleState =
  | "absent" | "starting" | "running" | "stopping" | "stopped" | "archiving"
  | "archived" | "restoring" | "expiring" | "expired" | "failed";

/**
 * The run statuses that have yielded execution — used as `NOT IN` to find a
 * live holder.
 *
 * Named for what it contains rather than what it decides: the compatibility
 * view projected `admitted` as `scheduled` and both `waiting` and `steering`
 * as `running`, so the lease's liveness test read
 * `status IN ('scheduled', 'running', 'needs_input')`. Against the real column
 * that included `needs_input` even though an answer is admitted as a new run;
 * the yielded run does not resume execution or release this lease itself. A
 * yielded run's still-live Terminal task is checked separately below, because
 * `command_outcome_unknown` retains its named provider session for recovery.
 * Renaming this to `LIVE_RUN_STATUSES` and adding `'running'` would invert the
 * test, which is why the constant names the values it actually contains.
 */
export const TERMINAL_YIELDED_RUN_STATUS_LIST = ["needs_input", "completed", "failed", "cancelled"] as const;
const TERMINAL_YIELDED_RUN_STATUSES =
  `(${TERMINAL_YIELDED_RUN_STATUS_LIST.map((status) => `'${status}'`).join(", ")})`;

/** Existing Terminal operation-authority window, shared by cleanup claims. */
export const TERMINAL_OPERATION_LEASE_MS = 16 * 60_000;

/**
 * How often a live sandbox is asked what Daytona thinks it is.
 *
 * Applies to every lifecycle state except `stopped` and `archived`: a sandbox
 * that is running, or on its way somewhere, is the one whose provider state can
 * move without Rally having asked it to.
 */
export const TERMINAL_PROVIDER_OBSERVATION_INTERVAL_MS = 60_000;

/**
 * How often a stopped or archived sandbox is asked the same thing.
 *
 * It bounds how stale that sandbox's observation can get when a Daytona
 * webhook is missed; the webhook carries a change as it happens. The number is
 * the team's to move — why it is ten minutes is in the changelog of
 * docs/terminal-workspaces.md.
 */
export const TERMINAL_STOPPED_SANDBOX_OBSERVATION_INTERVAL_MS = 10 * 60_000;

export interface TerminalProviderObservation {
  sandboxId: string;
  generation: number;
  observedAt: number | null;
  nextObserveAt: number;
  state: string | null;
  recoverable: boolean | null;
  errorCode: string | null;
}

export interface TerminalSandboxRecord {
  lifecycleState: TerminalLifecycleState;
  stableName: string | null;
  sandboxId: string | null;
  generation: number;
  authorityFingerprint: string;
  appliedNetworkRevision: number;
  version: number;
  operationRunId: string | null;
  /**
   * The conversation the lease holder's run executes in, when that is not
   * this object's own; `null` for a holder whose run row is in this object.
   *
   * The liveness test on a holder reads `runs`, and a run that executes in
   * another conversation — a background agent using its owner's sandbox — has
   * no row here to read. This column is what tells the claim SQL not to treat
   * that absence as a yielded run, and tells the coordinator and the lifecycle
   * sweep which conversation to ask instead.
   */
  operationRunSubstreamId: string | null;
  operationLeaseExpiresAt: number | null;
  lifecycleClaimId: string | null;
  lifecycleClaimExpiresAt: number | null;
  lastCommandAt: number | null;
  idleExpiresAt: number | null;
  archiveDueAt: number | null;
  expireDueAt: number | null;
  finalDiffResourceId: string | null;
  failureCode: string | null;
  createdAt: number;
  updatedAt: number;
}

interface SandboxRow extends Record<string, SqlStorageValue> {
  lifecycle_state: string;
  stable_name: string | null;
  sandbox_id: string | null;
  generation: number;
  authority_fingerprint: string;
  applied_network_revision: number;
  version: number;
  operation_run_id: string | null;
  operation_run_substream_id: string | null;
  operation_lease_expires_at: number | null;
  lifecycle_claim_id: string | null;
  lifecycle_claim_expires_at: number | null;
  last_command_at: number | null;
  idle_expires_at: number | null;
  archive_due_at: number | null;
  expire_due_at: number | null;
  final_diff_resource_id: string | null;
  failure_code: string | null;
  created_at: number;
  updated_at: number;
}

const SANDBOX_COLUMNS = `lifecycle_state, stable_name, sandbox_id, generation,
  authority_fingerprint, applied_network_revision, version, operation_run_id,
  operation_run_substream_id,
  operation_lease_expires_at, lifecycle_claim_id, lifecycle_claim_expires_at,
  last_command_at, idle_expires_at, archive_due_at, expire_due_at,
  final_diff_resource_id, failure_code, created_at, updated_at`;

/**
 * Whether the lease holder is still running, as this object can tell.
 *
 * A holder that ran here is live while its `runs` row says so, whatever the
 * lease's deadline. A holder from another conversation has no row here, so
 * it is live while its lease is, and also while a command of its own on this
 * generation is unsettled: a command may run longer than the lease, and the
 * run that submitted it is the one that settles it, which it could not do
 * once the deadline had passed. The takeover fences read the unsettled task
 * for themselves, and a dead foreign holder's task is recovered through the
 * yielded-holder path, which asks that conversation rather than this predicate.
 */
const HOLDER_IS_LIVE = `(
  CASE WHEN workspace.operation_run_substream_id IS NULL
    THEN EXISTS (
      SELECT 1 FROM runs holder
       WHERE holder.run_id = workspace.operation_run_id
         AND holder.status NOT IN ${TERMINAL_YIELDED_RUN_STATUSES}
    )
    ELSE (
      workspace.operation_lease_expires_at > ?
      OR EXISTS (
        SELECT 1 FROM terminal_tasks own
         WHERE own.sandbox_generation = workspace.generation
           AND own.run_id = workspace.operation_run_id
           AND own.state IN ('submitting', 'running')
      )
    )
  END
)`;

function toSandbox(row: SandboxRow): TerminalSandboxRecord {
  return {
    lifecycleState: row.lifecycle_state as TerminalLifecycleState,
    stableName: row.stable_name,
    sandboxId: row.sandbox_id,
    generation: row.generation,
    authorityFingerprint: row.authority_fingerprint,
    appliedNetworkRevision: row.applied_network_revision,
    version: row.version,
    operationRunId: row.operation_run_id,
    operationRunSubstreamId: row.operation_run_substream_id,
    operationLeaseExpiresAt: row.operation_lease_expires_at,
    lifecycleClaimId: row.lifecycle_claim_id,
    lifecycleClaimExpiresAt: row.lifecycle_claim_expires_at,
    lastCommandAt: row.last_command_at,
    idleExpiresAt: row.idle_expires_at,
    archiveDueAt: row.archive_due_at,
    expireDueAt: row.expire_due_at,
    finalDiffResourceId: row.final_diff_resource_id,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface TerminalTaskRecord {
  taskId: string;
  runId: string;
  /** The run's conversation when it is not this object's own; `null` otherwise. */
  runSubstreamId: string | null;
  effectIntentId: string;
  sandboxGeneration: number;
  providerTaskName: string;
  providerTaskId: string | null;
  state: string;
  commandSha256: string;
  commandDeadlineAt: number;
  exitCode: number | null;
  terminationReason: string | null;
  stdoutHead: string;
  stdoutTail: string;
  stderrHead: string;
  stderrTail: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputResourceId: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

interface TaskRow extends Record<string, SqlStorageValue> {
  task_id: string;
  run_id: string;
  run_substream_id: string | null;
  effect_intent_id: string;
  sandbox_generation: number;
  provider_task_name: string;
  provider_task_id: string | null;
  state: string;
  command_sha256: string;
  command_deadline_at: number;
  exit_code: number | null;
  termination_reason: string | null;
  stdout_head: string;
  stdout_tail: string;
  stderr_head: string;
  stderr_tail: string;
  stdout_bytes: number;
  stderr_bytes: number;
  output_resource_id: string | null;
  started_at: number | null;
  completed_at: number | null;
}

function toTask(row: TaskRow): TerminalTaskRecord {
  return {
    taskId: row.task_id,
    runId: row.run_id,
    runSubstreamId: row.run_substream_id,
    effectIntentId: row.effect_intent_id,
    sandboxGeneration: row.sandbox_generation,
    providerTaskName: row.provider_task_name,
    providerTaskId: row.provider_task_id,
    state: row.state,
    commandSha256: row.command_sha256,
    commandDeadlineAt: row.command_deadline_at,
    exitCode: row.exit_code,
    terminationReason: row.termination_reason,
    stdoutHead: row.stdout_head,
    stdoutTail: row.stdout_tail,
    stderrHead: row.stderr_head,
    stderrTail: row.stderr_tail,
    stdoutBytes: row.stdout_bytes,
    stderrBytes: row.stderr_bytes,
    outputResourceId: row.output_resource_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export interface TerminalRepositoryRecord {
  connectionId: string;
  repositoryId: number;
  repositoryFullName: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  state: "selected" | "revoked";
  bootstrappedSandboxGeneration: number | null;
  readTokenExpiresAt: number | null;
  selectedByUserId: string;
  remoteAccess: "read_only" | "full_access";
}

interface RepositoryRow extends Record<string, SqlStorageValue> {
  connection_id: string;
  repository_id: number;
  repository_full_name: string;
  base_ref: string;
  base_sha: string;
  head_ref: string;
  state: string;
  bootstrapped_sandbox_generation: number | null;
  read_token_expires_at: number | null;
  selected_by_user_id: string;
  remote_access: string;
}

const REPOSITORY_COLUMNS = `connection_id, repository_id, repository_full_name, base_ref,
  base_sha, head_ref, state, bootstrapped_sandbox_generation, read_token_expires_at,
  selected_by_user_id, remote_access`;

function toRepository(row: RepositoryRow): TerminalRepositoryRecord {
  return {
    connectionId: row.connection_id,
    repositoryId: row.repository_id,
    repositoryFullName: row.repository_full_name,
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    headRef: row.head_ref,
    state: row.state as "selected" | "revoked",
    bootstrappedSandboxGeneration: row.bootstrapped_sandbox_generation,
    readTokenExpiresAt: row.read_token_expires_at,
    selectedByUserId: row.selected_by_user_id,
    remoteAccess: row.remote_access as "read_only" | "full_access",
  };
}

export interface TerminalPublicationGrantRecord {
  grantId: string;
  principalKey: string;
  repositoryFullName: string;
  baseRef: string;
  headRef: string;
}

export interface TerminalPublicationRecord {
  publishedSha: string | null;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  headRef: string;
  repositoryFullName: string;
  baseRef: string;
  title: string;
}

export interface TerminalImportedResourceRecord {
  resourceId: string;
  destinationPath: string;
  state: "planned" | "completed";
  /**
   * The conversation whose attachment authorized this import when it is not
   * this object's own; `null` otherwise. The revocation check reads the
   * import's standing from that conversation's links.
   */
  attachedSubstreamId: string | null;
}

function first<T>(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): T | null {
  const rows = cursor.toArray() as T[];
  return rows.length > 0 ? rows[0]! : null;
}

/** The single writer for one work stream's Terminal tables. */
export class WorkstreamTerminalStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  // ---------------------------------------------------------------- sandbox

  sandbox(): TerminalSandboxRecord | null {
    const row = first<SandboxRow>(this.sql.exec<SandboxRow>(
      `SELECT ${SANDBOX_COLUMNS} FROM terminal_workspace WHERE id = 1`,
    ));
    return row ? toSandbox(row) : null;
  }

  providerObservation(): TerminalProviderObservation | null {
    type ObservationRow = {
      sandbox_id: string; generation: number; observed_at: number | null;
      next_observe_at: number; state: string | null; recoverable: number | null;
      error_code: string | null;
    };
    const row = first<ObservationRow>(this.sql.exec<ObservationRow>(`SELECT o.sandbox_id, o.generation, o.observed_at, o.next_observe_at,
               o.state, o.recoverable, o.error_code
          FROM terminal_provider_observation o JOIN terminal_workspace w
            ON w.id = o.id AND w.sandbox_id = o.sandbox_id AND w.generation = o.generation
         WHERE o.id = 1`));
    return row ? {
      sandboxId: row.sandbox_id, generation: row.generation,
      observedAt: row.observed_at, nextObserveAt: row.next_observe_at,
      state: row.state, recoverable: row.recoverable === null ? null : row.recoverable === 1,
      errorCode: row.error_code,
    } : null;
  }

  /** Reserve ordering before crossing the provider boundary; never take a run lease. */
  beginProviderObservation(input: { sandboxId: string; generation: number }): string | null {
    const row = this.sandbox();
    if (!row || row.sandboxId !== input.sandboxId || row.generation !== input.generation) return null;
    const requestId = uuidV7();
    const now = Date.now();
    const interval = row.lifecycleState === "stopped" || row.lifecycleState === "archived"
      ? TERMINAL_STOPPED_SANDBOX_OBSERVATION_INTERVAL_MS
      : TERMINAL_PROVIDER_OBSERVATION_INTERVAL_MS;
    this.sql.exec(`INSERT INTO terminal_provider_observation
        (id, sandbox_id, generation, request_id, requested_at, next_observe_at)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        observed_at = CASE WHEN sandbox_id = excluded.sandbox_id AND generation = excluded.generation
          THEN observed_at ELSE NULL END,
        state = CASE WHEN sandbox_id = excluded.sandbox_id AND generation = excluded.generation
          THEN state ELSE NULL END,
        recoverable = CASE WHEN sandbox_id = excluded.sandbox_id AND generation = excluded.generation
          THEN recoverable ELSE NULL END,
        error_code = NULL, sandbox_id = excluded.sandbox_id, generation = excluded.generation,
        request_id = excluded.request_id, requested_at = excluded.requested_at,
        next_observe_at = excluded.next_observe_at`,
      input.sandboxId, input.generation, requestId, now, now + interval);
    return requestId;
  }

  /**
   * Change nothing, so the endpoint's commit republishes this sandbox's
   * lifecycle deadline to the directory.
   *
   * Rollout scaffolding. The lifecycle sweep calls it when a due directory
   * entry had nothing due behind it, which is what an entry stamped by the
   * version that projected the one-minute observation deadline looks like;
   * nothing else would move it. A projection whose hash has not moved is not
   * re-enqueued, so it costs nothing when the directory is already right.
   *
   * Remove it, its protocol entry and the sweep's call once this version has
   * run in every region for a day: every such entry came due within a minute
   * of its last check, so each has been swept and corrected by then. Without
   * it a stale entry is not silent — it keeps reporting as a Terminal stall.
   */
  republishDeadline(): null {
    return null;
  }

  /** Late reads cannot overwrite a newer read or a replacement generation. */
  settleProviderObservation(input: {
    sandboxId: string; generation: number; requestId: string;
    state: string | null; recoverable: boolean | null; errorCode: string | null;
  }): boolean {
    return first(this.sql.exec<{ id: number }>(`UPDATE terminal_provider_observation
      SET observed_at = CASE WHEN ? IS NULL THEN ? ELSE observed_at END,
          state = CASE WHEN ? IS NULL THEN ? ELSE state END,
          recoverable = CASE WHEN ? IS NULL THEN ? ELSE recoverable END,
          error_code = ?
      WHERE id = 1 AND sandbox_id = ? AND generation = ? AND request_id = ?
        AND EXISTS (SELECT 1 FROM terminal_workspace w WHERE w.id = 1
          AND w.sandbox_id = terminal_provider_observation.sandbox_id
          AND w.generation = terminal_provider_observation.generation)
      RETURNING id`, input.errorCode, Date.now(), input.errorCode, input.state,
      input.errorCode, input.recoverable === null ? null : Number(input.recoverable),
      input.errorCode, input.sandboxId, input.generation, input.requestId)) !== null;
  }

  /**
   * Reserve generation 1 for a work stream that has never run a Terminal tool.
   *
   * `INSERT OR IGNORE` rather than a existence check: two tools admitted in the
   * same run can reach this together, and the loser must observe the winner's
   * row instead of failing.
   */
  reserveFirstGeneration(input: {
    stableName: string;
    authorityFingerprint: string;
    networkRevision: number;
    runId: string;
    /** The holder's conversation when it is not this object's own; see the record. */
    runSubstreamId?: string | null;
    operationLeaseExpiresAt: number;
    idleExpiresAt: number;
    archiveDueAt: number;
    expireDueAt: number;
    now: number;
  }): TerminalSandboxRecord {
    return this.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT OR IGNORE INTO terminal_workspace
           (id, provider, sandbox_id, lifecycle_state, generation, stable_name,
            authority_fingerprint, applied_network_revision, version,
            operation_run_id, operation_run_substream_id, operation_lease_expires_at,
            last_command_at, idle_expires_at, archive_due_at, expire_due_at,
            created_at, updated_at)
         VALUES (1, 'daytona', NULL, 'starting', 1, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.stableName,
        input.authorityFingerprint,
        input.networkRevision,
        input.runId,
        input.runSubstreamId ?? null,
        input.operationLeaseExpiresAt,
        input.now,
        input.idleExpiresAt,
        input.archiveDueAt,
        input.expireDueAt,
        input.now,
        input.now,
      );
      const row = this.sandbox();
      if (!row) throw new Error("terminal_sandbox_reserve_failed");
      return row;
    });
  }

  /**
   * Take the work stream's exclusive Terminal operation lease for one run.
   *
   * The lease yields when it is unheld, already this run's, expired, or held by
   * a run that has yielded. Every takeover from another run is additionally
   * fenced on the absence of an unsettled Terminal task. A nominal command or
   * lease deadline is not proof that the provider process is quiescent.
   *
   * Whether the holder has yielded is read from this object's `runs` only for
   * a holder that ran here. A holder that ran in another conversation has no
   * row to read, so its lease holds until its deadline — or until the caller,
   * having asked that conversation and been told the run yielded, names it as
   * `yieldedForeignHolder`, which this statement then takes over from by exact
   * identity. A yielded run never resumes its lease, so that answer cannot go
   * stale between the read and this write.
   *
   * A lease is held for one tool call and released after it, so the claimant
   * is usually taking an unheld lease rather than its own back. The unsettled
   * task fence therefore ignores the claimant's own tasks: a run whose command
   * lost observation released the lease when the call failed, and reattaching
   * to that command on its retry is the one thing that can settle it. Another
   * run's unsettled task still holds the fence closed. The claim also stamps
   * `last_command_at`: with no run-long holder, it is what the lifecycle sweep
   * reads as "someone is using this sandbox".
   */
  claimOperation(input: {
    runId: string;
    /** The claimant's conversation when it is not this object's own; see the record. */
    runSubstreamId?: string | null;
    generation: number;
    leaseExpiresAt: number;
    now: number;
    yieldedForeignHolder?: { runId: string; substreamId: string } | null;
  }): TerminalSandboxRecord | null {
    return this.storage.transactionSync(() => {
      const claimed = first<{ operation_run_id: string }>(this.sql.exec(
        `UPDATE terminal_workspace
            SET operation_run_id = ?, operation_run_substream_id = ?,
                operation_lease_expires_at = ?, last_command_at = ?,
                version = version + 1, updated_at = ?
          WHERE id = 1 AND generation = ?
            AND lifecycle_claim_id IS NULL
            AND (
              operation_run_id = ?
              OR (
                NOT EXISTS (
                  SELECT 1 FROM terminal_tasks task
                   WHERE task.sandbox_generation = terminal_workspace.generation
                     AND task.state IN ('planned', 'submitting', 'running')
                     AND task.run_id <> ?
                )
                AND (
                  operation_run_id IS NULL
                  OR operation_lease_expires_at IS NULL
                  OR operation_lease_expires_at <= ?
                  OR (
                    operation_run_substream_id IS NULL
                    AND NOT EXISTS (
                      SELECT 1 FROM runs holder
                       WHERE holder.run_id = terminal_workspace.operation_run_id
                         AND holder.status NOT IN ${TERMINAL_YIELDED_RUN_STATUSES}
                    )
                  )
                  OR (operation_run_id = ? AND operation_run_substream_id = ?)
                )
              )
            )
          RETURNING operation_run_id`,
        input.runId,
        input.runSubstreamId ?? null,
        input.leaseExpiresAt,
        input.now,
        input.now,
        input.generation,
        input.runId,
        input.runId,
        input.now,
        input.yieldedForeignHolder?.runId ?? null,
        input.yieldedForeignHolder?.substreamId ?? null,
      ));
      return claimed ? this.sandbox() : null;
    });
  }

  /**
   * Give the operation lease back at the end of a tool call.
   *
   * Fenced on the exact holder: a release after a checkout that replaced the
   * generation still has to clear the holder, and a release that arrives
   * after another run took the lease over must not clear that run's. A run
   * whose own command is still unsettled on this generation keeps the lease
   * instead: the retained task is resolved either by this run reattaching on
   * its retry or by a successor's recovery, and both are keyed to the holder
   * — a successor recovers *from* a yielded holder, and a lease nobody holds
   * over an unsettled task would be one no linked run could ever recover.
   * Returns whether the lease was cleared.
   */
  releaseOperation(input: { runId: string; now: number }): boolean {
    return first<{ id: number }>(this.sql.exec(
      `UPDATE terminal_workspace
          SET operation_run_id = NULL, operation_run_substream_id = NULL,
              operation_lease_expires_at = NULL,
              version = version + 1, updated_at = ?
        WHERE id = 1 AND operation_run_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM terminal_tasks task
             WHERE task.sandbox_generation = terminal_workspace.generation
               AND task.run_id = ?
               AND task.state IN ('planned', 'submitting', 'running')
          )
        RETURNING id`,
      input.now,
      input.runId,
      input.runId,
    )) !== null;
  }

  /**
   * Exclusively claim provider cleanup for a yielded operation holder.
   *
   * The claim is workspace-local authority across the provider await. Normal
   * operation claims and lifecycle transitions cannot enter until the exact
   * token settles or is explicitly released.
   */
  claimYieldedOperationRecovery(input: {
    runId: string;
    generation: number;
    sandboxId: string;
    version: number;
    claimId: string;
    claimExpiresAt: number;
    now: number;
    /**
     * A holder that ran in another conversation and, that conversation says,
     * has yielded. Named by exact identity, as in `claimOperation`; without
     * it a foreign holder's retained task is not recoverable here.
     */
    yieldedForeignHolder?: { runId: string; substreamId: string } | null;
  }): boolean {
    return first<{ id: number }>(this.sql.exec(
      `UPDATE terminal_workspace
          SET lifecycle_claim_id = ?, lifecycle_claim_expires_at = ?,
              version = version + 1, updated_at = ?
        WHERE id = 1 AND generation = ? AND sandbox_id = ? AND version = ?
          AND operation_run_id IS NOT NULL AND operation_run_id <> ?
          AND lifecycle_state NOT IN ('stopping', 'archiving', 'expiring')
          AND (lifecycle_claim_id IS NULL OR lifecycle_claim_expires_at <= ?)
          AND (
            (
              operation_run_substream_id IS NULL
              AND EXISTS (
                SELECT 1 FROM runs holder
                 WHERE holder.run_id = terminal_workspace.operation_run_id
                   AND holder.status IN ${TERMINAL_YIELDED_RUN_STATUSES}
              )
            )
            OR (operation_run_id = ? AND operation_run_substream_id = ?)
          )
          AND NOT EXISTS (
            SELECT 1 FROM terminal_tasks task
             WHERE task.sandbox_generation = terminal_workspace.generation
               AND task.state = 'submitting'
               AND task.command_deadline_at > ?
          )
          AND EXISTS (
            SELECT 1 FROM terminal_tasks task
             WHERE task.sandbox_generation = terminal_workspace.generation
               AND task.state IN ('planned', 'submitting', 'running')
          )
        RETURNING id`,
      input.claimId,
      input.claimExpiresAt,
      input.now,
      input.generation,
      input.sandboxId,
      input.version,
      input.runId,
      input.now,
      input.yieldedForeignHolder?.runId ?? null,
      input.yieldedForeignHolder?.substreamId ?? null,
      input.now,
    )) !== null;
  }

  /** Atomically hand the recovered sandbox lease to the cleanup claimant. */
  settleYieldedOperationRecovery(input: {
    runId: string;
    /** The claimant's conversation when it is not this object's own; see the record. */
    runSubstreamId?: string | null;
    generation: number;
    sandboxId: string;
    claimId: string;
    leaseExpiresAt: number;
    sandboxStopped: boolean;
    now: number;
  }): TerminalSandboxRecord | null {
    return this.storage.transactionSync(() => {
      const settled = first<{ id: number }>(this.sql.exec(
        `UPDATE terminal_workspace
            SET operation_run_id = ?, operation_run_substream_id = ?,
                operation_lease_expires_at = ?,
                lifecycle_state = CASE WHEN ? = 1 THEN 'stopped' ELSE lifecycle_state END,
                idle_expires_at = CASE WHEN ? = 1 THEN NULL ELSE idle_expires_at END,
                lifecycle_claim_id = NULL, lifecycle_claim_expires_at = NULL,
                failure_code = NULL, version = version + 1, updated_at = ?
          WHERE id = 1 AND generation = ? AND sandbox_id = ?
            AND lifecycle_claim_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM terminal_tasks task
               WHERE task.sandbox_generation = terminal_workspace.generation
                 AND task.state IN ('planned', 'submitting', 'running')
            )
          RETURNING id`,
        input.runId,
        input.runSubstreamId ?? null,
        input.leaseExpiresAt,
        input.sandboxStopped ? 1 : 0,
        input.sandboxStopped ? 1 : 0,
        input.now,
        input.generation,
        input.sandboxId,
        input.claimId,
      ));
      return settled ? this.sandbox() : null;
    });
  }

  /**
   * Retire a provider sandbox that cannot prove a pre-submission command
   * quiescent, then hand a fresh generation to the exact cleanup claimant.
   * The provider delete/404 observation happens before this transaction; the
   * claim and no-live-task predicates keep that observation attached to the
   * generation it actually covered.
   */
  retireYieldedOperationRecovery(input: {
    runId: string;
    /** The claimant's conversation when it is not this object's own; see the record. */
    runSubstreamId?: string | null;
    generation: number;
    sandboxId: string;
    claimId: string;
    leaseExpiresAt: number;
    idleExpiresAt: number;
    archiveDueAt: number;
    expireDueAt: number;
    now: number;
  }): TerminalSandboxRecord | null {
    return this.storage.transactionSync(() => {
      const retired = first<{ id: number }>(this.sql.exec(
        `UPDATE terminal_workspace
            SET generation = generation + 1, sandbox_id = NULL,
                lifecycle_state = 'starting', operation_run_id = ?,
                operation_run_substream_id = ?,
                operation_lease_expires_at = ?, last_command_at = ?,
                idle_expires_at = ?, archive_due_at = ?, expire_due_at = ?,
                lifecycle_claim_id = NULL, lifecycle_claim_expires_at = NULL,
                final_diff_resource_id = NULL, failure_code = NULL,
                version = version + 1, updated_at = ?
          WHERE id = 1 AND generation = ? AND sandbox_id = ?
            AND lifecycle_claim_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM terminal_tasks task
               WHERE task.sandbox_generation = terminal_workspace.generation
                 AND task.state IN ('planned', 'submitting', 'running')
            )
          RETURNING id`,
        input.runId,
        input.runSubstreamId ?? null,
        input.leaseExpiresAt,
        input.now,
        input.idleExpiresAt,
        input.archiveDueAt,
        input.expireDueAt,
        input.now,
        input.generation,
        input.sandboxId,
        input.claimId,
      ));
      if (!retired) return null;
      this.sql.exec(
        `DELETE FROM terminal_imported_resources WHERE sandbox_generation <= ?`,
        input.generation,
      );
      return this.sandbox();
    });
  }

  /**
   * Retire a sandbox that a lifecycle claim proved absent at the provider.
   * Unlike normal expiry, this advances the generation so repository and
   * imported-resource provenance can never describe a future replacement.
   */
  retireMissingSandboxAfterLifecycleClaim(input: {
    generation: number;
    sandboxId: string;
    claimId: string;
    now: number;
  }): TerminalSandboxRecord | null {
    return this.storage.transactionSync(() => {
      const retired = first<{ id: number }>(this.sql.exec(
        `UPDATE terminal_workspace
            SET generation = generation + 1, sandbox_id = NULL,
                lifecycle_state = 'starting', idle_expires_at = NULL,
                archive_due_at = NULL, expire_due_at = NULL,
                lifecycle_claim_id = NULL, lifecycle_claim_expires_at = NULL,
                final_diff_resource_id = NULL, failure_code = NULL,
                version = version + 1, updated_at = ?
          WHERE id = 1 AND generation = ? AND sandbox_id = ?
            AND lifecycle_claim_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM terminal_tasks task
               WHERE task.sandbox_generation = terminal_workspace.generation
                 AND task.state IN ('planned', 'submitting', 'running')
            )
          RETURNING id`,
        input.now,
        input.generation,
        input.sandboxId,
        input.claimId,
      ));
      if (!retired) return null;
      this.sql.exec(
        `DELETE FROM terminal_imported_resources WHERE sandbox_generation <= ?`,
        input.generation,
      );
      return this.sandbox();
    });
  }

  /**
   * Extend one exact provider-await claim without reviving an already-expired
   * token. A stale continuation must fail here before its next provider
   * mutation; a contender may replace the token only after this deadline.
   */
  renewLifecycleClaim(input: {
    generation: number;
    sandboxId: string;
    claimId: string;
    claimExpiresAt: number;
    now: number;
  }): boolean {
    return first<{ id: number }>(this.sql.exec(
      `UPDATE terminal_workspace
          SET lifecycle_claim_expires_at = ?, updated_at = ?
        WHERE id = 1 AND generation = ? AND sandbox_id = ?
          AND lifecycle_claim_id = ?
          AND lifecycle_claim_expires_at IS NOT NULL
          AND lifecycle_claim_expires_at > ?
        RETURNING id`,
      input.claimExpiresAt,
      input.now,
      input.generation,
      input.sandboxId,
      input.claimId,
      input.now,
    )) !== null;
  }

  /**
   * Record the provider's sandbox for the generation this run reserved.
   *
   * Fenced on generation so a reserve that raced a replacement cannot attach a
   * provider sandbox to a generation that has already been retired.
   */
  attachProviderSandbox(input: {
    generation: number;
    sandboxId: string;
    lifecycleState: TerminalLifecycleState;
    idleExpiresAt: number;
    archiveDueAt: number;
    expireDueAt: number;
    now: number;
  }): void {
    this.sql.exec(
      `UPDATE terminal_workspace
          SET sandbox_id = ?, lifecycle_state = ?, idle_expires_at = ?,
              archive_due_at = ?, expire_due_at = ?, last_command_at = ?,
              failure_code = NULL, final_diff_resource_id = NULL,
              version = version + 1, updated_at = ?
        WHERE id = 1 AND generation = ?`,
      input.sandboxId,
      input.lifecycleState,
      input.idleExpiresAt,
      input.archiveDueAt,
      input.expireDueAt,
      input.now,
      input.now,
      input.generation,
    );
  }

  /** Mark the generation failed when the provider never confirmed creation. */
  failGeneration(input: {
    generation: number;
    failureCode: string;
    clearSandboxId?: boolean;
    now: number;
  }): void {
    this.sql.exec(
      `UPDATE terminal_workspace
          SET lifecycle_state = 'failed', failure_code = ?,
              sandbox_id = CASE WHEN ? = 1 THEN NULL ELSE sandbox_id END,
              version = version + 1, updated_at = ?
        WHERE id = 1 AND generation = ?`,
      input.failureCode,
      input.clearSandboxId ? 1 : 0,
      input.now,
      input.generation,
    );
  }

  /** Move a started or restored sandbox back to running and push its deadlines out. */
  setRunning(input: {
    generation: number;
    idleExpiresAt: number;
    archiveDueAt: number;
    expireDueAt: number;
    now: number;
  }): void {
    this.sql.exec(
      `UPDATE terminal_workspace
          SET lifecycle_state = 'running', last_command_at = ?, idle_expires_at = ?,
              archive_due_at = ?, expire_due_at = ?, failure_code = NULL,
              final_diff_resource_id = NULL, version = version + 1, updated_at = ?
        WHERE id = 1 AND generation = ?`,
      input.now,
      input.idleExpiresAt,
      input.archiveDueAt,
      input.expireDueAt,
      input.now,
      input.generation,
    );
  }

  /** Push the idle, archive, and expiry deadlines out for a sandbox already running. */
  refreshDeadlines(input: {
    generation: number;
    idleExpiresAt: number;
    archiveDueAt: number;
    expireDueAt: number;
    now: number;
  }): void {
    this.sql.exec(
      `UPDATE terminal_workspace
          SET last_command_at = ?, idle_expires_at = ?, archive_due_at = ?,
              expire_due_at = ?, updated_at = ?
        WHERE id = 1 AND generation = ?`,
      input.now,
      input.idleExpiresAt,
      input.archiveDueAt,
      input.expireDueAt,
      input.now,
      input.generation,
    );
  }

  /**
   * Record the network revision the provider has actually had applied, and
   * park the sandbox in the state that revision leaves it in.
   *
   * A sandbox that exists was stopped to take the new policy, so it lands in
   * `stopped`; one that was never created stays `starting`. Deliberately not
   * fenced on generation — the workspace policy applies to whichever
   * generation is current when the change lands.
   */
  setAppliedNetworkRevision(input: { networkRevision: number; now: number }): void {
    this.sql.exec(
      `UPDATE terminal_workspace
          SET lifecycle_state =
                CASE WHEN sandbox_id IS NULL THEN 'starting' ELSE 'stopped' END,
              applied_network_revision = ?, version = version + 1, updated_at = ?
        WHERE id = 1`,
      input.networkRevision,
      input.now,
    );
  }

  /**
   * Advance to a fresh generation under a new authority fingerprint.
   *
   * The imported-resource provenance of the retired generation goes with it:
   * those rows describe files inside a sandbox that is about to be discarded,
   * and keeping them would let the next authority check pass on evidence from
   * an authority that no longer holds.
   */
  replaceGeneration(input: {
    generation: number;
    authorityFingerprint: string;
    networkRevision: number;
    runId: string;
    /** The holder's conversation when it is not this object's own; see the record. */
    runSubstreamId?: string | null;
    operationLeaseExpiresAt: number;
    idleExpiresAt: number;
    archiveDueAt: number;
    expireDueAt: number;
    now: number;
  }): TerminalSandboxRecord {
    return this.storage.transactionSync(() => {
      this.sql.exec(
        `DELETE FROM terminal_imported_resources WHERE sandbox_generation <= ?`,
        input.generation,
      );
      this.sql.exec(
        `UPDATE terminal_workspace
            SET generation = generation + 1, sandbox_id = NULL,
                lifecycle_state = 'starting', authority_fingerprint = ?,
                applied_network_revision = ?, operation_run_id = ?,
                operation_run_substream_id = ?,
                operation_lease_expires_at = ?, last_command_at = ?,
                idle_expires_at = ?, archive_due_at = ?, expire_due_at = ?,
                final_diff_resource_id = NULL, failure_code = NULL,
                version = version + 1, updated_at = ?
          WHERE id = 1 AND generation = ?`,
        input.authorityFingerprint,
        input.networkRevision,
        input.runId,
        input.runSubstreamId ?? null,
        input.operationLeaseExpiresAt,
        input.now,
        input.idleExpiresAt,
        input.archiveDueAt,
        input.expireDueAt,
        input.now,
        input.generation,
      );
      const row = this.sandbox();
      if (!row) throw new Error("terminal_sandbox_replace_failed");
      return row;
    });
  }

  /**
   * Discard the current sandbox and the repository bootstrap that belonged to
   * it, returning whether a sandbox row was actually removed.
   *
   * One operation rather than a delete followed by a clear: the two were a D1
   * `batch()` before, and splitting them across two round trips would let a
   * caller observe a repository still marked bootstrapped into a sandbox that
   * no longer exists — which is exactly the state the next bootstrap check
   * reads to decide it can skip its work.
   *
   * `generation` fences the delete when the caller has read one; passing null
   * removes whatever row is present, which is what a reset with no readable
   * sandbox needs.
   */
  resetSandbox(input: { generation: number | null; now: number }): { deleted: boolean } {
    return this.storage.transactionSync(() => {
      const deleted = input.generation === null
        ? this.sql.exec(`DELETE FROM terminal_workspace WHERE id = 1 RETURNING id`)
        : this.sql.exec(
            `DELETE FROM terminal_workspace WHERE id = 1 AND generation = ? RETURNING id`,
            input.generation,
          );
      const removed = deleted.toArray().length > 0;
      // Fenced on a surviving sandbox, not on `removed`, and deliberately so.
      // The caller reads a generation, then awaits the provider's delete before
      // reaching this — long enough for another run to replace the generation
      // and import into the new one. An unconditional delete here would erase
      // that live generation's provenance while the fenced delete above missed,
      // and `hasRevokedImportedResource` reads an empty set as "nothing was
      // revoked", so the next acquire would reuse files whose authorization can
      // no longer be revalidated. This guard also still clears rows orphaned by
      // a sandbox that was already gone, which is why it is not `if (removed)`.
      this.sql.exec(
        `DELETE FROM terminal_imported_resources
          WHERE NOT EXISTS (SELECT 1 FROM terminal_workspace WHERE id = 1)`,
      );
      this.sql.exec(
        `UPDATE terminal_repository
            SET bootstrapped_sandbox_generation = NULL, read_token_expires_at = NULL,
                updated_at = ?
          WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM terminal_workspace WHERE id = 1)`,
        input.now,
      );
      return { deleted: removed };
    });
  }

  // -------------------------------------------------------------- lifecycle

  /**
   * Claim one lifecycle transition, fenced on the version the caller read.
   *
   * The version fence is what makes a scheduler alarm and a live tool safe to
   * race: whichever writes first moves the version, and the other's claim
   * matches nothing rather than driving a transition from stale state.
   */
  claimLifecycleTransition(input: {
    lifecycleState: TerminalLifecycleState;
    claimId: string;
    claimExpiresAt: number;
    generation: number;
    version: number;
    now: number;
  }): { sandboxId: string | null } | null {
    const claimed = first<{ sandbox_id: string | null }>(this.sql.exec(
      `UPDATE terminal_workspace
          SET lifecycle_state = ?, lifecycle_claim_id = ?, lifecycle_claim_expires_at = ?,
              version = version + 1, updated_at = ?
        WHERE id = 1 AND generation = ? AND version = ?
          AND (lifecycle_claim_id IS NULL OR lifecycle_claim_expires_at <= ?)
        RETURNING sandbox_id`,
      input.lifecycleState,
      input.claimId,
      input.claimExpiresAt,
      input.now,
      input.generation,
      input.version,
      input.now,
    ));
    return claimed ? { sandboxId: claimed.sandbox_id } : null;
  }

  /** Fail or cleanly release a claimed transition. */
  failLifecycleClaim(input: {
    lifecycleState: TerminalLifecycleState;
    failureCode: string | null;
    claimId: string;
    now: number;
  }): void {
    this.sql.exec(
      `UPDATE terminal_workspace
          SET lifecycle_state = ?, failure_code = ?, lifecycle_claim_id = NULL,
              lifecycle_claim_expires_at = NULL, version = version + 1, updated_at = ?
        WHERE id = 1 AND lifecycle_claim_id = ?`,
      input.lifecycleState,
      input.failureCode,
      input.now,
      input.claimId,
    );
  }

  /**
   * Settle a claimed transition, clearing the deadlines the new state retires.
   *
   * Expiry is the terminal case and clears everything, including the provider
   * sandbox id: past that point there is nothing left to stop, archive, or
   * reattach to. It therefore refuses to settle while this generation still
   * has an unsettled task; the lifecycle claimant must finish cancellation
   * before it can discard the provider authority needed for a retry.
   */
  settleLifecycleTransition(input: {
    lifecycleState: TerminalLifecycleState;
    claimId: string;
    now: number;
  }): boolean {
    const expired = input.lifecycleState === "expired" ? 1 : 0;
    const stoppedOrExpired = ["stopped", "expired"].includes(input.lifecycleState) ? 1 : 0;
    const archivedOrExpired = ["archived", "expired"].includes(input.lifecycleState) ? 1 : 0;
    return first<{ id: number }>(this.sql.exec(
      `UPDATE terminal_workspace
          SET lifecycle_state = ?,
              sandbox_id = CASE WHEN ? = 1 THEN NULL ELSE sandbox_id END,
              idle_expires_at = CASE WHEN ? = 1 THEN NULL ELSE idle_expires_at END,
              archive_due_at = CASE WHEN ? = 1 THEN NULL ELSE archive_due_at END,
              expire_due_at = CASE WHEN ? = 1 THEN NULL ELSE expire_due_at END,
              operation_run_id = CASE WHEN ? = 1 THEN NULL ELSE operation_run_id END,
              operation_run_substream_id =
                CASE WHEN ? = 1 THEN NULL ELSE operation_run_substream_id END,
              operation_lease_expires_at =
                CASE WHEN ? = 1 THEN NULL ELSE operation_lease_expires_at END,
              lifecycle_claim_id = NULL, lifecycle_claim_expires_at = NULL,
              failure_code = NULL, version = version + 1, updated_at = ?
        WHERE id = 1 AND lifecycle_claim_id = ?
          AND (? = 0 OR NOT EXISTS (
            SELECT 1 FROM terminal_tasks task
             WHERE task.sandbox_generation = terminal_workspace.generation
               AND task.state IN ('planned', 'submitting', 'running')
          ))
        RETURNING id`,
      input.lifecycleState,
      expired,
      stoppedOrExpired,
      archivedOrExpired,
      expired,
      expired,
      expired,
      expired,
      input.now,
      input.claimId,
      expired,
    )) !== null;
  }

  finalDiffResourceId(): string | null {
    return this.sandbox()?.finalDiffResourceId ?? null;
  }

  setFinalDiffResourceId(resourceId: string, now: number): void {
    this.sql.exec(
      `UPDATE terminal_workspace SET final_diff_resource_id = ?, updated_at = ? WHERE id = 1`,
      resourceId,
      now,
    );
  }

  /** Stop the sandbox for a network-policy transition, fenced on the provider id. */
  settlePolicyTransition(input: {
    /** Null leaves the state as it is: the transition did not move the sandbox. */
    lifecycleState: TerminalLifecycleState | null;
    failureCode: string | null;
    clearSandboxId: boolean;
    /**
     * Whether this transition also drops the mutation lease.
     *
     * Per call site, not uniform, because the five statements this replaces
     * were not uniform: the stop and the two failure paths that lose the
     * sandbox released the lease, while the rollback and the settle that only
     * records the applied revision left it with its holder. Clearing it
     * everywhere would be an unremarked change to a mutual-exclusion guard.
     */
    clearOperationLease: boolean;
    appliedNetworkRevision: number | null;
    generation: number;
    sandboxId: string;
    now: number;
  }): void {
    this.sql.exec(
      `UPDATE terminal_workspace
          SET lifecycle_state = COALESCE(?, lifecycle_state),
              failure_code = ?,
              sandbox_id = CASE WHEN ? = 1 THEN NULL ELSE sandbox_id END,
              applied_network_revision =
                COALESCE(?, applied_network_revision),
              operation_run_id =
                CASE WHEN ? = 1 THEN NULL ELSE operation_run_id END,
              operation_run_substream_id =
                CASE WHEN ? = 1 THEN NULL ELSE operation_run_substream_id END,
              operation_lease_expires_at =
                CASE WHEN ? = 1 THEN NULL ELSE operation_lease_expires_at END,
              version = version + 1, updated_at = ?
        WHERE id = 1 AND generation = ? AND sandbox_id = ?`,
      input.lifecycleState,
      input.failureCode,
      input.clearSandboxId ? 1 : 0,
      input.appliedNetworkRevision,
      input.clearOperationLease ? 1 : 0,
      input.clearOperationLease ? 1 : 0,
      input.clearOperationLease ? 1 : 0,
      input.now,
      input.generation,
      input.sandboxId,
    );
  }

  /** The live sandbox a workspace-wide policy change has to act on, if any. */
  policyTarget(): {
    sandboxId: string;
    lifecycleState: string;
    generation: number;
    /** The Daytona name the row was reserved under; a caller checks it is this conversation's. */
    stableName: string | null;
  } | null {
    const row = first<{ sandbox_id: string; lifecycle_state: string; generation: number; stable_name: string | null }>(
      this.sql.exec(
        `SELECT sandbox_id, lifecycle_state, generation, stable_name FROM terminal_workspace
          WHERE id = 1 AND sandbox_id IS NOT NULL
            AND lifecycle_state NOT IN ('absent', 'expired', 'failed')`,
      ),
    );
    return row
      ? {
          sandboxId: row.sandbox_id,
          lifecycleState: row.lifecycle_state,
          generation: row.generation,
          stableName: row.stable_name,
        }
      : null;
  }

  // ------------------------------------------------------------------ tasks

  taskByEffect(effectIntentId: string): TerminalTaskRecord | null {
    const row = first<TaskRow>(this.sql.exec<TaskRow>(
      `SELECT task_id, run_id, run_substream_id, effect_intent_id, sandbox_generation,
              provider_task_name, provider_task_id, state, command_sha256,
              command_deadline_at, exit_code, termination_reason, stdout_head,
              stdout_tail, stderr_head, stderr_tail, stdout_bytes, stderr_bytes,
              output_resource_id, started_at, completed_at
         FROM terminal_tasks WHERE effect_intent_id = ?`,
      effectIntentId,
    ));
    return row ? toTask(row) : null;
  }

  /**
   * One unsettled task for lifecycle reconciliation, irrespective of owner.
   * Pre-acceptance states come first because mixed residue must retire its
   * generation before a running-task stop could make that sandbox reusable.
   */
  unsettledTask(generation: number): TerminalTaskRecord | null {
    const row = first<TaskRow>(this.sql.exec<TaskRow>(
      `SELECT task_id, run_id, run_substream_id, effect_intent_id, sandbox_generation,
              provider_task_name, provider_task_id, state, command_sha256,
              command_deadline_at, exit_code, termination_reason, stdout_head,
              stdout_tail, stderr_head, stderr_tail, stdout_bytes, stderr_bytes,
              output_resource_id, started_at, completed_at
         FROM terminal_tasks
        WHERE sandbox_generation = ?
          AND state IN ('planned', 'submitting', 'running')
        ORDER BY CASE state WHEN 'running' THEN 1 ELSE 0 END,
                 task_id
        LIMIT 1`,
      generation,
    ));
    return row ? toTask(row) : null;
  }

  /** True while any task for this generation is still inside its deadline. */
  hasLiveTask(generation: number, now: number): boolean {
    return first<{ task_id: string }>(this.sql.exec(
      `SELECT task_id FROM terminal_tasks
        WHERE sandbox_generation = ? AND state IN ('planned', 'submitting', 'running')
          AND command_deadline_at > ? LIMIT 1`,
      generation,
      now,
    )) !== null;
  }

  unsettledTaskCount(): number {
    return first<{ count: number }>(this.sql.exec(
      `SELECT COUNT(*) AS count FROM terminal_tasks
        WHERE state IN ('planned', 'submitting', 'running')`,
    ))?.count ?? 0;
  }

  /**
   * Admit one command into its provider-submission window.
   *
   * The existing-row identity check handles exact replay before the insert.
   * A mismatched receipt, sandbox generation, provider name, or command hash
   * fails closed instead of being treated as the same command.
   */
  insertTask(input: {
    taskId: string;
    runId: string;
    /** The run's conversation when it is not this object's own; see the record. */
    runSubstreamId?: string | null;
    effectIntentId: string;
    sandboxGeneration: number;
    sandboxId: string;
    providerTaskName: string;
    commandSha256: string;
    commandDeadlineAt: number;
    startedAt: number;
    now: number;
  }): boolean {
    return this.storage.transactionSync(() => {
      const authorized = first<{ id: number }>(this.sql.exec(
        `SELECT workspace.id
           FROM terminal_workspace workspace
          WHERE workspace.id = 1
            AND workspace.generation = ? AND workspace.sandbox_id = ?
            AND workspace.operation_run_id = ?
            AND workspace.operation_run_substream_id IS ?
            AND workspace.lifecycle_claim_id IS NULL
            AND ${HOLDER_IS_LIVE}`,
        input.sandboxGeneration,
        input.sandboxId,
        input.runId,
        input.runSubstreamId ?? null,
        input.now,
      ));
      if (!authorized) return false;
      // A run of this object records a command only against the receipt the
      // harness planned for it, which is here. A run from another conversation
      // carries its receipt in its own object, where this statement cannot
      // look: the lease it holds, matched above by run and conversation, is
      // its authority to submit. (Until schema 65 the receipt was a foreign
      // key, which is what refused every command a background agent ran.)
      if (!input.runSubstreamId) {
        const planned = first<{ effect_intent_id: string }>(this.sql.exec(
          `SELECT effect_intent_id FROM tool_effects WHERE effect_intent_id = ? AND run_id = ?`,
          input.effectIntentId,
          input.runId,
        ));
        if (!planned) return false;
      }

      const existing = this.taskByEffect(input.effectIntentId);
      if (existing) {
        return existing.runId === input.runId
          && existing.sandboxGeneration === input.sandboxGeneration
          && existing.providerTaskName === input.providerTaskName
          && existing.commandSha256 === input.commandSha256
          && (existing.state === "submitting" || existing.state === "running");
      }

      return first<{ task_id: string }>(this.sql.exec(
        `INSERT INTO terminal_tasks
           (task_id, run_id, run_substream_id, effect_intent_id, sandbox_generation,
            provider_task_name, state, command_sha256, command_deadline_at, stdout_head,
            stdout_tail, stderr_head, stderr_tail, stdout_bytes, stderr_bytes, started_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'submitting', ?, ?, '', '', '', '', 0, 0, ?, ?, ?)
         RETURNING task_id`,
        input.taskId,
        input.runId,
        input.runSubstreamId ?? null,
        input.effectIntentId,
        input.sandboxGeneration,
        input.providerTaskName,
        input.commandSha256,
        input.commandDeadlineAt,
        input.startedAt,
        input.now,
        input.now,
      )) !== null;
    });
  }

  /**
   * Renew the bounded provider-submission window only while the exact run,
   * sandbox generation, and operation lease still authorize this task.
   */
  renewTaskSubmissionAuthority(input: {
    effectIntentId: string;
    runId: string;
    sandboxGeneration: number;
    sandboxId: string;
    commandDeadlineAt: number;
    now: number;
  }): boolean {
    return first<{ task_id: string }>(this.sql.exec(
      `UPDATE terminal_tasks
          SET command_deadline_at = MAX(command_deadline_at, ?), updated_at = ?
        WHERE effect_intent_id = ? AND run_id = ?
          AND sandbox_generation = ? AND state = 'submitting'
          AND EXISTS (
            SELECT 1 FROM terminal_workspace workspace
             WHERE workspace.id = 1
               AND workspace.generation = terminal_tasks.sandbox_generation
               AND workspace.sandbox_id = ?
               AND workspace.operation_run_id = ?
               AND workspace.lifecycle_claim_id IS NULL
               AND ${HOLDER_IS_LIVE}
          )
        RETURNING task_id`,
      input.commandDeadlineAt,
      input.now,
      input.effectIntentId,
      input.runId,
      input.sandboxGeneration,
      input.sandboxId,
      input.runId,
      input.now,
    )) !== null;
  }

  /** Record that Daytona accepted the named command before observation begins. */
  markTaskRunning(input: {
    effectIntentId: string;
    providerTaskId: string;
    commandDeadlineAt: number;
    now: number;
  }): boolean {
    return first<{ task_id: string }>(this.sql.exec(
      `UPDATE terminal_tasks
          SET state = 'running', provider_task_id = ?,
              command_deadline_at = MAX(command_deadline_at, ?), updated_at = ?
        WHERE effect_intent_id = ? AND state IN ('submitting', 'running')
          AND (provider_task_id IS NULL OR provider_task_id = ?)
        RETURNING task_id`,
      input.providerTaskId,
      input.commandDeadlineAt,
      input.now,
      input.effectIntentId,
      input.providerTaskId,
    )) !== null;
  }

  settleTask(input: {
    effectIntentId: string;
    runId: string;
    sandboxGeneration: number;
    sandboxId: string;
    state: string;
    exitCode: number | null;
    terminationReason: string | null;
    stdoutHead: string;
    stdoutTail: string;
    stderrHead: string;
    stderrTail: string;
    stdoutBytes: number;
    stderrBytes: number;
    completedAt: number | null;
    now: number;
  }): boolean {
    return first<{ task_id: string }>(this.sql.exec(
      `UPDATE terminal_tasks
          SET state = ?, exit_code = ?, termination_reason = ?, stdout_head = ?,
              stdout_tail = ?, stderr_head = ?, stderr_tail = ?, stdout_bytes = ?,
              stderr_bytes = ?, completed_at = ?, updated_at = ?
        WHERE effect_intent_id = ?
          AND run_id = ? AND sandbox_generation = ?
          AND state IN ('planned', 'submitting', 'running')
          AND EXISTS (
            SELECT 1 FROM terminal_workspace workspace
             WHERE workspace.id = 1
               AND workspace.generation = terminal_tasks.sandbox_generation
               AND workspace.sandbox_id = ?
               AND workspace.operation_run_id = ?
               AND workspace.lifecycle_claim_id IS NULL
               AND ${HOLDER_IS_LIVE}
          )
        RETURNING task_id`,
      input.state,
      input.exitCode,
      input.terminationReason,
      input.stdoutHead,
      input.stdoutTail,
      input.stderrHead,
      input.stderrTail,
      input.stdoutBytes,
      input.stderrBytes,
      input.completedAt,
      input.now,
      input.effectIntentId,
      input.runId,
      input.sandboxGeneration,
      input.sandboxId,
      input.runId,
      input.now,
    )) !== null;
  }

  /** Attach an idempotently published command log to one terminal result. */
  attachTaskOutputResource(input: {
    effectIntentId: string;
    runId: string;
    sandboxGeneration: number;
    state: string;
    completedAt: number;
    outputResourceId: string;
    now: number;
  }): boolean {
    return first<{ task_id: string }>(this.sql.exec(
      `UPDATE terminal_tasks
          SET output_resource_id = ?, updated_at = ?
        WHERE effect_intent_id = ?
          AND run_id = ? AND sandbox_generation = ?
          AND state = ? AND completed_at = ?
          AND state IN ('completed', 'failed', 'timed_out')
          AND output_resource_id IS NULL
        RETURNING task_id`,
      input.outputResourceId,
      input.now,
      input.effectIntentId,
      input.runId,
      input.sandboxGeneration,
      input.state,
      input.completedAt,
    )) !== null;
  }

  /**
   * Settle exactly one task only after its provider session, or its whole
   * sandbox, has been confirmed quiescent by the caller.
   */
  cancelTaskAfterProviderCleanup(input: {
    taskId: string;
    runId: string;
    effectIntentId: string;
    sandboxGeneration: number;
    providerTaskName: string;
    claimId: string;
    now: number;
  }): boolean {
    return first<{ task_id: string }>(this.sql.exec(
      `UPDATE terminal_tasks
          SET state = 'cancelled', termination_reason = 'cancelled',
              completed_at = ?, updated_at = ?
        WHERE task_id = ? AND run_id = ? AND effect_intent_id = ?
          AND sandbox_generation = ? AND provider_task_name = ?
          AND state IN ('planned', 'submitting', 'running')
          AND EXISTS (
            SELECT 1 FROM terminal_workspace workspace
             WHERE workspace.id = 1
               AND workspace.generation = terminal_tasks.sandbox_generation
               AND workspace.lifecycle_claim_id = ?
          )
        RETURNING task_id`,
      input.now,
      input.now,
      input.taskId,
      input.runId,
      input.effectIntentId,
      input.sandboxGeneration,
      input.providerTaskName,
      input.claimId,
    )) !== null;
  }

  cancelUnsettledTasks(now: number): void {
    this.sql.exec(
      `UPDATE terminal_tasks
          SET state = 'cancelled', termination_reason = 'cancelled',
              completed_at = ?, updated_at = ?
        WHERE state IN ('planned', 'submitting', 'running')`,
      now,
      now,
    );
  }

  // ----------------------------------------------------- imported resources

  importedResources(generation: number): TerminalImportedResourceRecord[] {
    return this.sql.exec<{
      resource_id: string;
      destination_path: string;
      state: string;
      attached_substream_id: string | null;
    }>(
      `SELECT resource_id, destination_path, state, attached_substream_id
         FROM terminal_imported_resources
        WHERE sandbox_generation = ?`,
      generation,
    ).toArray().map((row) => ({
      resourceId: row.resource_id,
      destinationPath: row.destination_path,
      state: row.state as "planned" | "completed",
      attachedSubstreamId: row.attached_substream_id,
    }));
  }

  recordImportedResource(input: {
    sandboxGeneration: number;
    resourceId: string;
    destinationPath: string;
    sourceSha256: string;
    sizeBytes: number;
    state: "planned" | "completed";
    importedAt: number | null;
    /** The authorizing conversation when it is not this object's own; see the record. */
    attachedSubstreamId?: string | null;
    now: number;
  }): void {
    this.sql.exec(
      `INSERT INTO terminal_imported_resources
         (sandbox_generation, resource_id, destination_path, source_sha256,
          size_bytes, state, imported_at, attached_substream_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sandbox_generation, resource_id, destination_path)
       DO UPDATE SET source_sha256 = excluded.source_sha256,
         size_bytes = excluded.size_bytes, state = excluded.state,
         imported_at = excluded.imported_at,
         attached_substream_id = excluded.attached_substream_id,
         updated_at = excluded.updated_at`,
      input.sandboxGeneration,
      input.resourceId,
      input.destinationPath,
      input.sourceSha256,
      input.sizeBytes,
      input.state,
      input.importedAt,
      input.attachedSubstreamId ?? null,
      input.now,
    );
  }

  /**
   * Settle a planned import, fenced on the digest that was planned.
   *
   * The digest fence is the point: a resource whose bytes changed between plan
   * and copy settles nothing, so the next authority check still sees a planned
   * row and replaces the generation.
   */
  completeImportedResource(input: {
    sandboxGeneration: number;
    resourceId: string;
    destinationPath: string;
    sourceSha256: string;
    importedAt: number;
    now: number;
  }): void {
    this.sql.exec(
      `UPDATE terminal_imported_resources
          SET state = 'completed', imported_at = ?, updated_at = ?
        WHERE sandbox_generation = ? AND resource_id = ? AND destination_path = ?
          AND source_sha256 = ?`,
      input.importedAt,
      input.now,
      input.sandboxGeneration,
      input.resourceId,
      input.destinationPath,
      input.sourceSha256,
    );
  }

  // ------------------------------------------------------------- repository

  repository(): TerminalRepositoryRecord | null {
    const row = first<RepositoryRow>(this.sql.exec<RepositoryRow>(
      `SELECT ${REPOSITORY_COLUMNS} FROM terminal_repository WHERE id = 1`,
    ));
    return row ? toRepository(row) : null;
  }

  selectedRepository(): TerminalRepositoryRecord | null {
    const row = this.repository();
    return row?.state === "selected" ? row : null;
  }

  /**
   * Select or replace the work stream's repository.
   *
   * Refused once a sandbox exists: the selection is the authority fingerprint's
   * input, and changing it under a live generation would leave a running
   * sandbox bootstrapped against a repository nobody chose. The caller resets
   * the sandbox first.
   */
  #selectRepositoryUnfenced(input: {
    connectionId: string;
    repositoryId: number;
    repositoryFullName: string;
    baseRef: string;
    baseSha: string;
    headRef: string;
    remoteAccess: "read_only" | "full_access";
    selectedByUserId: string;
    now: number;
  }): boolean {
    return this.storage.transactionSync(() => {
      if (this.sandbox()) return false;
      this.sql.exec(
        `INSERT INTO terminal_repository
           (id, connection_id, repository_id, repository_full_name, base_ref, base_sha,
            head_ref, state, bootstrapped_sandbox_generation, read_token_expires_at,
            selected_by_user_id, remote_access, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, 'selected', NULL, NULL, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET connection_id = excluded.connection_id,
           repository_id = excluded.repository_id,
           repository_full_name = excluded.repository_full_name,
           base_ref = excluded.base_ref, base_sha = excluded.base_sha,
           head_ref = excluded.head_ref, state = 'selected',
           bootstrapped_sandbox_generation = NULL, read_token_expires_at = NULL,
           selected_by_user_id = excluded.selected_by_user_id,
           remote_access = excluded.remote_access, updated_at = excluded.updated_at`,
        input.connectionId,
        input.repositoryId,
        input.repositoryFullName,
        input.baseRef,
        input.baseSha,
        input.headRef,
        input.selectedByUserId,
        input.remoteAccess,
        input.now,
        input.now,
      );
      return true;
    });
  }

  /**
   * Retire the current sandbox generation and select a repository in its place.
   *
   * These were a two-statement `batch()` whose second statement carried a
   * `NOT EXISTS` guard against the first — the guard only held because D1 ran
   * them in order in one transaction. Splitting them across two round trips
   * would reintroduce the window the guard closes, so they stay one operation.
   * A false return means the generation fence missed and nothing was written.
   */
  replaceRepository(input: {
    generation: number;
    connectionId: string;
    repositoryId: number;
    repositoryFullName: string;
    baseRef: string;
    baseSha: string;
    headRef: string;
    remoteAccess: "read_only" | "full_access";
    selectedByUserId: string;
    now: number;
  }): boolean {
    return this.storage.transactionSync(() => {
      const removed = this.sql.exec(
        `DELETE FROM terminal_workspace WHERE id = 1 AND generation = ? RETURNING id`,
        input.generation,
      ).toArray().length;
      if (removed !== 1) return false;
      this.sql.exec(`DELETE FROM terminal_imported_resources`);
      return this.#selectRepositoryUnfenced(input);
    });
  }

  /** Record that a generation has been bootstrapped against the selected repository. */
  recordRepositoryBootstrap(input: {
    generation: number;
    readTokenExpiresAt: number | null;
    repositoryFullName: string;
    baseSha: string;
    now: number;
  }): void {
    this.sql.exec(
      `UPDATE terminal_repository
          SET bootstrapped_sandbox_generation = ?,
              read_token_expires_at = COALESCE(?, read_token_expires_at), updated_at = ?
        WHERE id = 1 AND state = 'selected'
          AND repository_full_name = ? AND base_sha = ?`,
      input.generation,
      input.readTokenExpiresAt,
      input.now,
      input.repositoryFullName,
      input.baseSha,
    );
  }

  // ----------------------------------------------------------- publications

  /** Admit one run's authority to publish to a repository, once per source part. */
  admitPublicationGrant(input: {
    grantId: string;
    runId: string;
    sourcePartId: string;
    principalKey: string;
    repositoryFullName: string;
    baseRef: string;
    headRef: string;
    expiresAt: number;
    now: number;
  }): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO terminal_publication_grants
         (grant_id, run_id, source_message_id, principal_key, repository_full_name,
          base_ref, head_ref, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.grantId,
      input.runId,
      input.sourcePartId,
      input.principalKey,
      input.repositoryFullName,
      input.baseRef,
      input.headRef,
      input.expiresAt,
      input.now,
    );
  }

  latestPublicationGrant(input: {
    runId: string;
    repositoryFullName: string;
  }): TerminalPublicationGrantRecord | null {
    const row = first<{
      grant_id: string;
      principal_key: string;
      repository_full_name: string;
      base_ref: string;
      head_ref: string;
    }>(this.sql.exec(
      `SELECT grant_id, principal_key, repository_full_name, base_ref, head_ref
         FROM terminal_publication_grants
        WHERE run_id = ? AND repository_full_name = ?
        ORDER BY created_at DESC LIMIT 1`,
      input.runId,
      input.repositoryFullName,
    ));
    return row
      ? {
          grantId: row.grant_id,
          principalKey: row.principal_key,
          repositoryFullName: row.repository_full_name,
          baseRef: row.base_ref,
          headRef: row.head_ref,
        }
      : null;
  }

  /** Consume a grant for one effect; a second consume keeps the first's identity. */
  consumePublicationGrant(input: {
    grantId: string;
    effectIntentId: string;
    now: number;
  }): boolean {
    return first<{ grant_id: string }>(this.sql.exec(
      `UPDATE terminal_publication_grants
          SET consumed_by_effect_intent_id = COALESCE(consumed_by_effect_intent_id, ?),
              consumed_at = COALESCE(consumed_at, ?)
        WHERE grant_id = ?
        RETURNING grant_id`,
      input.effectIntentId,
      input.now,
      input.grantId,
    )) !== null;
  }

  completedPublication(effectIntentId: string): TerminalPublicationRecord | null {
    const row = first<{
      published_sha: string | null;
      pull_request_number: number | null;
      pull_request_url: string | null;
      head_ref: string;
      repository_full_name: string;
      base_ref: string;
      title: string;
    }>(this.sql.exec(
      `SELECT published_sha, pull_request_number, pull_request_url, head_ref,
              repository_full_name, base_ref, title
         FROM repository_publications
        WHERE effect_intent_id = ? AND state = 'completed'`,
      effectIntentId,
    ));
    return row
      ? {
          publishedSha: row.published_sha,
          pullRequestNumber: row.pull_request_number,
          pullRequestUrl: row.pull_request_url,
          headRef: row.head_ref,
          repositoryFullName: row.repository_full_name,
          baseRef: row.base_ref,
          title: row.title,
        }
      : null;
  }

  publicationExists(effectIntentId: string): boolean {
    return first<{ publication_id: string }>(this.sql.exec(
      `SELECT publication_id FROM repository_publications WHERE effect_intent_id = ?`,
      effectIntentId,
    )) !== null;
  }

  beginPublication(input: {
    publicationId: string;
    effectIntentId: string;
    grantId: string;
    repositoryFullName: string;
    baseRef: string;
    headRef: string;
    expectedOldSha: string | null;
    requestedCommitSha: string;
    title: string;
    body: string;
    now: number;
  }): void {
    const grant = first<{ grant_id: string }>(this.sql.exec(
      `SELECT grant_id FROM terminal_publication_grants WHERE grant_id = ?`,
      input.grantId,
    ));
    if (!grant) throw new Error("terminal_publication_grant_missing");
    this.sql.exec(
      `INSERT INTO repository_publications
         (publication_id, effect_intent_id, grant_id, repository_full_name, base_ref,
          head_ref, expected_old_sha, requested_commit_sha, state, title, body,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'publishing', ?, ?, ?, ?)
       ON CONFLICT(effect_intent_id) DO UPDATE SET grant_id = excluded.grant_id,
         expected_old_sha = excluded.expected_old_sha,
         requested_commit_sha = excluded.requested_commit_sha,
         state = 'publishing', title = excluded.title, body = excluded.body,
         failure_code = NULL, updated_at = excluded.updated_at`,
      input.publicationId,
      input.effectIntentId,
      input.grantId,
      input.repositoryFullName,
      input.baseRef,
      input.headRef,
      input.expectedOldSha,
      input.requestedCommitSha,
      input.title,
      input.body,
      input.now,
      input.now,
    );
  }

  completePublication(input: {
    effectIntentId: string;
    publishedSha: string;
    pullRequestNumber: number | null;
    pullRequestUrl: string | null;
    now: number;
  }): void {
    this.sql.exec(
      `UPDATE repository_publications
          SET state = 'completed', published_sha = ?, pull_request_number = ?,
              pull_request_url = ?, pull_request_state = 'open', completed_at = ?,
              updated_at = ?
        WHERE effect_intent_id = ?`,
      input.publishedSha,
      input.pullRequestNumber,
      input.pullRequestUrl,
      input.now,
      input.now,
      input.effectIntentId,
    );
  }

  /** Mark an interrupted publish ambiguous, never overwriting one that completed. */
  markPublicationAmbiguous(input: {
    effectIntentId: string;
    failureCode: string;
    now: number;
  }): void {
    this.sql.exec(
      `UPDATE repository_publications
          SET state = 'ambiguous', failure_code = ?, updated_at = ?
        WHERE effect_intent_id = ? AND state <> 'completed'`,
      input.failureCode,
      input.now,
      input.effectIntentId,
    );
  }
}
