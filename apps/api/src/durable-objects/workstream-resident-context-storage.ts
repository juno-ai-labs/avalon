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

  /**
   * Every block of a kind the model has seen at its current content, as
   * `<id>@<sha>` keys: the set a producer's gate checks against. A block
   * recorded but not yet delivered is not here, so a second mutation in the
   * same batch is refused like the first and only the retry after the settled
   * step proceeds. A superseded prompt block is still rendered but no longer
   * current, so it is not here either: a source that reverts to that content
   * is reported again and `recordLoaded` reinstates it.
   */
  residentBlocks(input: { kind: ResidentContextKind }): string[] {
    return this.sql.exec<BlockRow>(
      `SELECT ${BLOCK_COLUMNS} FROM resident_context_blocks
        WHERE kind = ? AND residency IN ('transcript', 'system') AND superseded = 0 AND pending_delivery = 0
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
   *
   * A prompt block that was superseded and whose content is loaded again (the
   * source reverted) stays in the prompt, is current again with a fresh
   * lifetime, and is delivered once more as a message, because the successor's
   * message may already say otherwise and a later message wins.
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
        if (existing && existing.residency !== "none" && existing.superseded === 0) {
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
        if (existing && existing.residency === "system") {
          const reinstated = this.sql.exec<{ block_id: string } & Record<string, SqlStorageValue>>(
            `UPDATE resident_context_blocks
                SET superseded = 0, compactions_remaining = ?, pending_delivery = 1,
                    source_generation = ?, last_delivered_at = ?
              WHERE kind = ? AND block_id = ? AND sha256 = ? AND residency = 'system'
              RETURNING block_id`,
            RESIDENT_CONTEXT_KIND_POLICIES[input.kind].lifetime,
            input.sourceGeneration,
            input.now,
            input.kind,
            block.blockId,
            block.sha256,
          ).toArray()[0];
          if (reinstated?.block_id !== block.blockId) throw new Error("resident_context_record_failed");
          recorded.push(block.blockId);
          continue;
        }
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

  /**
   * Every row of a registered kind. A row whose kind this build does not know
   * (left by a deploy that registered a kind and was rolled back) is skipped
   * rather than thrown on, because this read sits ahead of every model call.
   */
  allBlocks(): ResidentContextBlock[] {
    return this.sql.exec<BlockRow>(
      `SELECT ${BLOCK_COLUMNS} FROM resident_context_blocks ORDER BY kind, block_id, sha256`,
    ).toArray().filter((row) => isResidentContextKind(row.kind)).map(toBlock);
  }

  /** The prompt-resident rows only: what the render before every model call needs. */
  private systemBlocks(): ResidentContextBlock[] {
    return this.sql.exec<BlockRow>(
      `SELECT ${BLOCK_COLUMNS} FROM resident_context_blocks
        WHERE residency = 'system' ORDER BY kind, block_id, sha256`,
    ).toArray().filter((row) => isResidentContextKind(row.kind)).map(toBlock);
  }

  /** The prompt sections for the committed ledger state, or null when nothing is prompt-resident. */
  renderSections(): string | null {
    return renderResidentContextSections(this.systemBlocks());
  }

  /**
   * The prompt sections a compaction *would* leave behind. Called before the
   * replacement transition is built so the compacted context's system message
   * carries the blocks that were in the transcript. Block rows are not touched;
   * the event's row records exactly which blocks were rendered, so that
   * `applyCompactionInTransaction` moves those and only those. A block recorded
   * between the two (a background bootstrap, a concurrent tool) is absent from
   * the compacted system message and stays where it is, to be delivered as a
   * message and moved by the next compaction. Preparing the same event again
   * before it is applied replaces the prepared set; preparing an event already
   * applied (a replayed compaction) answers with the committed render, which is
   * what that compaction produced.
   */
  prepareCompaction(compactionEventId: string, now: number): string | null {
    const applied = this.sql.exec<{ applied_at: number | null } & Record<string, SqlStorageValue>>(
      `SELECT applied_at FROM resident_context_compactions WHERE compaction_event_id = ?`,
      compactionEventId,
    ).toArray()[0];
    if (applied && applied.applied_at !== null) return this.renderSections();
    const blocks = this.allBlocks();
    const keys = blocks
      .filter((block) => block.residency !== "none")
      .map((block) => [block.kind, block.blockId, block.sha256]);
    this.sql.exec(
      `INSERT INTO resident_context_compactions (compaction_event_id, prepared_keys, prepared_at, applied_at)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(compaction_event_id) DO UPDATE SET
         prepared_keys = excluded.prepared_keys,
         prepared_at = excluded.prepared_at
       WHERE applied_at IS NULL`,
      compactionEventId,
      JSON.stringify(keys),
      now,
    );
    return renderResidentContextSections(applyCompactionToBlocks(blocks));
  }

  /**
   * Commit the transitions prepared for a compaction event, once. Synchronous
   * so it rides the transaction that persists the checkpoint and the Bind
   * replacement. An event that was never prepared moves nothing, because the
   * compacted system message then carries no section and moving a block into
   * `system` would change the prefix mid-run; a replayed commit finds the event
   * applied and changes nothing.
   */
  applyCompactionInTransaction(
    compactionEventId: string,
    now: number,
  ): { applied: boolean; reason?: "not_prepared" | "already_applied" } {
    const prepared = this.sql.exec<{ prepared_keys: string; applied_at: number | null } & Record<string, SqlStorageValue>>(
      `SELECT prepared_keys, applied_at FROM resident_context_compactions WHERE compaction_event_id = ?`,
      compactionEventId,
    ).toArray()[0];
    if (!prepared) return { applied: false, reason: "not_prepared" };
    if (prepared.applied_at !== null) return { applied: false, reason: "already_applied" };
    const keys = new Set((JSON.parse(prepared.prepared_keys) as [string, string, string][])
      .map(([kind, blockId, sha256]) => `${kind}\u0000${blockId}\u0000${sha256}`));
    const before = this.allBlocks().filter((block) => keys.has(`${block.kind}\u0000${block.blockId}\u0000${block.sha256}`));
    const after = applyCompactionToBlocks(before);
    this.sql.exec(
      `UPDATE resident_context_compactions SET applied_at = ? WHERE compaction_event_id = ?`,
      now,
      compactionEventId,
    );
    for (let index = 0; index < before.length; index += 1) {
      const previous = before[index]!;
      const next = after[index]!;
      if (previous.residency === next.residency
        && previous.superseded === next.superseded
        && previous.compactionsRemaining === next.compactionsRemaining) continue;
      // A block promoted into the prompt is in context by that fact: a delivery
      // still pending for it would only say the same thing twice. A reinstated
      // block staying in the prompt keeps its re-delivery.
      const closePending = previous.residency === "transcript" || next.residency === "none";
      this.sql.exec(
        `UPDATE resident_context_blocks
            SET residency = ?, superseded = ?, compactions_remaining = ?,
                pending_delivery = CASE WHEN ? = 1 THEN 0 ELSE pending_delivery END
          WHERE kind = ? AND block_id = ? AND sha256 = ?`,
        next.residency,
        next.superseded ? 1 : 0,
        next.compactionsRemaining,
        closePending ? 1 : 0,
        next.kind,
        next.blockId,
        next.sha256,
      );
    }
    return { applied: true };
  }
}
