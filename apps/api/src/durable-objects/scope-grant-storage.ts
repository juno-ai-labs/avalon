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
import { ParticipantProjectionSchema, ParticipantTransferSnapshotSchema, type ParticipantTransferSnapshot } from "./participant-authority-transfer";
import { ScheduledAlarmStore } from "./scheduled-alarms";

export const SCOPE_GRANT_DIRECTORY_ALARM = "scope_grant_directory";
export const PARTICIPANT_PROJECTION_ALARM = "participant_projection";
export const MAIN_PARTICIPANT_MIGRATION_ALARM = "main_participant_migration";
export const CHILD_PARTICIPANT_MIGRATION_ALARM = "child_participant_migration";
export const ParticipantProjectionDeliverySchema = z.strictObject({
  substreamId: SubstreamIdSchema, projection: ParticipantProjectionSchema,
});

const ParticipantImportResultSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  grantCount: z.number().int().nonnegative(),
});

/** Included in WorkstreamDO's versioned migrations, never run on the request path. */
export const SCOPE_GRANT_SCHEMA_STATEMENTS = [
  `CREATE TABLE scope_grant_revision (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0)
  ) STRICT`,
  `INSERT INTO scope_grant_revision (singleton, revision) VALUES (1, 0)`,
  `CREATE TABLE scope_grants (
    user_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('workstream', 'conversation')),
    substream_id TEXT NOT NULL,
    grant_json TEXT NOT NULL CHECK (json_valid(grant_json)),
    CHECK ((scope_kind = 'workstream' AND substream_id = '') OR
      (scope_kind = 'conversation' AND substream_id <> '')),
    PRIMARY KEY (user_id, scope_kind, substream_id)
  ) STRICT`,
  `CREATE TABLE scope_grant_operations (
    operation_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE scope_grant_deliveries (
    revision INTEGER PRIMARY KEY CHECK (revision > 0),
    grant_json TEXT NOT NULL CHECK (json_valid(grant_json)),
    actor_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  ) STRICT`,
  `CREATE INDEX scope_grant_deliveries_pending_idx ON scope_grant_deliveries(revision)
    WHERE delivered_at IS NULL`,
  `CREATE TABLE scope_grant_imports (
    scope_kind TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    PRIMARY KEY (scope_kind, substream_id)
  ) STRICT`,
  `CREATE TABLE participant_projection_targets (
    substream_id TEXT PRIMARY KEY, transfer_id TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE main_participant_migration (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), transfer_id TEXT NOT NULL,
    incarnations_json TEXT NOT NULL CHECK(json_valid(incarnations_json)),
    phase TEXT NOT NULL CHECK(phase IN ('pending','complete'))
  ) STRICT`,
  `CREATE TABLE child_participant_migrations (
    substream_id TEXT PRIMARY KEY, transfer_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('pending','complete'))
  ) STRICT`,
  `CREATE TRIGGER child_participant_authority_freeze_insert BEFORE INSERT ON private_child_memberships
    WHEN EXISTS(SELECT 1 FROM child_participant_migrations WHERE substream_id=NEW.substream_id)
    BEGIN SELECT RAISE(ABORT,'participant_authority_transferred'); END`,
  `CREATE TRIGGER child_participant_authority_freeze_update BEFORE UPDATE ON private_child_memberships
    WHEN EXISTS(SELECT 1 FROM child_participant_migrations WHERE substream_id IN (OLD.substream_id,NEW.substream_id))
    BEGIN SELECT RAISE(ABORT,'participant_authority_transferred'); END`,
  `CREATE TRIGGER child_participant_authority_freeze_delete BEFORE DELETE ON private_child_memberships
    WHEN EXISTS(SELECT 1 FROM child_participant_migrations WHERE substream_id=OLD.substream_id)
    BEGIN SELECT RAISE(ABORT,'participant_authority_transferred'); END`,
  `CREATE TABLE participant_projection_deliveries (
    substream_id TEXT NOT NULL, user_id TEXT NOT NULL,
    revision INTEGER NOT NULL, payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    acknowledged_revision INTEGER,
    PRIMARY KEY (substream_id,user_id)
  ) STRICT`,
] as const;

export interface ScopeGrantDelivery {
  grant: ScopeGrant;
  actorUserId: UserId;
}

/**
 * Workstream-local storage, called only after canonical actor admission.
 * It owns ordering and receipts, not user authentication or sharing policy.
 * No method awaits: the mutation, receipt and delivery intent commit together.
 */
export class ScopeGrantStorage {
  private readonly parent: Extract<ScopeGrantTarget, { kind: "workstream" }>;

  constructor(private readonly storage: DurableObjectStorage, address: { workspaceId: string; parentId: string }) {
    this.parent = ScopeGrantTargetSchema.options[0].parse({ kind: "workstream",
      workspaceId: address.workspaceId, parentId: address.parentId });
  }

  private assertTarget(target: ScopeGrantTarget): void {
    if (target.workspaceId !== this.parent.workspaceId || target.parentId !== this.parent.parentId) {
      throw new Error("scope_grant_parent_mismatch");
    }
  }

  read(userId: UserId, target: ScopeGrantTarget): ScopeGrant | null {
    this.assertTarget(target);
    const row = this.storage.sql.exec<{ grant_json: string }>(
      `SELECT grant_json FROM scope_grants WHERE user_id = ? AND scope_kind = ? AND substream_id = ?`,
      userId, target.kind, target.kind === "workstream" ? "" : target.substreamId,
    ).toArray()[0];
    return row ? ScopeGrantSchema.parse(JSON.parse(row.grant_json)) : null;
  }

  forTarget(target: ScopeGrantTarget): ScopeGrant[] {
    this.assertTarget(target);
    return this.storage.sql.exec<{ grant_json: string }>(
      "SELECT grant_json FROM scope_grants WHERE scope_kind=? AND substream_id=? ORDER BY user_id",
      target.kind, target.kind === "workstream" ? "" : target.substreamId,
    ).toArray().map((row) => ScopeGrantSchema.parse(JSON.parse(row.grant_json)));
  }

  forUser(userId: UserId): ScopeGrant[] {
    return this.storage.sql.exec<{ grant_json: string }>(
      `SELECT grant_json FROM scope_grants WHERE user_id = ? ORDER BY scope_kind, substream_id`, userId,
    ).toArray().map((row) => ScopeGrantSchema.parse(JSON.parse(row.grant_json)));
  }

  hasOperation(operationId: string): boolean {
    return this.storage.sql.exec("SELECT 1 FROM scope_grant_operations WHERE operation_id=?",operationId).toArray().length > 0;
  }

  /** Preserve the existing product rule that a scope retains a participant. */
  hasParticipantAfterRemoval(userId: UserId, target: ScopeGrantTarget): boolean {
    if (!this.read(userId,target)?.active) return true;
    const inherits = target.kind === "conversation" && (target.substreamId === "0" ||
      this.storage.sql.exec<{ audience: string }>("SELECT audience FROM conversation_children WHERE substream_id=?",target.substreamId)
        .toArray()[0]?.audience === "inherits_workstream");
    return this.storage.sql.exec<{ grant_json: string }>("SELECT grant_json FROM scope_grants").toArray().some((row) => {
      const grant = ScopeGrantSchema.parse(JSON.parse(row.grant_json));
      if (!grant.active) return false;
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
        "SELECT transfer_id FROM participant_projection_targets WHERE substream_id=?", substreamId,
      ).toArray()[0];
      if (existing) {
        if (existing.transfer_id !== transferId) throw new Error("participant_projection_target_conflict");
        return;
      }
      if (!this.storage.sql.exec("SELECT 1 FROM conversation_children WHERE substream_id=? AND status='ready'", substreamId).toArray().length) {
        throw new Error("participant_projection_target_not_ready");
      }
      this.storage.sql.exec("INSERT INTO participant_projection_targets (substream_id,transfer_id) VALUES (?,?)", substreamId,transferId);
      const revision = this.storage.sql.exec<{ revision: number }>(
        "UPDATE scope_grant_revision SET revision=revision+1 WHERE singleton=1 RETURNING revision",
      ).one().revision;
      const users = this.storage.sql.exec<{ user_id: string }>("SELECT DISTINCT user_id FROM scope_grants").toArray();
      const userIds = new Set([...users.map((user) => UserIdSchema.parse(user.user_id)), ...previousUsers.map((user) => UserIdSchema.parse(user))]);
      for (const userId of userIds) this.queueParticipantProjection(substreamId, userId,userId,revision,Date.now());
    });
  }

  private queueParticipantProjection(substreamId: string, userId: UserId, actorUserId: UserId, revision: number, now: number): void {
    const target = this.storage.sql.exec<{ transfer_id: string; audience: string }>(
      `SELECT target.transfer_id,child.audience FROM participant_projection_targets target
       JOIN conversation_children child ON child.substream_id=target.substream_id WHERE target.substream_id=?`, substreamId,
    ).toArray()[0];
    if (!target) return;
    const inherits = substreamId === "0" || target.audience === "inherits_workstream";
    const grants = this.forUser(userId);
    const incarnation = [...grants].sort((a,b) => b.revision-a.revision)[0]?.membershipIncarnation;
    const active = grants.some((grant) => grant.active && grant.membershipIncarnation === incarnation &&
      (grant.target.kind === "workstream" ? inherits : grant.target.substreamId === substreamId));
    const delivery = ParticipantProjectionDeliverySchema.parse({ substreamId, projection: {
      transferId: target.transfer_id, userId, revision, active, reason: "explicit", addedByUserId: actorUserId, changedAt: now,
    } });
    const alarms = new ScheduledAlarmStore(this.storage.sql);
    const prior = this.storage.sql.exec<{ revision: number }>(
      "SELECT revision FROM participant_projection_deliveries WHERE substream_id=? AND user_id=?", substreamId,userId,
    ).toArray()[0];
    if (prior) alarms.cancel(PARTICIPANT_PROJECTION_ALARM, `${substreamId}:${userId}:${prior.revision}`);
    this.storage.sql.exec(`INSERT INTO participant_projection_deliveries(substream_id,user_id,revision,payload_json) VALUES (?,?,?,?)
      ON CONFLICT(substream_id,user_id) DO UPDATE SET revision=excluded.revision,payload_json=excluded.payload_json,acknowledged_revision=NULL`,
    substreamId,userId,revision,JSON.stringify(delivery));
    alarms.schedule({ kind: PARTICIPANT_PROJECTION_ALARM, key: `${substreamId}:${userId}:${revision}`,
      dueAt: now, payload: JSON.stringify(delivery) });
  }

  pendingParticipantProjection(substreamId: string, userId: string, revision?: number) {
    const row = this.storage.sql.exec<{ payload_json: string }>(
      `SELECT payload_json FROM participant_projection_deliveries WHERE substream_id=? AND user_id=? AND acknowledged_revision IS NULL${revision === undefined ? "" : " AND revision=?"}`,
      substreamId,userId,...(revision === undefined ? [] : [revision]),
    ).toArray()[0];
    return row ? ParticipantProjectionDeliverySchema.parse(JSON.parse(row.payload_json)) : null;
  }

  participantProjection(substreamId: string, userId: string) {
    const row = this.storage.sql.exec<{ payload_json: string }>(
      "SELECT payload_json FROM participant_projection_deliveries WHERE substream_id=? AND user_id=?", substreamId,userId,
    ).toArray()[0];
    return row ? ParticipantProjectionDeliverySchema.parse(JSON.parse(row.payload_json)).projection : null;
  }

  acknowledgeParticipantProjection(substreamId: string, userId: string, revision: number): void {
    this.storage.sql.exec("UPDATE participant_projection_deliveries SET acknowledged_revision=revision WHERE substream_id=? AND user_id=? AND revision=?",
      substreamId,userId,revision);
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
        "SELECT request_json,result_json FROM scope_grant_imports WHERE scope_kind=? AND substream_id=?",
        target.kind, substreamId,
      ).toArray()[0];
      if (receipt) {
        if (receipt.request_json !== requestJson) throw new Error("participant_import_conflict");
        return ParticipantImportResultSchema.parse(JSON.parse(receipt.result_json));
      }
      // Never merge a late legacy snapshot into a scope already accepting writes.
      if (this.storage.sql.exec("SELECT 1 FROM scope_grants WHERE scope_kind=? AND substream_id=? LIMIT 1",
        target.kind, substreamId).toArray().length > 0) throw new Error("participant_import_scope_not_empty");
      for (const participant of participants) {
        const result = this.mutate({ operationId: uuidV7(), target, userId: participant.userId,
          actorUserId: participant.addedByUserId ?? participant.userId, active: true, expectedRevision: 0 }, incarnations[participant.userId] ?? null);
        if (result.status !== "committed") throw new Error("participant_import_write_failed");
      }
      const result = ParticipantImportResultSchema.parse({ grantCount: participants.length,
        revision: this.storage.sql.exec<{ revision: number }>("SELECT revision FROM scope_grant_revision WHERE singleton=1").one().revision });
      this.storage.sql.exec("INSERT INTO scope_grant_imports (scope_kind,substream_id,request_json,result_json) VALUES (?,?,?,?)",
        target.kind, substreamId, requestJson, JSON.stringify(result));
      return result;
    });
  }

  mutate(input: ScopeGrantMutation, membershipIncarnation: string | null = null): ScopeGrantMutationResult {
    const request = ScopeGrantMutationSchema.parse(input);
    this.assertTarget(request.target);
    const requestJson = JSON.stringify(request);
    return this.storage.transactionSync(() => {
      const receipt = this.storage.sql.exec<{ request_json: string; result_json: string }>(
        `SELECT request_json, result_json FROM scope_grant_operations WHERE operation_id = ?`, request.operationId,
      ).toArray()[0];
      if (receipt) {
        if (receipt.request_json !== requestJson) throw new Error("scope_grant_operation_reused");
        return ScopeGrantMutationResultSchema.parse(JSON.parse(receipt.result_json));
      }
      const current = this.read(request.userId, request.target);
      let result: ScopeGrantMutationResult;
      const now = Date.now();
      if ((current?.revision ?? 0) !== request.expectedRevision) {
        result = { status: "conflict", current };
      } else if (current && current.active === request.active && current.membershipIncarnation === membershipIncarnation) {
        result = { status: "committed", grant: current };
      } else {
        const revision = this.storage.sql.exec<{ revision: number }>(
          `UPDATE scope_grant_revision SET revision = revision + 1 WHERE singleton = 1 RETURNING revision`,
        ).one().revision;
        const grant = ScopeGrantSchema.parse({ id: current?.id ?? uuidV7(), userId: request.userId,
          target: request.target, active: request.active, revision, membershipIncarnation });
        const grantJson = JSON.stringify(grant);
        this.storage.sql.exec(
          `INSERT INTO scope_grants (user_id, scope_kind, substream_id, grant_json) VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id, scope_kind, substream_id) DO UPDATE SET grant_json = excluded.grant_json`,
          request.userId, request.target.kind,
          request.target.kind === "workstream" ? "" : request.target.substreamId, grantJson,
        );
        this.storage.sql.exec(
          `INSERT INTO scope_grant_deliveries (revision, grant_json, actor_user_id, created_at)
           VALUES (?, ?, ?, ?)`, revision, grantJson, request.actorUserId, now,
        );
        new ScheduledAlarmStore(this.storage.sql).schedule({ kind: SCOPE_GRANT_DIRECTORY_ALARM,
          key: "pending", dueAt: now, payload: null });
        result = { status: "committed", grant };
        const targets = this.storage.sql.exec<{ substream_id: string }>(
          `SELECT target.substream_id FROM participant_projection_targets target
           JOIN conversation_children child ON child.substream_id=target.substream_id
           WHERE (?='workstream' AND (target.substream_id='0' OR child.audience='inherits_workstream'))
             OR (?='conversation' AND target.substream_id=?) OR EXISTS (
             SELECT 1 FROM scope_grants WHERE user_id=? AND json_extract(grant_json,'$.membershipIncarnation') IS NOT ?)`,
          request.target.kind,request.target.kind,request.target.kind === "conversation" ? request.target.substreamId : "", request.userId, membershipIncarnation,
        ).toArray();
        for (const target of targets) this.queueParticipantProjection(target.substream_id, request.userId, request.actorUserId, revision, now);
      }
      this.storage.sql.exec(
        `INSERT INTO scope_grant_operations (operation_id, request_json, result_json, created_at) VALUES (?, ?, ?, ?)`,
        request.operationId, requestJson, JSON.stringify(result), now,
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
        "SELECT request_json FROM scope_grant_operations WHERE operation_id=?",request.operationId,
      ).toArray()[0];
      // Reuse the first attempt's revision. Reading today's revision on retry
      // would either conflict with the receipt or reapply an obsolete action.
      const expectedRevision = receipt
        ? ScopeGrantMutationSchema.parse(JSON.parse(receipt.request_json)).expectedRevision
        : this.read(request.userId,request.target)?.revision ?? 0;
      return this.mutate({ ...request,expectedRevision }, membershipIncarnation);
    });
  }

  pendingDeliveries(): ScopeGrantDelivery[] {
    return this.storage.sql.exec<{ grant_json: string; actor_user_id: string }>(
      `SELECT grant_json, actor_user_id FROM scope_grant_deliveries WHERE delivered_at IS NULL ORDER BY revision`,
    ).toArray().map((row) => ({ grant: ScopeGrantSchema.parse(JSON.parse(row.grant_json)),
      actorUserId: UserIdSchema.parse(row.actor_user_id) }));
  }

  /** Exact revision acknowledgement cannot acknowledge a later grant/revocation. */
  acknowledgeDelivery(revision: number): void {
    this.storage.sql.exec(
      `UPDATE scope_grant_deliveries SET delivered_at = ? WHERE revision = ? AND delivered_at IS NULL`,
      Date.now(), revision,
    );
  }
}
