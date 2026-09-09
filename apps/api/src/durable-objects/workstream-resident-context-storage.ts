import type { DurableObjectStorage, SqlStorage, SqlStorageValue } from "@cloudflare/workers-types";

import {
  applyCompactionToBlocks,
  isResidentContextKind,
  RESIDENT_CONTEXT_KIND_POLICIES,
  renderResidentContextSections,
  residentContextSourceId,
  type ResidentContextBlock,
  type ResidentContextKind,
  type ResidentContextResidency,
} from "../services/resident-context/blocks";

/**
 * The context-residency ledger: which resident context blocks this conversation
 * has loaded, at which content, and where each one currently lives.
 *
 * Object-local to the conversation object, beside the run-scoped tables, because
 * residency is a fact about *this* transcript: the same file loaded into two
 * conversations is two blocks. Rows are never deleted; a block that has left
 * both the transcript and the prompt keeps its row at `none`, which is the
 * bookkeeping of what was loaded previously. Every transition is one
 * synchronous transaction; the pure rules live in `blocks.ts` so the prepare
 * step before a compaction and the commit inside it agree byte for byte.
 *
 * Design: `docs/PRDs/2026-09-08_repository-instruction-files/prd.md`.
 */

interface BlockRow extends Record<string, SqlStorageValue> {
  kind: string;
  block_id: string;
  sha256: string;
  source_generation: number | null;
  content: string;
  truncated: number;
  residency: string;
  superseded: number;
  compactions_remaining: number;
  pending_delivery: number;
}

const BLOCK_COLUMNS = `kind, block_id, sha256, source_generation, content, truncated, residency,
       superseded, compactions_remaining, pending_delivery`;

function toBlock(row: BlockRow): ResidentContextBlock {
  if (!isResidentContextKind(row.kind)) throw new Error("resident_context_kind_unknown");
  return {
    kind: row.kind,
    blockId: row.block_id,
    sha256: row.sha256,
    sourceGeneration: row.source_generation === null ? null : Number(row.source_generation),
    content: row.content,
    truncated: row.truncated === 1,
    residency: row.residency as ResidentContextResidency,
    superseded: row.superseded === 1,
    compactionsRemaining: Number(row.compactions_remaining),
  };
}

export interface ResidentContextLoadedBlock {
  blockId: string;
  sha256: string;
  content: string;
  truncated: boolean;
}

export interface ResidentContextRecordOutcome {
  /** Newly recorded with a pending delivery; the model has not seen this content. */
  recorded: string[];
  /** Already in the transcript or the prompt at this content; nothing to deliver. */
  alreadyResident: string[];
}

/** One block awaiting delivery as a user-role message at the next settled step. */
export interface ResidentContextPendingDelivery {
  block: ResidentContextBlock;
  sourceKind: ResidentContextKind;
  sourceId: string;
}

export class WorkstreamResidentContextStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  /** Every block of a kind that is currently in context, as `<id>@<sha>` keys. */
  residentBlocks(input: { kind: ResidentContextKind }): string[] {
    return this.sql.exec<BlockRow>(
      `SELECT ${BLOCK_COLUMNS} FROM resident_context_blocks
        WHERE kind = ? AND residency IN ('transcript', 'system')
        ORDER BY block_id, sha256`,
      input.kind,
    ).toArray().map((row) => residentContextSourceId({ blockId: row.block_id, sha256: row.sha256 }));
  }

  /**
   * Record the blocks a load found, per the residency table: a block already in
   * context at this content is left alone; otherwise every other content for
   * the same id is retired (a transcript block to `none`, a prompt-resident one
   * flagged `superseded` so the prefix does not change mid-run) and the new
   * block is written in `transcript` residency with a pending delivery.
   */
  recordLoaded(input: {
    kind: ResidentContextKind;
    sourceGeneration: number | null;
    blocks: readonly ResidentContextLoadedBlock[];
    now: number;
  }): ResidentContextRecordOutcome {
    return this.storage.transactionSync(() => {
      const recorded: string[] = [];
      const alreadyResident: string[] = [];
      for (const block of input.blocks) {
        const existing = this.sql.exec<BlockRow>(
          `SELECT ${BLOCK_COLUMNS} FROM resident_context_blocks
            WHERE kind = ? AND block_id = ? AND sha256 = ?`,
          input.kind,
          block.blockId,
          block.sha256,
        ).toArray()[0];
        if (existing && existing.residency !== "none") {
          alreadyResident.push(block.blockId);
          continue;
        }
        this.sql.exec(
          `UPDATE resident_context_blocks
              SET residency = 'none', superseded = 0, compactions_remaining = 0, pending_delivery = 0
            WHERE kind = ? AND block_id = ? AND sha256 <> ? AND residency = 'transcript'`,
          input.kind,
          block.blockId,
          block.sha256,
        );
        this.sql.exec(
          `UPDATE resident_context_blocks
              SET superseded = 1
            WHERE kind = ? AND block_id = ? AND sha256 <> ? AND residency = 'system'`,
          input.kind,
          block.blockId,
          block.sha256,
        );
        const written = this.sql.exec<{ block_id: string } & Record<string, SqlStorageValue>>(
          `INSERT INTO resident_context_blocks
             (kind, block_id, sha256, source_generation, content, truncated, residency,
              superseded, compactions_remaining, pending_delivery, first_delivered_at, last_delivered_at)
           VALUES (?, ?, ?, ?, ?, ?, 'transcript', 0, 0, 1, ?, ?)
           ON CONFLICT(kind, block_id, sha256) DO UPDATE SET
             source_generation = excluded.source_generation,
             content = excluded.content,
             truncated = excluded.truncated,
             residency = 'transcript',
             superseded = 0,
             compactions_remaining = 0,
             pending_delivery = 1,
             last_delivered_at = excluded.last_delivered_at
           RETURNING block_id`,
          input.kind,
          block.blockId,
          block.sha256,
          input.sourceGeneration,
          block.content,
          block.truncated ? 1 : 0,
          input.now,
          input.now,
        ).toArray()[0];
        if (written?.block_id !== block.blockId) throw new Error("resident_context_record_failed");
        recorded.push(block.blockId);
      }
      return { recorded, alreadyResident };
    });
  }

  /**
   * Source invalidation: every block of a kind leaves context at once. The one
   * transition that changes the prefix mid-run, accepted because a replaced
   * checkout's instructions have no successor message to supersede them.
   */
  invalidateKind(input: { kind: ResidentContextKind }): { retired: number } {
    const retired = this.sql.exec<{ block_id: string } & Record<string, SqlStorageValue>>(
      `UPDATE resident_context_blocks
          SET residency = 'none', superseded = 0, compactions_remaining = 0, pending_delivery = 0
        WHERE kind = ? AND (residency <> 'none' OR pending_delivery = 1)
        RETURNING block_id`,
      input.kind,
    ).toArray();
    return { retired: retired.length };
  }

  /** Blocks recorded but not yet delivered to the model, in a stable order. */
  pendingDeliveries(): ResidentContextPendingDelivery[] {
    return this.sql.exec<BlockRow>(
      `SELECT ${BLOCK_COLUMNS} FROM resident_context_blocks
        WHERE pending_delivery = 1
        ORDER BY kind, block_id, sha256`,
    ).toArray().map((row) => {
      const block = toBlock(row);
      return { block, sourceKind: block.kind, sourceId: residentContextSourceId(block) };
    });
  }

  /**
   * Mark deliveries done. Synchronous so the caller can run it inside the same
   * transaction that appends the messages to the Bind loop; returns exactly
   * which keys it closed.
   */
  markDeliveredInTransaction(deliveries: readonly ResidentContextPendingDelivery[], now: number): string[] {
    const closed: string[] = [];
    for (const delivery of deliveries) {
      const row = this.sql.exec<{ block_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE resident_context_blocks
            SET pending_delivery = 0, last_delivered_at = ?
          WHERE kind = ? AND block_id = ? AND sha256 = ? AND pending_delivery = 1
          RETURNING block_id`,
        now,
        delivery.block.kind,
        delivery.block.blockId,
        delivery.block.sha256,
      ).toArray()[0];
      if (row?.block_id === delivery.block.blockId) closed.push(delivery.sourceId);
    }
    return closed;
  }

  allBlocks(): ResidentContextBlock[] {
    return this.sql.exec<BlockRow>(
      `SELECT ${BLOCK_COLUMNS} FROM resident_context_blocks ORDER BY kind, block_id, sha256`,
    ).toArray().map(toBlock);
  }

  /** The prompt sections for the committed ledger state, or null when nothing is prompt-resident. */
  renderSections(): string | null {
    return renderResidentContextSections(this.allBlocks());
  }

  /**
   * The prompt sections a compaction *would* leave behind, computed without
   * writing anything. Called before the replacement transition is built so the
   * compacted context's system message carries the blocks that were in the
   * transcript; `applyCompactionInTransaction` commits the same transitions.
   */
  prepareCompaction(): string | null {
    return renderResidentContextSections(applyCompactionToBlocks(this.allBlocks()));
  }

  /**
   * Commit the compaction transitions, once per compaction event. Synchronous
   * so it rides the transaction that persists the checkpoint and the Bind
   * replacement; a replayed commit finds its marker and changes nothing.
   */
  applyCompactionInTransaction(compactionEventId: string, now: number): { applied: boolean } {
    const marker = this.sql.exec<{ compaction_event_id: string } & Record<string, SqlStorageValue>>(
      `INSERT INTO resident_context_compactions (compaction_event_id, applied_at)
       VALUES (?, ?)
       ON CONFLICT(compaction_event_id) DO NOTHING
       RETURNING compaction_event_id`,
      compactionEventId,
      now,
    ).toArray()[0];
    if (!marker) return { applied: false };
    const before = this.allBlocks();
    const after = applyCompactionToBlocks(before);
    for (let index = 0; index < before.length; index += 1) {
      const previous = before[index]!;
      const next = after[index]!;
      if (previous.residency === next.residency
        && previous.superseded === next.superseded
        && previous.compactionsRemaining === next.compactionsRemaining) continue;
      this.sql.exec(
        `UPDATE resident_context_blocks
            SET residency = ?, superseded = ?, compactions_remaining = ?
          WHERE kind = ? AND block_id = ? AND sha256 = ?`,
        next.residency,
        next.superseded ? 1 : 0,
        next.compactionsRemaining,
        next.kind,
        next.blockId,
        next.sha256,
      );
    }
    return { applied: true };
  }

  /** The kind lifetimes this ledger applies, for tests and operators. */
  static lifetimeOf(kind: ResidentContextKind): number {
    return RESIDENT_CONTEXT_KIND_POLICIES[kind].lifetime;
  }
}
