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
   */
  #holdsLease(fence: BlockRunFence, now: number): boolean {
    return first(this.sql.exec<{ ok: number } & Record<string, SqlStorageValue>>(
      `SELECT 1 AS ok FROM runs
        WHERE run_id = ? AND legacy_attempt_id = ? AND lease_owner = ?
          AND status = 'running' AND terminalized_at IS NULL AND lease_expires_at > ?`,
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
   * Close a block run whose harness run was reaped for a lapsed lease.
   *
   * Deliberately unfenced on a live lease — an expired one is the sweep's whole
   * premise — and instead tied to the exact `terminalized_at` the reaper
   * stamped, so a run that has since been taken over is not settled by the
   * sweep that lost it. The same shape, and the same reason, as
   * `abandonRunReceipts`.
   */
  abandonBlockRun(input: { harnessRunId: string; terminalizedAt: number; errorJson: string }): number {
    return this.storage.transactionSync(() => {
      const terminal = first(this.sql.exec<{ ok: number } & Record<string, SqlStorageValue>>(
        `SELECT 1 AS ok FROM runs
          WHERE run_id = ? AND terminalized_at = ? AND origin = 'block_dashboard_block'`,
        input.harnessRunId,
        input.terminalizedAt,
      ));
      if (!terminal) return 0;
      this.sql.exec(
        `UPDATE block_dashboard_block_runs
            SET status = 'failed', completed_at = ?, error_json = ?
          WHERE run_id = ? AND status IN ('queued', 'running')`,
        input.terminalizedAt,
        input.errorJson,
        input.harnessRunId,
      );
      return this.#changed() ? 1 : 0;
    });
  }

  /**
   * Admit a dispatch: the configuration version it was planned against, and the
   * block run itself, or neither.
   *
   * One operation rather than two because the run row's foreign key is the
   * version row — a routed batch that landed the first and lost the second left
   * a version nothing referenced, and one that lost the first could not land
   * the second at all. `INSERT OR IGNORE` on the version because concurrent
   * blocks of one refresh all name it.
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
