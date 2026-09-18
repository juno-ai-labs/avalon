import { z } from "zod";
import { CreateScopeInvitationsSchema, ScopeInvitationSummarySchema,
  type CreateScopeInvitations, type ScopeInvitationSummary } from "@rally/contracts/scope-grants";
import { ScheduledAlarmStore } from "./scheduled-alarms";

export const SCOPE_INVITATION_DELIVERY_ALARM = "scope_invitation_delivery";
export const SCOPE_INVITATION_SCHEMA_STATEMENTS = [
  `CREATE TABLE scope_invitation_operations (
    operation_id TEXT PRIMARY KEY, request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    invitation_ids_json TEXT NOT NULL CHECK(json_valid(invitation_ids_json))
  ) STRICT`,
  `CREATE TABLE scope_invitations (
    id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES scope_invitation_operations(operation_id),
    actor_user_id TEXT NOT NULL, actor_incarnation TEXT NOT NULL,
    summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
    token_hash TEXT NOT NULL UNIQUE, delivery_encrypted TEXT NOT NULL, grant_operations_json TEXT NOT NULL CHECK(json_valid(grant_operations_json)),
    delivered_at INTEGER, accepted_incarnation TEXT, created_at INTEGER NOT NULL
  ) STRICT`,
] as const;

export class ScopeInvitationOperationConflict extends Error {}

export interface ScopeInvitationRecord {
  summary: ScopeInvitationSummary;
  actorUserId: string;
  actorIncarnation: string;
  tokenHash: string;
  deliveryEncrypted: string;
  grantOperationIds: string[];
  deliveredAt: number | null;
  acceptedIncarnation: string | null;
}

/** Workstream-local ordering; the caller authorizes immediately before each write. */
export class ScopeInvitationStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  read(id: string): ScopeInvitationRecord | null {
    const row = this.storage.sql.exec<{
      summary_json: string; actor_user_id: string; actor_incarnation: string;
      token_hash: string; delivery_encrypted: string; grant_operations_json: string; delivered_at: number | null;
      accepted_incarnation: string | null;
    }>("SELECT * FROM scope_invitations WHERE id = ?", id).toArray()[0];
    return row ? {
      summary: ScopeInvitationSummarySchema.parse(JSON.parse(row.summary_json)),
      actorUserId: row.actor_user_id, actorIncarnation: row.actor_incarnation,
      tokenHash: row.token_hash, deliveryEncrypted: row.delivery_encrypted,
      grantOperationIds: z.array(z.string().uuid()).parse(JSON.parse(row.grant_operations_json)),
      deliveredAt: row.delivered_at, acceptedIncarnation: row.accepted_incarnation,
    } : null;
  }

  operation(input: CreateScopeInvitations): ScopeInvitationSummary[] | null {
    const request = CreateScopeInvitationsSchema.parse(input);
    const row = this.storage.sql.exec<{ request_json: string; invitation_ids_json: string }>(
      "SELECT request_json, invitation_ids_json FROM scope_invitation_operations WHERE operation_id = ?",
      request.operationId,
    ).toArray()[0];
    if (!row) return null;
    if (row.request_json !== JSON.stringify(request)) throw new ScopeInvitationOperationConflict("scope_invitation_operation_conflict");
    return z.array(z.string()).parse(JSON.parse(row.invitation_ids_json)).map((id) => {
      const record = this.read(id);
      if (!record) throw new Error("scope_invitation_receipt_missing");
      return record.summary;
    });
  }

  summaries(): ScopeInvitationSummary[] {
    return this.storage.sql.exec<{ summary_json: string }>(
      "SELECT summary_json FROM scope_invitations ORDER BY id DESC",
    ).toArray().map((row) => ScopeInvitationSummarySchema.parse(JSON.parse(row.summary_json)));
  }

  create(input: CreateScopeInvitations, actorIncarnation: string, invitations: Array<{
    id: string; email: string; tokenHash: string; deliveryEncrypted: string; grantOperationIds: string[];
  }>): ScopeInvitationSummary[] {
    const request = CreateScopeInvitationsSchema.parse(input);
    return this.storage.transactionSync(() => {
      const previous = this.operation(request);
      if (previous) return previous;
      const emails = [...new Set(request.emails)];
      if (invitations.length !== emails.length || invitations.some((invite, index) => invite.email !== emails[index] || invite.grantOperationIds.length !== request.targets.length)) {
        throw new Error("scope_invitation_recipient_mismatch");
      }
      this.storage.sql.exec("INSERT INTO scope_invitation_operations VALUES (?, ?, ?)",
        request.operationId, JSON.stringify(request), JSON.stringify(invitations.map((invite) => invite.id)));
      return invitations.map((invite) => {
        const summary = ScopeInvitationSummarySchema.parse({ id: invite.id, email: invite.email,
          targets: request.targets, expiresAt: request.expiresAt, status: "pending", revision: 1, acceptedByUserId: null });
        this.storage.sql.exec(`INSERT INTO scope_invitations
          (id,operation_id,actor_user_id,actor_incarnation,summary_json,token_hash,delivery_encrypted,grant_operations_json,created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, invite.id, request.operationId, request.actorUserId,
          actorIncarnation, JSON.stringify(summary), invite.tokenHash, invite.deliveryEncrypted, JSON.stringify(invite.grantOperationIds), Date.now());
        new ScheduledAlarmStore(this.storage.sql).schedule({ kind: SCOPE_INVITATION_DELIVERY_ALARM,
          key: invite.id, dueAt: Date.now() });
        return summary;
      });
    });
  }

  /** Called in the SAME transaction as grant activation. Never rebind an accepted invite. */
  accept(id: string, userId: string, incarnation: string): ScopeInvitationSummary {
    const record = this.read(id);
    if (!record || record.summary.status !== "pending") throw new Error("scope_invitation_not_pending");
    const summary = ScopeInvitationSummarySchema.parse({ ...record.summary, status: "accepted",
      acceptedByUserId: userId, revision: record.summary.revision + 1 });
    this.storage.sql.exec("UPDATE scope_invitations SET summary_json = ?, accepted_incarnation = ? WHERE id = ?",
      JSON.stringify(summary), incarnation, id);
    return summary;
  }

  revoke(id: string, expectedRevision: number): ScopeInvitationSummary | null {
    const record = this.read(id);
    if (!record || record.summary.revision !== expectedRevision || record.summary.status !== "pending") return null;
    const summary = ScopeInvitationSummarySchema.parse({ ...record.summary, status: "revoked", revision: expectedRevision + 1 });
    this.storage.sql.exec("UPDATE scope_invitations SET summary_json = ? WHERE id = ?", JSON.stringify(summary), id);
    return summary;
  }

  acknowledgeDelivery(id: string): void {
    this.storage.sql.exec("UPDATE scope_invitations SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ?", Date.now(), id);
  }
}
