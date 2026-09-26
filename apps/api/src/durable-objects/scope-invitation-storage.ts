import { z } from "zod";
import { CreateScopeInvitationsSchema, ScopeInvitationSummarySchema,
  type CreateScopeInvitations, type ScopeInvitationSummary } from "@rally/contracts/scope-grants";
import { ScheduledAlarmStore } from "./scheduled-alarms";

/**
 * The Organization object's alarm kind for an invitation email. Its key is
 * `<parent id>:<invitation id>`, because one object now holds every Channel's
 * invitations.
 */
export const SCOPE_INVITATION_DELIVERY_ALARM = "parent_invitation_delivery";

/** The alarm key naming one parent's invitation. */
export function scopeInvitationAlarmKey(parentId: string, invitationId: string): string {
  return `${parentId}:${invitationId}`;
}

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

/** One parent's invitations; the caller authorizes immediately before each write. */
export class ScopeInvitationStorage {
  constructor(private readonly storage: DurableObjectStorage, private readonly parentId: string) {}

  read(id: string): ScopeInvitationRecord | null {
    const row = this.storage.sql.exec<{
      summary_json: string; actor_user_id: string; actor_incarnation: string;
      token_hash: string; delivery_encrypted: string; grant_operations_json: string; delivered_at: number | null;
      accepted_incarnation: string | null;
    }>("SELECT * FROM parent_invitations WHERE parent_id = ? AND id = ?", this.parentId, id).toArray()[0];
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
      "SELECT request_json, invitation_ids_json FROM parent_invitation_operations WHERE parent_id = ? AND operation_id = ?",
      this.parentId,
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
      "SELECT summary_json FROM parent_invitations WHERE parent_id = ? ORDER BY id DESC",
      this.parentId,
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
      this.storage.sql.exec(`INSERT INTO parent_invitation_operations
          (parent_id, operation_id, request_json, invitation_ids_json) VALUES (?, ?, ?, ?)`,
        this.parentId, request.operationId, JSON.stringify(request), JSON.stringify(invitations.map((invite) => invite.id)));
      return invitations.map((invite) => {
        const summary = ScopeInvitationSummarySchema.parse({ id: invite.id, email: invite.email,
          targets: request.targets, expiresAt: request.expiresAt, status: "pending", revision: 1, acceptedByUserId: null });
        this.storage.sql.exec(`INSERT INTO parent_invitations
          (parent_id,id,operation_id,actor_user_id,actor_incarnation,summary_json,token_hash,delivery_encrypted,grant_operations_json,created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, this.parentId, invite.id, request.operationId, request.actorUserId,
          actorIncarnation, JSON.stringify(summary), invite.tokenHash, invite.deliveryEncrypted, JSON.stringify(invite.grantOperationIds), Date.now());
        new ScheduledAlarmStore(this.storage.sql).schedule({ kind: SCOPE_INVITATION_DELIVERY_ALARM,
          key: scopeInvitationAlarmKey(this.parentId, invite.id), dueAt: Date.now() });
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
    this.storage.sql.exec("UPDATE parent_invitations SET summary_json = ?, accepted_incarnation = ? WHERE parent_id = ? AND id = ?",
      JSON.stringify(summary), incarnation, this.parentId, id);
    return summary;
  }

  revoke(id: string, expectedRevision: number): ScopeInvitationSummary | null {
    const record = this.read(id);
    if (!record || record.summary.revision !== expectedRevision || record.summary.status !== "pending") return null;
    const summary = ScopeInvitationSummarySchema.parse({ ...record.summary, status: "revoked", revision: expectedRevision + 1 });
    this.storage.sql.exec("UPDATE parent_invitations SET summary_json = ? WHERE parent_id = ? AND id = ?",
      JSON.stringify(summary), this.parentId, id);
    return summary;
  }

  acknowledgeDelivery(id: string): void {
    this.storage.sql.exec("UPDATE parent_invitations SET delivered_at = COALESCE(delivered_at, ?) WHERE parent_id = ? AND id = ?",
      Date.now(), this.parentId, id);
  }
}
