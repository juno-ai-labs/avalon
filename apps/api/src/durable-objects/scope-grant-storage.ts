import {
  ScopeGrantMutationSchema,
  ScopeGrantMutationResultSchema,
  ScopeGrantSchema,
  ScopeGrantTargetSchema,
  ParticipantGrantMutationSchema,
  type ParticipantGrantMutation,
  type ScopeGrant,
  type ScopeGrantMutation,
  type ScopeGrantMutationResult,
  type ScopeGrantTarget,
} from "@rally/contracts/scope-grants";
import { IdSchema, SubstreamIdSchema, UserIdSchema, type UserId } from "@rally/contracts";
import { uuidV7 } from "../lib/uuid-v7";
import { z } from "zod";
import { ScheduledAlarmStore } from "./scheduled-alarms";

/** SQL counterpart of current-membership grant validity in resolveScopedAccess.
 * Callers use these fixed aliases and load the relationship before synchronous reads. */
export const CURRENT_MEMBER_GRANT_SQL = `json_extract(grant_row.grant_json, '$.active') = 1
  AND relationship.active = 1 AND json_extract(relationship.relationship_json, '$.status') = 'active'
  AND json_extract(grant_row.grant_json, '$.membershipIncarnation') = json_extract(relationship.relationship_json, '$.incarnation')`;

/** A Thread roster frozen for import into its parent's grants. */
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

/**
 * The Organization object's alarm kinds for a parent's grant work. Keys lead
 * with the parent id, because one object now holds every Channel's grants.
 */
export const PARTICIPANT_PROJECTION_ALARM = "parent_participant_projection";
export const PARTICIPANT_MIGRATION_ALARM = "parent_participant_migration";
export const ParticipantProjectionDeliverySchema = z.strictObject({
  substreamId: SubstreamIdSchema, projection: ParticipantProjectionSchema,
});

/** The alarm payload for one participant projection: the delivery plus the parent it belongs to. */
export const HostedParticipantProjectionAlarmSchema = z.strictObject({
  parentId: IdSchema, delivery: ParticipantProjectionDeliverySchema,
});

/** The alarm key naming one delivery of one participant projection. */
export function participantProjectionAlarmKey(parentId: string, substreamId: string, userId: string, revision: number): string {
  return `${parentId}:${substreamId}:${userId}:${revision}`;
}

/** The alarm key naming one parent's participant migration of one conversation. */
export function participantMigrationAlarmKey(parentId: string, substreamId: string): string {
  return `${parentId}:${substreamId}`;
}

const ParticipantImportResultSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  grantCount: z.number().int().nonnegative(),
});

/**
 * One parent's grants, called only after canonical actor admission.
 * It owns ordering and receipts, not user authentication or sharing policy.
 * No method awaits: the mutation, receipt and delivery intent commit together.
 *
 * Every table leads with `parent_id` and every statement names it: the rows of
 * every Channel in the Organization share these tables.
 */
export class ScopeGrantStorage {
  private readonly parent: Extract<ScopeGrantTarget, { kind: "workstream" }>;
  private readonly parentId: string;

  constructor(private readonly storage: DurableObjectStorage, address: { workspaceId: string; parentId: string },
    private readonly enqueueDirectory?: (grant: ScopeGrant, now: number) => void) {
    this.parent = ScopeGrantTargetSchema.options[0].parse({ kind: "workstream",
      workspaceId: address.workspaceId, parentId: address.parentId });
    this.parentId = this.parent.parentId;
  }

  /** This parent's grant revision, creating its counter on first use. */
  private nextRevision(): number {
    return this.storage.sql.exec<{ revision: number }>(
      `INSERT INTO parent_grant_revision (parent_id, revision) VALUES (?, 1)
       ON CONFLICT (parent_id) DO UPDATE SET revision = revision + 1 RETURNING revision`,
      this.parentId,
    ).one().revision;
  }

  private currentRevision(): number {
    return this.storage.sql.exec<{ revision: number }>(
      "SELECT revision FROM parent_grant_revision WHERE parent_id = ?", this.parentId,
    ).toArray()[0]?.revision ?? 0;
  }

  private assertTarget(target: ScopeGrantTarget): void {
    if (target.workspaceId !== this.parent.workspaceId || target.parentId !== this.parent.parentId) {
      throw new Error("scope_grant_parent_mismatch");
    }
  }

  read(userId: UserId, target: ScopeGrantTarget): ScopeGrant | null {
    this.assertTarget(target);
    const row = this.storage.sql.exec<{ grant_json: string }>(
      `SELECT grant_json FROM parent_grants WHERE parent_id = ? AND user_id = ? AND scope_kind = ? AND substream_id = ?`,
      this.parentId, userId, target.kind, target.kind === "workstream" ? "" : target.substreamId,
    ).toArray()[0];
    return row ? ScopeGrantSchema.parse(JSON.parse(row.grant_json)) : null;
  }

  forTarget(target: ScopeGrantTarget): ScopeGrant[] {
    this.assertTarget(target);
    return this.storage.sql.exec<{ grant_json: string }>(
      "SELECT grant_json FROM parent_grants WHERE parent_id=? AND scope_kind=? AND substream_id=? ORDER BY user_id",
      this.parentId, target.kind, target.kind === "workstream" ? "" : target.substreamId,
    ).toArray().map((row) => ScopeGrantSchema.parse(JSON.parse(row.grant_json)));
  }

  forUser(userId: UserId): ScopeGrant[] {
    return this.storage.sql.exec<{ grant_json: string }>(
      `SELECT grant_json FROM parent_grants WHERE parent_id = ? AND user_id = ? ORDER BY scope_kind, substream_id`,
      this.parentId, userId,
    ).toArray().map((row) => ScopeGrantSchema.parse(JSON.parse(row.grant_json)));
  }

  /** Where the stored row says its grant came from; null when there is no row. */
  sourceKind(userId: UserId, target: ScopeGrantTarget): "direct" | "space" | null {
    const row = this.storage.sql.exec<{ source_kind: string }>(
      "SELECT source_kind FROM parent_grants WHERE parent_id=? AND user_id=? AND scope_kind=? AND substream_id=?",
      this.parentId, userId, target.kind, target.kind === "workstream" ? "" : target.substreamId,
    ).toArray()[0];
    if (!row) return null;
    return row.source_kind === "space" ? "space" : "direct";
  }

  hasOperation(operationId: string): boolean {
    return this.storage.sql.exec("SELECT 1 FROM parent_grant_operations WHERE parent_id=? AND operation_id=?",
      this.parentId, operationId).toArray().length > 0;
  }

  /** Preserve the existing product rule that a scope retains a participant. */
  hasParticipantAfterRemoval(userId: UserId, target: ScopeGrantTarget, activeIncarnations: Record<string, string>): boolean {
    if (!this.read(userId,target)?.active) return true;
    const inherits = target.kind === "conversation" && (target.substreamId === "0" ||
      this.storage.sql.exec<{ audience: string }>("SELECT audience FROM parent_children WHERE parent_id=? AND substream_id=?",
        this.parentId, target.substreamId).toArray()[0]?.audience === "inherits_workstream");
    return this.storage.sql.exec<{ grant_json: string }>("SELECT grant_json FROM parent_grants WHERE parent_id=?", this.parentId)
      .toArray().some((row) => {
      const grant = ScopeGrantSchema.parse(JSON.parse(row.grant_json));
      if (!grant.active || grant.membershipIncarnation !== activeIncarnations[grant.userId]) return false;
      if (grant.userId === userId && grant.target.kind === target.kind
        && (grant.target.kind === "workstream" || (target.kind === "conversation" && grant.target.substreamId === target.substreamId))) return false;
      if (target.kind === "workstream") return grant.target.kind === "workstream";
      return grant.target.kind === "workstream" ? inherits : grant.target.substreamId === target.substreamId;
    });
  }

  /** Register only after the destination commits its authority transfer. */
  registerParticipantProjection(substreamId: string, transferId: string, previousUsers: readonly UserId[] = []): void {
    SubstreamIdSchema.parse(substreamId);
    IdSchema.parse(transferId);
    this.storage.transactionSync(() => {
      const existing = this.storage.sql.exec<{ transfer_id: string }>(
        "SELECT transfer_id FROM parent_participant_targets WHERE parent_id=? AND substream_id=?", this.parentId, substreamId,
      ).toArray()[0];
      if (existing) {
        if (existing.transfer_id !== transferId) throw new Error("participant_projection_target_conflict");
        return;
      }
      if (!this.storage.sql.exec("SELECT 1 FROM parent_children WHERE parent_id=? AND substream_id=? AND status='ready'",
        this.parentId, substreamId).toArray().length) {
        throw new Error("participant_projection_target_not_ready");
      }
      this.storage.sql.exec("INSERT INTO parent_participant_targets (parent_id,substream_id,transfer_id) VALUES (?,?,?)",
        this.parentId, substreamId, transferId);
      const revision = this.nextRevision();
      const users = this.storage.sql.exec<{ user_id: string }>("SELECT DISTINCT user_id FROM parent_grants WHERE parent_id=?",
        this.parentId).toArray();
      const userIds = new Set([...users.map((user) => UserIdSchema.parse(user.user_id)), ...previousUsers.map((user) => UserIdSchema.parse(user))]);
      for (const userId of userIds) this.queueParticipantProjection(substreamId, userId,userId,revision,Date.now());
    });
  }

  private queueParticipantProjection(substreamId: string, userId: UserId, actorUserId: UserId, revision: number, now: number, reason: "explicit" | "message" = "explicit"): void {
    const target = this.storage.sql.exec<{ transfer_id: string; audience: string }>(
      `SELECT target.transfer_id,child.audience FROM parent_participant_targets target
       JOIN parent_children child ON child.parent_id=target.parent_id AND child.substream_id=target.substream_id
       WHERE target.parent_id=? AND target.substream_id=?`, this.parentId, substreamId,
    ).toArray()[0];
    if (!target) return;
    const inherits = substreamId === "0" || target.audience === "inherits_workstream";
    const grants = this.forUser(userId);
    const incarnation = [...grants].sort((a,b) => b.revision-a.revision)[0]?.membershipIncarnation;
    const active = grants.some((grant) => grant.active && grant.membershipIncarnation === incarnation &&
      (grant.target.kind === "workstream" ? inherits : grant.target.substreamId === substreamId));
    const delivery = ParticipantProjectionDeliverySchema.parse({ substreamId, projection: {
      transferId: target.transfer_id, userId, revision, active, reason, addedByUserId: actorUserId, changedAt: now,
    } });
    const alarms = new ScheduledAlarmStore(this.storage.sql);
    const prior = this.storage.sql.exec<{ revision: number }>(
      "SELECT revision FROM parent_participant_deliveries WHERE parent_id=? AND substream_id=? AND user_id=?",
      this.parentId, substreamId, userId,
    ).toArray()[0];
    if (prior) alarms.cancel(PARTICIPANT_PROJECTION_ALARM, participantProjectionAlarmKey(this.parentId, substreamId, userId, prior.revision));
    this.storage.sql.exec(`INSERT INTO parent_participant_deliveries(parent_id,substream_id,user_id,revision,payload_json) VALUES (?,?,?,?,?)
      ON CONFLICT(parent_id,substream_id,user_id) DO UPDATE SET revision=excluded.revision,payload_json=excluded.payload_json,acknowledged_revision=NULL`,
    this.parentId,substreamId,userId,revision,JSON.stringify(delivery));
    alarms.schedule({ kind: PARTICIPANT_PROJECTION_ALARM, key: participantProjectionAlarmKey(this.parentId, substreamId, userId, revision),
      dueAt: now, payload: JSON.stringify(HostedParticipantProjectionAlarmSchema.parse({ parentId: this.parentId, delivery })) });
  }

  pendingParticipantProjection(substreamId: string, userId: string, revision?: number) {
    const row = this.storage.sql.exec<{ payload_json: string }>(
      `SELECT payload_json FROM parent_participant_deliveries WHERE parent_id=? AND substream_id=? AND user_id=? AND acknowledged_revision IS NULL${revision === undefined ? "" : " AND revision=?"}`,
      this.parentId,substreamId,userId,...(revision === undefined ? [] : [revision]),
    ).toArray()[0];
    return row ? ParticipantProjectionDeliverySchema.parse(JSON.parse(row.payload_json)) : null;
  }

  participantProjection(substreamId: string, userId: string) {
    const row = this.storage.sql.exec<{ payload_json: string }>(
      "SELECT payload_json FROM parent_participant_deliveries WHERE parent_id=? AND substream_id=? AND user_id=?",
      this.parentId, substreamId, userId,
    ).toArray()[0];
    return row ? ParticipantProjectionDeliverySchema.parse(JSON.parse(row.payload_json)).projection : null;
  }

  acknowledgeParticipantProjection(substreamId: string, userId: string, revision: number): void {
    this.storage.sql.exec(`UPDATE parent_participant_deliveries SET acknowledged_revision=revision
      WHERE parent_id=? AND substream_id=? AND user_id=? AND revision=?`,
      this.parentId,substreamId,userId,revision);
  }

  /**
   * Import a frozen source exactly once. The caller selects the legacy scope:
   * Main participation becomes parent authority; private rosters remain exact
   * conversation grants. A receipt fences replay after subsequent revocation.
   */
  importParticipants(target: ScopeGrantTarget, input: ParticipantTransferSnapshot, incarnations: Readonly<Record<string,string>> = {}): z.infer<typeof ParticipantImportResultSchema> {
    target = ScopeGrantTargetSchema.parse(target);
    this.assertTarget(target);
    const snapshot = ParticipantTransferSnapshotSchema.parse(input);
    const participants = [...snapshot.participants].sort((left, right) => left.userId.localeCompare(right.userId));
    if (new Set(participants.map((participant) => participant.userId)).size !== participants.length) {
      throw new Error("participant_import_duplicate_user");
    }
    const requestJson = JSON.stringify({ target, transferId: snapshot.transferId, participants });
    const substreamId = target.kind === "workstream" ? "" : target.substreamId;
    return this.storage.transactionSync(() => {
      const receipt = this.storage.sql.exec<{ request_json: string; result_json: string }>(
"SELECT request_json,result_json FROM parent_grant_imports WHERE parent_id=? AND scope_kind=? AND substream_id=?",
        this.parentId, target.kind, substreamId,
      ).toArray()[0];
      if (receipt) {
        if (receipt.request_json !== requestJson) throw new Error("participant_import_conflict");
        return ParticipantImportResultSchema.parse(JSON.parse(receipt.result_json));
      }
      // Never merge a late legacy snapshot into a scope already accepting writes.
      if (this.storage.sql.exec("SELECT 1 FROM parent_grants WHERE parent_id=? AND scope_kind=? AND substream_id=? LIMIT 1",
        this.parentId, target.kind, substreamId).toArray().length > 0) throw new Error("participant_import_scope_not_empty");
      for (const participant of participants) {
        const result = this.mutate({ operationId: uuidV7(), target, userId: participant.userId,
          actorUserId: participant.addedByUserId ?? participant.userId, active: true, expectedRevision: 0 }, incarnations[participant.userId] ?? null);
        if (result.status !== "committed") throw new Error("participant_import_write_failed");
      }
      const result = ParticipantImportResultSchema.parse({ grantCount: participants.length,
        revision: this.currentRevision() });
      this.storage.sql.exec("INSERT INTO parent_grant_imports (parent_id,scope_kind,substream_id,request_json,result_json) VALUES (?,?,?,?,?)",
        this.parentId, target.kind, substreamId, requestJson, JSON.stringify(result));
      return result;
    });
  }

  mutate(input: ScopeGrantMutation, membershipIncarnation: string | null = null): ScopeGrantMutationResult {
    const request = ScopeGrantMutationSchema.parse(input);
    this.assertTarget(request.target);
    const requestJson = JSON.stringify(request);
    return this.storage.transactionSync(() => {
      const receipt = this.storage.sql.exec<{ request_json: string; result_json: string }>(
        `SELECT request_json, result_json FROM parent_grant_operations WHERE parent_id = ? AND operation_id = ?`,
        this.parentId, request.operationId,
      ).toArray()[0];
      if (receipt) {
        if (receipt.request_json !== requestJson) return { status: "conflict", current: this.read(request.userId, request.target) };
        return ScopeGrantMutationResultSchema.parse(JSON.parse(receipt.result_json));
      }
      const current = this.read(request.userId, request.target);
      let result: ScopeGrantMutationResult;
      const now = Date.now();
      if ((current?.revision ?? 0) !== request.expectedRevision) {
        result = { status: "conflict", current };
      } else if (current && current.active === request.active
        && current.membershipIncarnation === membershipIncarnation
        // Equal admission is not equal provenance. An add over a row a Space
        // seated before migration 94 makes the Channel responsible for that
        // reader and must publish the shared directory projection even though
        // `active` stays true.
        && !(request.active && this.sourceKind(request.userId, request.target) === "space")) {
        result = { status: "committed", grant: current };
      } else {
        const revision = this.nextRevision();
        const grant = ScopeGrantSchema.parse({ id: current?.id ?? uuidV7(), userId: request.userId,
          target: request.target, active: request.active, revision, membershipIncarnation });
        const grantJson = JSON.stringify(grant);
        // Every write is the Channel's own decision, so it is direct and
        // published. A row a Space seated before migration 94 becomes direct
        // on its next write.
        this.storage.sql.exec(
          `INSERT INTO parent_grants (parent_id, user_id, scope_kind, substream_id, grant_json, source_kind, source_id)
           VALUES (?, ?, ?, ?, ?, 'direct', '')
           ON CONFLICT (parent_id, user_id, scope_kind, substream_id) DO UPDATE SET
             grant_json = excluded.grant_json,
             source_kind = excluded.source_kind, source_id = excluded.source_id`,
          this.parentId, request.userId, request.target.kind,
          request.target.kind === "workstream" ? "" : request.target.substreamId, grantJson,
        );
        if (!this.enqueueDirectory) throw new Error("scope_grant_directory_writer_required");
        this.enqueueDirectory(grant, now);
        result = { status: "committed", grant };
        const targets = this.storage.sql.exec<{ substream_id: string }>(
          `SELECT target.substream_id FROM parent_participant_targets target
           JOIN parent_children child ON child.parent_id=target.parent_id AND child.substream_id=target.substream_id
           WHERE target.parent_id=? AND ((?='workstream' AND (target.substream_id='0' OR child.audience='inherits_workstream'))
             OR (?='conversation' AND target.substream_id=?) OR EXISTS (
             SELECT 1 FROM parent_grants WHERE parent_id=target.parent_id AND user_id=?
               AND json_extract(grant_json,'$.membershipIncarnation') IS NOT ?))`,
          this.parentId, request.target.kind,request.target.kind,request.target.kind === "conversation" ? request.target.substreamId : "", request.userId, membershipIncarnation,
        ).toArray();
        for (const target of targets) this.queueParticipantProjection(target.substream_id, request.userId, request.actorUserId, revision, now, request.participationReason);
      }
      this.storage.sql.exec(
        `INSERT INTO parent_grant_operations (parent_id, operation_id, request_json, result_json, created_at) VALUES (?, ?, ?, ?, ?)`,
        this.parentId, request.operationId, requestJson, JSON.stringify(result), now,
      );
      return result;
    });
  }

  /** Legacy participant actions supply an operation identity but no revision. */
  mutateCurrent(input: ParticipantGrantMutation, membershipIncarnation: string | null = null): ScopeGrantMutationResult {
    const request = ParticipantGrantMutationSchema.parse(input);
    this.assertTarget(request.target);
    return this.storage.transactionSync(() => {
      const receipt = this.storage.sql.exec<{ request_json: string }>(
        "SELECT request_json FROM parent_grant_operations WHERE parent_id=? AND operation_id=?", this.parentId, request.operationId,
      ).toArray()[0];
      // Reuse the first attempt's revision. Reading today's revision on retry
      // would either conflict with the receipt or reapply an obsolete action.
      const expectedRevision = receipt
        ? ScopeGrantMutationSchema.parse(JSON.parse(receipt.request_json)).expectedRevision
        : this.read(request.userId,request.target)?.revision ?? 0;
      return this.mutate({ ...request,expectedRevision }, membershipIncarnation);
    });
  }
}
