import { UserIdSchema, type UserId } from "@rally/contracts";
import { z } from "zod";

import type { NamedAudienceSource } from "../lib/channel-audience";

/**
 * The legacy `WorkstreamDO` ledger's statements, frozen: migration 18 of that
 * ledger names them, and a shipped migration is never edited. The hosted
 * tables these became are in `hosted-parent-schema.ts`.
 *
 * Included in the parent object's versioned migrations, never run on the
 * request path. It sits here rather than in `workstream-do-schema.ts` for the
 * reason every other statement group does: the tables belong to the storage
 * class below, which is what has to be read to change them.
 */
export const WORKSTREAM_ACCESS_SCHEMA_STATEMENTS = [
  // The Channel's *own* audience, which stops being readable from
  // `workstream_metadata.scope` the moment a Space widens the Channel: after
  // that the metadata scope is the effective audience and no longer says
  // whether the Channel would still be Organization-wide without the Space.
  //
  // `updated_at = 0` marks a row nothing has observed yet. The backfill below
  // can only see objects that already exist; an object created *after* this
  // migration runs it in its constructor, before `reserveChild("0")` writes
  // any metadata, so its backfilled `personal` is a guess. The first Space
  // source seeds the real value from the reader audience it is handed, which
  // is exact because no Space had reached the Channel yet.
  `CREATE TABLE workstream_direct_audience (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `INSERT INTO workstream_direct_audience (id, scope, updated_at)
     SELECT 1, COALESCE((SELECT scope FROM workstream_metadata WHERE id = 1), 'personal'), 0`,
  `CREATE TABLE workstream_space_access_sources (
    space_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
    participants_json TEXT NOT NULL CHECK (json_valid(participants_json)),
    space_revision INTEGER NOT NULL CHECK (space_revision > 0),
    membership_generation INTEGER NOT NULL CHECK (membership_generation > 0),
    operation_id TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  // Who this source *seated*, which is narrower than who it lists: a reader
  // who was already here keeps whatever put them here, and withdrawing the
  // source must not take them with it. The cascade is what makes "a source
  // that no longer exists stops granting" true of the provenance as well as
  // of the audience.
  `CREATE TABLE workstream_space_supplied_readers (
    space_id TEXT NOT NULL REFERENCES workstream_space_access_sources(space_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    PRIMARY KEY (space_id, user_id)
  ) STRICT`,
  // One receipt table for every access operation rather than one per
  // operation, in the shape `scope_grant_operations` already uses: the
  // identity is the operation id, the fence is the exact request, and a
  // replay returns the first attempt's answer without reapplying it.
  `CREATE TABLE workstream_access_operations (
    operation_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at INTEGER NOT NULL
  ) STRICT`,
  // Where a grant came from. Existing rows are direct through the defaults,
  // which is what they were: nothing but a direct share could write one before
  // this migration.
  `ALTER TABLE scope_grants ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'direct'
     CHECK (source_kind IN ('direct', 'space'))`,
  `ALTER TABLE scope_grants ADD COLUMN source_id TEXT NOT NULL DEFAULT ''`,
] as const;

export const AudienceScopeSchema = z.enum(["personal", "workspace"]);
export type AudienceScope = z.infer<typeof AudienceScopeSchema>;

/** One Space source as this object holds it, with the fence it was applied on. */
export interface StoredAccessSource extends NamedAudienceSource {
  scope: AudienceScope;
  spaceRevision: number;
  membershipGeneration: number;
}

const ParticipantsSchema = z.array(UserIdSchema);

function sourceFromRow(row: {
  space_id: string;
  scope: string;
  participants_json: string;
  space_revision: number;
  membership_generation: number;
}): StoredAccessSource {
  return {
    sourceId: row.space_id,
    scope: AudienceScopeSchema.parse(row.scope),
    participantUserIds: ParticipantsSchema.parse(JSON.parse(row.participants_json)),
    spaceRevision: row.space_revision,
    membershipGeneration: row.membership_generation,
  };
}

/**
 * The Channel-local provenance behind its readers: which outside sources
 * currently reach it, and which readers each one seated.
 *
 * It is deliberately not a second permission store. Nothing here admits a
 * reader — `resolveScopeAccess` and the main conversation's scope and
 * participant rows still do that. What this owns is the question those two
 * cannot answer: *why* somebody may read, and therefore what has to be
 * withdrawn when one reason goes away. No method awaits, and each one commits
 * its own synchronous transaction, so a plan and the provenance it was
 * computed from can never disagree.
 */
export class WorkstreamAccessStorage {
  /**
   * One Channel's rows inside the Organization object. Every statement below
   * names `parent_id`: a statement that forgot it would read or rewrite the
   * provenance of every Channel in the Organization.
   */
  constructor(private readonly storage: DurableObjectStorage, private readonly parentId: string) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  /**
   * The Channel's own audience, and whether anything has ever established it.
   *
   * `observed` is false for a row that only ever held the migration's backfill.
   * See the table comment: for an object created after migration 18 that guess
   * is `personal` regardless of what the Channel was created as.
   */
  directAudience(): { scope: AudienceScope; observed: boolean } {
    const row = this.sql.exec<{ scope: string; updated_at: number }>(
      "SELECT scope, updated_at FROM parent_direct_audience WHERE parent_id = ?",
      this.parentId,
    ).toArray()[0];
    if (!row) return { scope: "personal", observed: false };
    return { scope: AudienceScopeSchema.parse(row.scope), observed: row.updated_at > 0 };
  }

  /**
   * Write the Channel's own audience, and whether anything established it.
   *
   * `observed` is false only for a restore putting back a row that was still
   * the migration's guess. Recording the scope while marking it observed would
   * tell the first Space to reach this Channel that the guess was a decision,
   * and stop it seeding the value it can still derive exactly.
   */
  recordDirectScope(scope: AudienceScope, now: number, observed = true): void {
    this.sql.exec(
      `INSERT INTO parent_direct_audience (parent_id, scope, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (parent_id) DO UPDATE SET scope = excluded.scope, updated_at = excluded.updated_at`,
      this.parentId,
      AudienceScopeSchema.parse(scope),
      // A recorded scope has to be distinguishable from the backfill, and the
      // caller's clock can be zero in a test that pins time.
      observed ? Math.max(now, 1) : 0,
    );
  }

  sources(): StoredAccessSource[] {
    return this.sql.exec<{
      space_id: string; scope: string; participants_json: string;
      space_revision: number; membership_generation: number;
    }>(
      `SELECT space_id, scope, participants_json, space_revision, membership_generation
         FROM parent_space_sources WHERE parent_id = ? ORDER BY space_id`,
      this.parentId,
    ).toArray().map(sourceFromRow);
  }

  source(spaceId: string): StoredAccessSource | null {
    const row = this.sql.exec<{
      space_id: string; scope: string; participants_json: string;
      space_revision: number; membership_generation: number;
    }>(
      `SELECT space_id, scope, participants_json, space_revision, membership_generation
         FROM parent_space_sources WHERE parent_id = ? AND space_id = ?`,
      this.parentId,
      spaceId,
    ).toArray()[0];
    return row ? sourceFromRow(row) : null;
  }

  upsertSource(input: {
    spaceId: string;
    scope: AudienceScope;
    participantUserIds: readonly UserId[];
    spaceRevision: number;
    membershipGeneration: number;
    operationId: string;
    now: number;
  }): void {
    this.sql.exec(
      `INSERT INTO parent_space_sources
         (parent_id, space_id, scope, participants_json, space_revision, membership_generation,
          operation_id, applied_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (parent_id, space_id) DO UPDATE SET
         scope = excluded.scope, participants_json = excluded.participants_json,
         space_revision = excluded.space_revision,
         membership_generation = excluded.membership_generation,
         operation_id = excluded.operation_id, updated_at = excluded.updated_at`,
      this.parentId,
      input.spaceId,
      AudienceScopeSchema.parse(input.scope),
      JSON.stringify(ParticipantsSchema.parse([...input.participantUserIds])),
      input.spaceRevision,
      input.membershipGeneration,
      input.operationId,
      input.now,
      input.now,
    );
  }

  /** Deletes the source and, through the cascade, its supplied readers. */
  deleteSource(spaceId: string): void {
    this.sql.exec("DELETE FROM parent_space_sources WHERE parent_id = ? AND space_id = ?", this.parentId, spaceId);
  }

  suppliedReaders(spaceId: string): UserId[] {
    return this.sql.exec<{ user_id: string }>(
      "SELECT user_id FROM parent_space_readers WHERE parent_id = ? AND space_id = ? ORDER BY user_id",
      this.parentId,
      spaceId,
    ).toArray().map((row) => UserIdSchema.parse(row.user_id));
  }

  recordSuppliedReaders(spaceId: string, userIds: readonly UserId[]): void {
    for (const userId of userIds) {
      this.sql.exec(
        `INSERT INTO parent_space_readers (parent_id, space_id, user_id) VALUES (?, ?, ?)
           ON CONFLICT (parent_id, space_id, user_id) DO NOTHING`,
        this.parentId,
        spaceId,
        UserIdSchema.parse(userId),
      );
    }
  }

  /**
   * Stop attributing this reader to any source.
   *
   * A direct add is the Channel taking responsibility for somebody: whatever
   * Space seated them first, they are now here on the Channel's own account
   * and a Space leaving must not take them with it.
   */
  claimReaderAsDirect(userId: UserId): void {
    this.sql.exec(
      "DELETE FROM parent_space_readers WHERE parent_id = ? AND user_id = ?",
      this.parentId,
      UserIdSchema.parse(userId),
    );
  }

  /**
   * Run one access operation exactly once.
   *
   * The receipt is the request and its result, so a redelivery converges on
   * the first attempt's answer and a *different* request under the same
   * operation id is a caller defect rather than a silent second application.
   * The body runs inside the same transaction as the receipt it earns, so
   * there is no state in which the work committed and the receipt did not.
   */
  operate<Result>(input: {
    operationId: string;
    request: unknown;
    resultSchema: z.ZodType<Result>;
    now: number;
    body: () => Result;
  }): Result {
    const requestJson = JSON.stringify(input.request);
    return this.storage.transactionSync(() => {
      const receipt = this.sql.exec<{ request_json: string; result_json: string }>(
        "SELECT request_json, result_json FROM parent_access_operations WHERE parent_id = ? AND operation_id = ?",
        this.parentId,
        input.operationId,
      ).toArray()[0];
      if (receipt) {
        if (receipt.request_json !== requestJson) throw new Error("workstream_access_operation_conflict");
        return input.resultSchema.parse(JSON.parse(receipt.result_json));
      }
      const result = input.resultSchema.parse(input.body());
      this.sql.exec(
        `INSERT INTO parent_access_operations (parent_id, operation_id, request_json, result_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        this.parentId,
        input.operationId,
        requestJson,
        JSON.stringify(result),
        input.now,
      );
      return result;
    });
  }
}
