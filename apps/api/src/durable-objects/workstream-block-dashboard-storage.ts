/**
 * Object-local HyperSight block state for one work stream.
 *
 * A block dashboard is a set of prompts a member pins to a work stream; each
 * refresh dispatches a harness run whose output is one block's markdown. The
 * three tables here are that record: the configuration version a refresh was
 * planned against, the per-block run rows, and each member's show/hide
 * preference.
 *
 * It exists for the reason `workstream-tool-receipt-storage.ts` does. These
 * rows were reached from the Worker by preparing D1-shaped SQL against a routed
 * handle: statements naming `block_dashboard_block_runs` were rewritten onto
 * `_runtime_block_dashboard_runs`, a compatibility view whose INSTEAD OF
 * triggers renamed `block_run_id` to `id` and `run_id` to `harness_run_id`,
 * invented `workspace_id` and `workstream_id` from the object's own identity
 * row, and converted unix milliseconds to ISO-8601 in both directions.
 *
 * The cost was not only vocabulary. Every write that had to hold the run's
 * lease restated that fence as an `EXISTS (SELECT 1 FROM harness_runs …)`
 * subquery, because a routed statement has no transaction to hold the answer
 * in. Here the fence is read once and the write follows in the same
 * `transactionSync`, so a caller cannot observe a block row that moved after
 * its lease did.
 *
 * Timestamps are unix milliseconds, the object's convention.
 */

/** What a block run is, in the object's own vocabulary. */
export type BlockRunStatus = "queued" | "running" | "completed" | "failed" | "stopped";

/**
 * The run-lease fence a member-visible write is evaluated under.
 *
 * `attemptId` is `runs.legacy_attempt_id`, for the reason
 * `workstream-tool-receipt-storage.ts` sets out: it is the text attempt
 * identity three compatibility views project, and it is dropped when the last
 * of the slices that read it lands.
 */
export interface BlockRunFence {
  harnessRunId: string;
  attemptId: string;
  owner: string;
}

/**
 * Whether a fenced write landed.
 *
 * Returned rather than thrown, as the receipt operations are, because an
 * exception crossing the RPC boundary arrives as an opaque string and the
 * caller has to tell "your lease is gone" — an ordinary end to a run — apart
 * from "the object failed".
 *
 * `ownership_lost` covers two states on purpose, and the PR description that
 * claimed otherwise was wrong. A lost lease and an already-settled block both
 * answer it: the first means another attempt speaks for this run now, the
 * second that this attempt is settling twice. The object can tell them apart
 * where the routed statement could not — it restated the fence inside the
 * `UPDATE` and read back one `meta.changes` count — but no caller does anything
 * different with the answer. Both end the write, both throw, and the extra
 * outcome bought a wider type and an error code nothing catches. If a caller
 * ever needs to retry one and not the other, split it then.
 */
export type BlockWriteOutcome = "written" | "ownership_lost";

export interface BlockRunRow extends Record<string, SqlStorageValue> {
  block_run_id: string;
  configuration_version_id: string;
  block_id: string;
  prompt: string;
  trigger_sequence: number;
  status: string;
  markdown: string | null;
  error_json: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

function first<T>(cursor: SqlStorageCursor<T extends Record<string, SqlStorageValue> ? T : never>) {
  return cursor.toArray()[0];
}

export class WorkstreamBlockDashboardStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  /**
   * The run's lease, read once inside the caller's transaction.
   *
   * The routed statements restated this as an `EXISTS` subquery on every write
   * because they had nowhere to hold the answer. Reading it here means the
   * decision and the write cannot be interleaved, so a lease that lapses
   * mid-operation is no longer a state a caller can observe.
   *
   * The three statuses are the ones the retired view called `running`: it read
   * `_runtime_harness_runs`, whose projection mapped `waiting` and `steering`
   * onto `running`, so the subquery this replaces accepted a run in any of
   * them. Nothing writes `waiting` or `steering` today — the `runs` CHECK
   * constraint admits them and several readers tolerate them, but no code path
   * produces one — so fencing on `running` alone would also pass. It is spelled
   * out anyway because the two are not equally safe to be wrong about: a
   * narrower fence answers a lease it does not recognise by writing nothing,
   * which is indistinguishable from a genuinely lost lease, so the first writer
   * of either status would silently drop block-dashboard writes rather than
   * fail somewhere anyone would look. Retiring a compatibility view should not
   * quietly narrow what the product accepts. The receipt storage's `#fence`
   * carries the same set for the same reason.
   */
  #holdsLease(fence: BlockRunFence, now: number): boolean {
    return first(this.sql.exec<{ ok: number } & Record<string, SqlStorageValue>>(
      `SELECT 1 AS ok FROM runs
        WHERE run_id = ? AND legacy_attempt_id = ? AND lease_owner = ?
          AND status IN ('running', 'waiting', 'steering')
          AND terminalized_at IS NULL AND lease_expires_at > ?`,
      fence.harnessRunId,
      fence.attemptId,
      fence.owner,
      now,
    )) !== undefined;
  }

  /** One block run, by its id and the run that owns it. */
  blockRun(input: { blockRunId: string; harnessRunId: string }): BlockRunRow | undefined {
    return first(this.sql.exec<BlockRunRow>(
      `SELECT block_run_id, configuration_version_id, block_id, prompt, trigger_sequence,
              status, markdown, error_json, created_at, started_at, completed_at
         FROM block_dashboard_block_runs
        WHERE block_run_id = ? AND run_id = ?`,
      input.blockRunId,
      input.harnessRunId,
    ));
  }

  /** The block run a harness run was dispatched for, if it is a block run at all. */
  blockRunForHarnessRun(input: { harnessRunId: string }): BlockRunRow | undefined {
    return first(this.sql.exec<BlockRunRow>(
      `SELECT block_run_id, configuration_version_id, block_id, prompt, trigger_sequence,
              status, markdown, error_json, created_at, started_at, completed_at
         FROM block_dashboard_block_runs
        WHERE run_id = ?`,
      input.harnessRunId,
    ));
  }

  /**
   * Whether this run's block already holds a persisted result.
   *
   * The parent terminalization reads this before it will call a HyperSight run
   * completed. A run whose block has no markdown has not produced the thing it
   * exists to produce, and saying otherwise leaves a member looking at an empty
   * block the product believes succeeded.
   */
  hasPersistedResult(input: { harnessRunId: string }): boolean {
    return first(this.sql.exec<{ ok: number } & Record<string, SqlStorageValue>>(
      `SELECT 1 AS ok FROM block_dashboard_block_runs
        WHERE run_id = ? AND status = 'completed' AND markdown IS NOT NULL`,
      input.harnessRunId,
    )) !== undefined;
  }

  /** The newest configuration version, or nothing when none has been written. */
  latestConfigurationVersionId(): string | undefined {
    return first(this.sql.exec<{ configuration_version_id: string } & Record<string, SqlStorageValue>>(
      `SELECT configuration_version_id FROM block_dashboard_configuration_versions
        ORDER BY version_number DESC LIMIT 1`,
    ))?.configuration_version_id;
  }

  /**
   * Record the partial markdown an in-flight block has produced so far.
   *
   * Fenced, because this is member-visible: a stale executor writing here would
   * overwrite what the attempt that replaced it is streaming.
   */
  submitMarkdown(input: {
    blockRunId: string;
    markdown: string;
    fence: BlockRunFence;
    now: number;
  }): BlockWriteOutcome {
    return this.storage.transactionSync(() => {
      if (!this.#holdsLease(input.fence, input.now)) return "ownership_lost";
      this.sql.exec(
        `UPDATE block_dashboard_block_runs SET markdown = ?
          WHERE block_run_id = ? AND run_id = ? AND status IN ('queued', 'running')`,
        input.markdown,
        input.blockRunId,
        input.fence.harnessRunId,
      );
      return this.#changed() ? "written" : "ownership_lost";
    });
  }

  /**
   * Settle a block run with the result its harness run produced.
   *
   * `completed` carries the markdown the member reads; `failed` and `stopped`
   * carry the reason instead. Both leave the row terminal, and the same fence
   * governs either, because the question is the same: is this still the attempt
   * entitled to speak for the block.
   */
  settleBlockRun(input: {
    blockRunId: string;
    status: Exclude<BlockRunStatus, "queued" | "running">;
    markdown: string | null;
    errorJson: string | null;
    fence: BlockRunFence;
    now: number;
  }): BlockWriteOutcome {
    return this.storage.transactionSync(() => {
      if (!this.#holdsLease(input.fence, input.now)) return "ownership_lost";
      this.sql.exec(
        `UPDATE block_dashboard_block_runs
            SET status = ?, markdown = ?, error_json = ?, completed_at = ?
          WHERE block_run_id = ? AND run_id = ? AND status IN ('queued', 'running')`,
        input.status,
        input.markdown,
        input.errorJson,
        input.now,
        input.blockRunId,
        input.fence.harnessRunId,
      );
      return this.#changed() ? "written" : "ownership_lost";
    });
  }

  /**
   * Move a block run through its lifecycle on the dispatching agent's authority.
   *
   * Unfenced on the run lease, deliberately and unchanged from the statement it
   * replaces. `BlockDashboardAgent` owns the dispatch: it is the thing that
   * decided this block would run, and it writes `running` before an executor
   * exists to hold a lease at all. The fenced write is `settleBlockRun`, which
   * is the *executor's* claim on the result and must prove it is still the
   * attempt entitled to make one.
   *
   * `started_at` is set once and never moved, so a retried dispatch reports when
   * the block first began rather than when it was last touched.
   */
  recordBlockRunProgress(input: {
    blockRunId: string;
    harnessRunId: string;
    status: BlockRunStatus;
    errorJson: string | null;
    now: number;
  }): number {
    this.sql.exec(
      `UPDATE block_dashboard_block_runs
          SET status = ?1, error_json = ?2,
              started_at = CASE WHEN ?1 = 'running' THEN COALESCE(started_at, ?3) ELSE started_at END,
              completed_at = CASE WHEN ?1 IN ('completed', 'failed', 'stopped') THEN ?3
                                  ELSE completed_at END
        WHERE block_run_id = ?4 AND run_id = ?5`,
      input.status,
      input.errorJson,
      input.now,
      input.blockRunId,
      input.harnessRunId,
    );
    return this.#changed();
  }

  /**
   * Close a block run whose harness run was reaped for a lapsed lease.
   *
   * Deliberately unfenced on a live lease — an expired one is the sweep's whole
   * premise — and instead tied to the exact `terminalized_at` the reaper
   * stamped, so a run that has since been taken over is not settled by the
   * sweep that lost it. The same shape, and the same reason, as the receipt
   * authority's own `settleResidualReceipts`, which the reaper calls first.
   */
  abandonBlockRun(input: { harnessRunId: string; terminalizedAt: number; errorJson: string }): number {
    return this.storage.transactionSync(() => {
      const terminal = first(this.sql.exec<{ ok: number } & Record<string, SqlStorageValue>>(
        `SELECT 1 AS ok FROM runs
          WHERE run_id = ? AND terminalized_at = ? AND origin = 'block_dashboard_block'`,
        input.harnessRunId,
        input.terminalizedAt,
      ));
      if (terminal) {
        this.sql.exec(
          `UPDATE block_dashboard_block_runs
              SET status = 'failed', completed_at = ?, error_json = ?
            WHERE run_id = ? AND status IN ('queued', 'running')`,
          input.terminalizedAt,
          input.errorJson,
          input.harnessRunId,
        );
      }
      const closed = terminal ? this.#changed() : 0;
      return closed + this.#closeOrphanedBlockRuns();
    });
  }

  /**
   * Close any block whose run is already terminal but which never settled.
   *
   * The repair for a partial failure the caller cannot avoid. Terminalizing the
   * run is a write to the regional database and closing its block is a write to
   * this object; no transaction spans them, so an RPC that fails in between
   * leaves a terminal run with an open block — and the sweep that would notice
   * selects `status = 'running' AND terminalized_at IS NULL`, which a
   * terminalized run no longer matches. Left alone that block spins forever in
   * front of a member.
   *
   * It is repairable here and nowhere else, because `runs` and
   * `block_dashboard_block_runs` are tables of the *same* object: the
   * inconsistency that needed two stores to create needs only one to see. Every
   * later `abandonBlockRun` on this work stream sweeps it, so the failure heals
   * on the next reap rather than persisting.
   *
   * Reached from both write paths that can see an orphan: every reap of this
   * work stream, whatever the reaped run's origin, and every dispatch admitted
   * to it. Neither alone is enough. Restricting the reap arm to HyperSight runs
   * would leave a work stream whose only later stale runs are ordinary ones
   * with the block still spinning, and a quiet work stream may never have
   * another stale run at all — but a dashboard that is refreshing is a
   * dashboard that dispatches, so the member's own next refresh clears it.
   * Neither path is a scheduled reconciliation, and this is not one: it is a
   * repair that rides on traffic the work stream was already generating, which
   * is what makes it worth having before slice 6 folds the sweep into the
   * object and closes the window itself.
   *
   * The reason recorded is this repair's own, not the reaping caller's. An
   * orphan's run may have ended any way at all — a lost lease, a stop, an
   * ordinary completion whose block write failed — and stamping it
   * `stale_run_reaped` because a reaper happened to be the one who noticed
   * would put a cause in front of a member that nobody established.
   *
   * `completed_at` comes from the run's own `terminalized_at` rather than from
   * the repairing caller's clock, so a block closed late still reports when its
   * run actually ended.
   */
  #closeOrphanedBlockRuns(): number {
    this.sql.exec(
      `UPDATE block_dashboard_block_runs
          SET status = 'failed',
              completed_at = (SELECT terminalized_at FROM runs WHERE runs.run_id = block_dashboard_block_runs.run_id),
              error_json = '{"code":"block_run_orphaned","message":"The refresh ended without settling this block"}'
        WHERE status IN ('queued', 'running')
          AND EXISTS (
            SELECT 1 FROM runs
             WHERE runs.run_id = block_dashboard_block_runs.run_id
               AND runs.terminalized_at IS NOT NULL
          )`,
    );
    return this.#changed();
  }

  /**
   * Admit a dispatch: the configuration version, the harness run, and the block
   * run — or none of them.
   *
   * All three, in one transaction, because they are one fact. The routed
   * version was a three-statement batch whose middle statement wrote `runs`
   * through a *different* slice's compatibility view, and the object executed
   * the batch atomically only as an accident of how the router happened to send
   * it. Splitting the block rows onto this port and leaving the run row routed
   * would have turned that accident into two round trips with a real window
   * between them, in which a block run exists whose run does not — the row that
   * `block_dashboard_block_runs.run_id` has a foreign key to.
   *
   * So the run row is written here rather than waiting for the harness-runs
   * slice to own it. The column set is what the retired
   * `_runtime_harness_runs_insert` trigger produced for a `scheduled` run:
   * `admitted` status, the main substream, a `{}` budget, zeroed counters, and
   * `started_at` defaulted to the creation instant.
   *
   * The retired rescue caught the UNIQUE violation and re-read the row by five
   * columns, one of which was `block_id`, and rethrew when it found none. This
   * compares only the row's own identity, and that is enough: `blockRunId` is a
   * fresh `uuidV7()` per dispatch (`workstream-do.ts:1101`), so for the pair to
   * recur under a different block you would need a UUIDv7 collision *and* the
   * same run id. Comparing `block_id` here would be a branch for an event that
   * cannot happen, and the guard it fed on the calling side is gone with it.
   */
  admitDispatch(input: {
    configurationVersionId: string;
    versionNumber: number;
    blocksJson: string;
    createdByUserId: string;
    configurationCreatedAt: number;
    blockRunId: string;
    blockId: string;
    prompt: string;
    triggerSequence: number;
    harnessRunId: string;
    executionPrincipalJson: string;
    model: string;
    createdAt: number;
  }): "admitted" | "already_admitted" {
    return this.storage.transactionSync(() => {
      const existing = this.blockRun({
        blockRunId: input.blockRunId,
        harnessRunId: input.harnessRunId,
      });
      if (existing) return "already_admitted";
      this.sql.exec(
        `INSERT OR IGNORE INTO block_dashboard_configuration_versions
           (configuration_version_id, version_number, blocks_json, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        input.configurationVersionId,
        input.versionNumber,
        input.blocksJson,
        input.createdByUserId,
        input.configurationCreatedAt,
      );
      // The run the block's work happens under. `INSERT OR IGNORE` for the same
      // reason the version row takes it: a redelivered dispatch names a run that
      // may already exist, and the block-run check above is what decides whether
      // this is a replay.
      this.sql.exec(
        `INSERT OR IGNORE INTO runs
           (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
            next_action_cursor, input_fence_seq, revision, started_at,
            active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
            tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
            origin, execution_principal_json, chain_depth, model, created_at, updated_at)
         VALUES (?, '0', 'admitted', '{}', 0, 0, '', 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                 'block_dashboard_block', ?, 0, ?, ?, ?)`,
        input.harnessRunId,
        input.createdAt,
        input.executionPrincipalJson,
        input.model,
        input.createdAt,
        input.createdAt,
      );
      this.sql.exec(
        `INSERT INTO block_dashboard_block_runs
           (block_run_id, configuration_version_id, block_id, prompt, trigger_sequence,
            run_id, status, markdown, error_json, created_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, NULL, NULL)`,
        input.blockRunId,
        input.configurationVersionId,
        input.blockId,
        input.prompt,
        input.triggerSequence,
        input.harnessRunId,
        input.createdAt,
      );
      // Every admitted dispatch also sweeps the work stream's orphans, so a
      // block stranded by a failed settlement is cleared by the next refresh
      // rather than waiting for a stale run that may never come.
      this.#closeOrphanedBlockRuns();
      return "admitted";
    });
  }

  /** Rows written by the statement that just ran, in this transaction. */
  #changed(): number {
    return this.sql.exec<{ changes: number } & Record<string, SqlStorageValue>>(
      `SELECT changes() AS changes`,
    ).one().changes;
  }
}
