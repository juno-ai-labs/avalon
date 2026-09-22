import {
  ImpersonationRelationshipSchema,
  type ImpersonationRelationship,
} from "@rally/contracts";

interface RelationshipRow extends Record<string, SqlStorageValue> {
  workspace_id: string;
  impersonator_user_id: string;
  represented_user_id: string;
  authority_basis: string;
  created_at: string;
  revoked_at: string | null;
}

function relationship(row: RelationshipRow): ImpersonationRelationship {
  return ImpersonationRelationshipSchema.parse({
    workspaceId: row.workspace_id,
    impersonatorUserId: row.impersonator_user_id,
    representedUserId: row.represented_user_id,
    authorityBasis: row.authority_basis,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  });
}

/** WorkspaceDO-local authority for directed can-impersonate relationships. */
export class WorkspaceImpersonationStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql() {
    return this.storage.sql;
  }

  upsert(input: {
    workspaceId: string;
    relationships: Array<{
      impersonatorUserId: string;
      representedUserId: string;
      authorityBasis: string;
    }>;
    now: string;
  }): { active: number } {
    this.storage.transactionSync(() => {
      for (const item of input.relationships) {
        this.sql.exec(
          `INSERT INTO workspace_impersonation_relationships
             (workspace_id, impersonator_user_id, represented_user_id, authority_basis, created_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, NULL)
           ON CONFLICT(workspace_id, impersonator_user_id, represented_user_id, authority_basis)
           DO UPDATE SET created_at = excluded.created_at,
                         revoked_at = NULL`,
          input.workspaceId,
          item.impersonatorUserId,
          item.representedUserId,
          item.authorityBasis,
          input.now,
        );
      }
    });
    return { active: input.relationships.length };
  }

  authorize(workspaceId: string, impersonatorUserId: string, representedUserId: string): ImpersonationRelationship | null {
    const row = this.sql.exec<RelationshipRow>(
      `SELECT workspace_id, impersonator_user_id, represented_user_id, authority_basis, created_at, revoked_at
         FROM workspace_impersonation_relationships
        WHERE workspace_id = ? AND impersonator_user_id = ? AND represented_user_id = ?
          AND revoked_at IS NULL
        ORDER BY created_at DESC, authority_basis
        LIMIT 1`,
      workspaceId,
      impersonatorUserId,
      representedUserId,
    ).toArray()[0];
    return row ? relationship(row) : null;
  }

  list(workspaceId: string, impersonatorUserId: string): ImpersonationRelationship[] {
    const rows = this.sql.exec<RelationshipRow>(
      `SELECT workspace_id, impersonator_user_id, represented_user_id, authority_basis, created_at, revoked_at
         FROM workspace_impersonation_relationships
        WHERE workspace_id = ? AND impersonator_user_id = ? AND revoked_at IS NULL
        ORDER BY represented_user_id, created_at DESC, authority_basis`,
      workspaceId,
      impersonatorUserId,
    ).toArray();
    const unique = new Map<string, RelationshipRow>();
    for (const row of rows) unique.set(row.represented_user_id, unique.get(row.represented_user_id) ?? row);
    return [...unique.values()].map(relationship);
  }

  revoke(input: {
    workspaceId: string;
    authorityBasis?: string;
    impersonatorUserId?: string;
    representedUserId?: string;
    now: string;
  }): { revoked: number } {
    if (!input.authorityBasis && !input.impersonatorUserId && !input.representedUserId) {
      throw new Error("impersonation_revocation_filter_required");
    }
    const filters = ["workspace_id = ?", "revoked_at IS NULL"];
    const values: string[] = [input.workspaceId];
    if (input.authorityBasis) { filters.push("authority_basis = ?"); values.push(input.authorityBasis); }
    if (input.impersonatorUserId) { filters.push("impersonator_user_id = ?"); values.push(input.impersonatorUserId); }
    if (input.representedUserId) { filters.push("represented_user_id = ?"); values.push(input.representedUserId); }
    this.sql.exec(
      `UPDATE workspace_impersonation_relationships SET revoked_at = ? WHERE ${filters.join(" AND ")}`,
      input.now,
      ...values,
    );
    return { revoked: this.sql.exec<{ changes: number }>("SELECT changes() AS changes").one().changes };
  }
}
