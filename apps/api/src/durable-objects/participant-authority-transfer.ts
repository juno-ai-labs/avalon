import { z } from "zod";
import { IdSchema, UserIdSchema, WorkspaceIdSchema, SubstreamIdSchema } from "@rally/contracts";
import { startReadCursorAtLatest } from "./member-attention";

export const ParticipantTransferRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema, parentId: IdSchema, substreamId: SubstreamIdSchema, transferId: IdSchema,
  phase: z.enum(["prepare", "commit"]),
});
export type ParticipantTransferRequest = z.infer<typeof ParticipantTransferRequestSchema>;

export const ParticipantTransferSnapshotSchema = z.strictObject({
  transferId: IdSchema,
  participants: z.array(z.strictObject({
    userId: UserIdSchema,
    addedByUserId: UserIdSchema.nullable(),
    reason: z.string(),
    addedAt: z.number().int().nonnegative(),
  })),
});
export type ParticipantTransferSnapshot = z.infer<typeof ParticipantTransferSnapshotSchema>;

/** Effective access from the parent, after combining all applicable grants. */
export const ParticipantProjectionSchema = z.strictObject({
  transferId: IdSchema,
  userId: UserIdSchema,
  revision: z.number().int().positive(),
  active: z.boolean(),
  reason: z.enum(["creator", "explicit", "message", "elicitation", "action"]),
  addedByUserId: UserIdSchema.nullable(),
  changedAt: z.number().int().nonnegative(),
});
export type ParticipantProjection = z.infer<typeof ParticipantProjectionSchema>;
export type ParticipantProjectionResult = { status: "applied" | "unchanged" | "stale" | "conflict" | "not_ready" };

/** Source-side handoff. An empty table keeps existing authority unchanged. */
export const PARTICIPANT_AUTHORITY_TRANSFER_SCHEMA = [
  `CREATE TABLE participant_authority_transfer (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    transfer_id TEXT NOT NULL UNIQUE,
    phase TEXT NOT NULL CHECK (phase IN ('frozen', 'projection')),
    snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
    prepared_at INTEGER NOT NULL,
    committed_at INTEGER,
    projection_write INTEGER NOT NULL DEFAULT 0 CHECK (projection_write IN (0,1))
  ) STRICT`,
  `CREATE TABLE participant_projection_revisions (
    user_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0),
    request_json TEXT NOT NULL CHECK (json_valid(request_json))
  ) STRICT`,
  // Gate the actual ledger rather than a particular caller. Raw product SQL,
  // connector audience reconciliation and identity-port writes share this gate.
  `CREATE TRIGGER participant_authority_freeze_insert BEFORE INSERT ON participants
    WHEN EXISTS (SELECT 1 FROM participant_authority_transfer WHERE projection_write=0)
    BEGIN SELECT RAISE(ABORT, 'participant_authority_transferred'); END`,
  `CREATE TRIGGER participant_authority_freeze_delete BEFORE DELETE ON participants
    WHEN EXISTS (SELECT 1 FROM participant_authority_transfer WHERE projection_write=0)
    BEGIN SELECT RAISE(ABORT, 'participant_authority_transferred'); END`,
  `CREATE TRIGGER participant_authority_freeze_update
    BEFORE UPDATE OF user_id, status, participation_reason, added_by_user_id, added_at, removed_at, participant_epoch ON participants
    WHEN EXISTS (SELECT 1 FROM participant_authority_transfer WHERE projection_write=0)
    BEGIN SELECT RAISE(ABORT, 'participant_authority_transferred'); END`,
] as const;

/**
 * Forward-only handoff: once a snapshot is prepared, legacy roster mutations
 * stop. A failed parent import retries the same snapshot; it must never unfreeze
 * a source whose parent might already have committed after a lost response.
 * Only the versioned projection receiver can write after the handoff.
 */
export class ParticipantAuthorityTransferStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  currentTransferId(): string | null {
    return this.storage.sql.exec<{ transfer_id: string }>(
      "SELECT transfer_id FROM participant_authority_transfer WHERE singleton=1",
    ).toArray()[0]?.transfer_id ?? null;
  }

  projectionForUser(userId: string): ParticipantProjection | null {
    const row = this.storage.sql.exec<{ request_json: string }>(
      "SELECT request_json FROM participant_projection_revisions WHERE user_id=?", userId,
    ).toArray()[0];
    return row ? ParticipantProjectionSchema.parse(JSON.parse(row.request_json)) : null;
  }

  prepare(transferId: string): ParticipantTransferSnapshot {
    IdSchema.parse(transferId);
    return this.storage.transactionSync(() => {
      const existing = this.storage.sql.exec<{ transfer_id: string; snapshot_json: string }>(
        "SELECT transfer_id,snapshot_json FROM participant_authority_transfer WHERE singleton=1",
      ).toArray()[0];
      if (existing) {
        if (existing.transfer_id !== transferId) throw new Error("participant_transfer_conflict");
        return ParticipantTransferSnapshotSchema.parse(JSON.parse(existing.snapshot_json));
      }
      const participants = this.storage.sql.exec<{
        user_id: string; added_by_user_id: string | null; participation_reason: string; added_at: number;
      }>(`SELECT user_id,added_by_user_id,participation_reason,added_at FROM participants
        WHERE status='active' AND removed_at IS NULL ORDER BY added_at,user_id`).toArray();
      const snapshot = ParticipantTransferSnapshotSchema.parse({ transferId, participants: participants.map((row) => ({
        userId: row.user_id, addedByUserId: row.added_by_user_id, reason: row.participation_reason, addedAt: row.added_at,
      })) });
      this.storage.sql.exec(`INSERT INTO participant_authority_transfer
        (singleton,transfer_id,phase,snapshot_json,prepared_at) VALUES (1,?,'frozen',?,?)`,
      transferId,JSON.stringify(snapshot),Date.now());
      return snapshot;
    });
  }

  /** Called only after the parent durably commits the imported grant ledger. */
  commit(transferId: string): void {
    IdSchema.parse(transferId);
    const row = this.storage.sql.exec<{ transfer_id: string }>(
      "SELECT transfer_id FROM participant_authority_transfer WHERE singleton=1",
    ).toArray()[0];
    if (row?.transfer_id !== transferId) throw new Error("participant_transfer_conflict");
    this.storage.sql.exec(`UPDATE participant_authority_transfer SET phase='projection',committed_at=COALESCE(committed_at,?)
      WHERE singleton=1 AND transfer_id=?`,Date.now(),transferId);
  }

  applyProjection(input: ParticipantProjection): ParticipantProjectionResult {
    const request = ParticipantProjectionSchema.parse(input);
    const requestJson = JSON.stringify(request);
    return this.storage.transactionSync(() => {
      const transfer = this.storage.sql.exec<{ transfer_id: string; phase: string }>(
        "SELECT transfer_id,phase FROM participant_authority_transfer WHERE singleton=1",
      ).toArray()[0];
      if (!transfer || transfer.phase !== "projection") return { status: "not_ready" };
      if (transfer.transfer_id !== request.transferId) return { status: "conflict" };
      const receipt = this.storage.sql.exec<{ revision: number; request_json: string }>(
        "SELECT revision,request_json FROM participant_projection_revisions WHERE user_id=?", request.userId,
      ).toArray()[0];
      if (receipt && request.revision < receipt.revision) return { status: "stale" };
      if (receipt && request.revision === receipt.revision) {
        return { status: requestJson === receipt.request_json ? "unchanged" : "conflict" };
      }
      const prior = this.storage.sql.exec<{ status: string }>(
        "SELECT status FROM participants WHERE user_id=?", request.userId,
      ).toArray()[0];
      // This permission exists only inside the synchronous transaction. Both a
      // successful commit and rollback leave the legacy write fence closed.
      this.storage.sql.exec("UPDATE participant_authority_transfer SET projection_write=1 WHERE singleton=1");
      if (request.active && prior?.status !== "active") {
        this.storage.sql.exec(`INSERT INTO participants
          (user_id,participation_reason,added_by_user_id,status,participant_epoch,added_at,removed_at,first_opened_at,updated_at)
          VALUES (?,?,?,'active',0,?,NULL,NULL,?)
          ON CONFLICT(user_id) DO UPDATE SET status='active',removed_at=NULL,
            participation_reason=excluded.participation_reason,added_by_user_id=excluded.added_by_user_id,
            added_at=excluded.added_at,first_opened_at=NULL,updated_at=excluded.updated_at,
            participant_epoch=participants.participant_epoch+1`,
        request.userId,request.reason,request.addedByUserId,request.changedAt,request.changedAt);
        startReadCursorAtLatest(this.storage.sql, request.userId, request.changedAt,
          request.reason !== "message" && (request.addedByUserId ?? request.userId) !== request.userId);
      } else if (!request.active && prior?.status === "active") {
        this.storage.sql.exec(`UPDATE participants SET status='removed',removed_at=?,updated_at=?,
          participant_epoch=participant_epoch+1 WHERE user_id=?`,request.changedAt,request.changedAt,request.userId);
      }
      this.storage.sql.exec(`INSERT INTO participant_projection_revisions (user_id,revision,request_json) VALUES (?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,request_json=excluded.request_json`,
      request.userId,request.revision,requestJson);
      this.storage.sql.exec("UPDATE participant_authority_transfer SET projection_write=0 WHERE singleton=1");
      return { status: "applied" };
    });
  }
}
