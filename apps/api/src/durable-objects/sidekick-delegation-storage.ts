import {
  SIDEKICK_DELEGATION_ERRORS,
  SidekickDelegationGrantSchema,
  SidekickDelegationMutationResultSchema,
  type SidekickDelegationGrant,
  type SidekickDelegationMutationResult,
} from "@rally/contracts";
import { ApiError } from "../lib/api-error";

/** New tables only: never change the released hosted Sidekick migration. */
export const SIDEKICK_DELEGATION_SCHEMA_STATEMENTS = [
  `CREATE TABLE sidekick_delegations (
    sidekick_id TEXT NOT NULL, user_id TEXT NOT NULL, grant_json TEXT NOT NULL CHECK(json_valid(grant_json)),
    PRIMARY KEY(sidekick_id,user_id)
  )`,
  `CREATE INDEX sidekick_delegations_by_user ON sidekick_delegations(user_id,sidekick_id)`,
  `CREATE TABLE sidekick_delegation_preparations (
    sidekick_id TEXT NOT NULL, operation_id TEXT NOT NULL, user_id TEXT NOT NULL,
    allowed INTEGER NOT NULL CHECK(allowed IN (0,1)), generation INTEGER NOT NULL,
    PRIMARY KEY(sidekick_id,operation_id)
  )`,
  `CREATE TABLE sidekick_delegation_receipts (
    sidekick_id TEXT NOT NULL, operation_id TEXT NOT NULL, intent_json TEXT NOT NULL CHECK(json_valid(intent_json)),
    result_json TEXT NOT NULL CHECK(json_valid(result_json)), generation INTEGER NOT NULL,
    PRIMARY KEY(sidekick_id,operation_id)
  )`,
] as const;

export interface SidekickDelegationMutation {
  sidekickId: string;
  userId: string;
  actorUserId: string;
  operationId: string;
  allowed: boolean;
  expectedGeneration: number;
  membershipIncarnation: string | null;
  source: SidekickDelegationGrant["source"];
  label: string;
}

/**
 * Single-object consent ordering, independent of execution authz propagation.
 * No awaits: each accepted intent, state transition and receipt commit together.
 */
export class SidekickDelegationStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  /** A retry of the same host intent can never refresh its observed generation. */
  prepare(sidekickId: string, userId: string, operationId: string, allowed: boolean): { generation: number } {
    return this.storage.transactionSync(() => {
      const prior = this.storage.sql.exec<{ user_id: string; allowed: number; generation: number }>(
        "SELECT user_id,allowed,generation FROM sidekick_delegation_preparations WHERE sidekick_id=? AND operation_id=?",
        sidekickId, operationId,
      ).toArray()[0];
      if (prior) {
        if (prior.user_id !== userId || (prior.allowed === 1) !== allowed) throw this.staleAction();
        return { generation: prior.generation };
      }
      const generation = this.read(sidekickId, userId)?.generation ?? 0;
      return this.storage.sql.exec<{ generation: number }>(
        `INSERT INTO sidekick_delegation_preparations(sidekick_id,operation_id,user_id,allowed,generation)
         VALUES (?,?,?,?,?) RETURNING generation`, sidekickId, operationId, userId, allowed ? 1 : 0, generation,
      ).one();
    });
  }

  read(sidekickId: string, userId: string): SidekickDelegationGrant | null {
    const row = this.storage.sql.exec<{ grant_json: string }>(
      "SELECT grant_json FROM sidekick_delegations WHERE sidekick_id=? AND user_id=?", sidekickId, userId,
    ).toArray()[0];
    return row ? SidekickDelegationGrantSchema.parse(JSON.parse(row.grant_json)) : null;
  }

  forSidekick(sidekickId: string): SidekickDelegationGrant[] {
    return this.storage.sql.exec<{ grant_json: string }>(
      `SELECT grant_json FROM sidekick_delegations WHERE sidekick_id=?
       ORDER BY json_extract(grant_json,'$.grantedAt'),user_id`, sidekickId,
    ).toArray().map((row) => SidekickDelegationGrantSchema.parse(JSON.parse(row.grant_json)));
  }

  forUser(userId: string): SidekickDelegationGrant[] {
    return this.storage.sql.exec<{ grant_json: string }>(
      "SELECT grant_json FROM sidekick_delegations WHERE user_id=? ORDER BY sidekick_id", userId,
    ).toArray().map((row) => SidekickDelegationGrantSchema.parse(JSON.parse(row.grant_json)));
  }

  mutate(input: SidekickDelegationMutation, now = Date.now()): SidekickDelegationMutationResult {
    return this.storage.transactionSync(() => {
      const current = this.read(input.sidekickId, input.userId);
      // Store intent as well as outcome so a receipt cannot be reused for another actor or intent.
      const intent = JSON.stringify({
        sidekickId: input.sidekickId, userId: input.userId, actorUserId: input.actorUserId,
        operationId: input.operationId, allowed: input.allowed, expectedGeneration: input.expectedGeneration, source: input.source,
      });
      const receipt = this.storage.sql.exec<{ intent_json: string; result_json: string; generation: number }>(
        "SELECT intent_json,result_json,generation FROM sidekick_delegation_receipts WHERE sidekick_id=? AND operation_id=?",
        input.sidekickId, input.operationId,
      ).toArray()[0];
      if (receipt) {
        if (receipt.intent_json !== intent || current?.generation !== receipt.generation) {
          throw this.staleAction();
        }
        return SidekickDelegationMutationResultSchema.parse(JSON.parse(receipt.result_json));
      }
      if (input.allowed && (current?.generation ?? 0) !== input.expectedGeneration) throw this.staleAction();
      if (input.allowed && input.membershipIncarnation === null) {
        throw new ApiError(409, "sidekick_delegation_membership_unavailable", SIDEKICK_DELEGATION_ERRORS.sidekick_delegation_membership_unavailable);
      }
      const changed = (current?.allowed ?? false) !== input.allowed ||
        (input.allowed && current?.membershipIncarnation !== input.membershipIncarnation);
      // A new withdrawal always advances the tombstone, including an absent grant.
      // A repeated allow at the current generation is a receipted no-op.
      const generation = (current?.generation ?? 0) + ((!input.allowed || changed) ? 1 : 0);
      const grant = SidekickDelegationGrantSchema.parse({
        sidekickId: input.sidekickId, userId: input.userId, allowed: input.allowed, generation,
        membershipIncarnation: input.allowed ? input.membershipIncarnation : current?.membershipIncarnation ?? null,
        source: input.source, actorUserId: input.actorUserId, requestId: input.operationId,
        label: input.allowed ? input.label : current?.label ?? "Unavailable Sidekick",
        grantedAt: input.allowed ? (changed ? now : current?.grantedAt ?? now) : current?.grantedAt ?? null,
        updatedAt: now,
      });
      const accepted = this.storage.sql.exec<{ grant_json: string }>(
        `INSERT INTO sidekick_delegations(sidekick_id,user_id,grant_json) VALUES (?,?,?)
         ON CONFLICT(sidekick_id,user_id) DO UPDATE SET grant_json=excluded.grant_json RETURNING grant_json`,
        input.sidekickId, input.userId, JSON.stringify(grant),
      ).one();
      const stored = SidekickDelegationGrantSchema.parse(JSON.parse(accepted.grant_json));
      const result = SidekickDelegationMutationResultSchema.parse({
        sidekickId: input.sidekickId, userId: input.userId, allowed: stored.allowed, changed,
      });
      this.storage.sql.exec(
        `INSERT INTO sidekick_delegation_receipts(sidekick_id,operation_id,intent_json,result_json,generation) VALUES (?,?,?,?,?)`,
        input.sidekickId, input.operationId, intent, JSON.stringify(result), stored.generation,
      );
      return result;
    });
  }

  private staleAction(): ApiError {
    return new ApiError(409, "sidekick_delegation_stale_action", SIDEKICK_DELEGATION_ERRORS.sidekick_delegation_stale_action);
  }
}
