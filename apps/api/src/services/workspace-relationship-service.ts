import { UserIdSchema, WorkspaceIdSchema } from "@rally/contracts";
import { WorkspaceRelationshipSchema, type WorkspaceRelationship } from "@rally/contracts/scope-grants";
export { WorkspaceRelationshipSchema, type WorkspaceRelationship } from "@rally/contracts/scope-grants";

const selection = `workspace_id AS workspaceId, user_id AS userId,
  access_class AS accessClass, role, status, incarnation, revision`;

export async function readWorkspaceRelationship(db: D1Database, workspaceId: string, userId: string): Promise<WorkspaceRelationship | null> {
  const row = await db.prepare(`SELECT ${selection} FROM workspace_members
    JOIN workspaces ON workspaces.id = workspace_members.workspace_id
    WHERE workspace_id = ? AND user_id = ? AND workspaces.abandoned_at IS NULL`)
    .bind(workspaceId, userId).first();
  return row ? WorkspaceRelationshipSchema.parse(row) : null;
}

/** Invitation admission calls this after verifying the recipient and target. Never reactivates a suspended relationship. */
export async function ensureGuestRelationship(db: D1Database, workspaceId: string, userId: string): Promise<WorkspaceRelationship> {
  WorkspaceIdSchema.parse(workspaceId);
  UserIdSchema.parse(userId);
  await db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role,access_class,status,joined_at)
    VALUES (?, ?, NULL, 'guest', 'active', ?) ON CONFLICT(workspace_id,user_id) DO NOTHING`)
    .bind(workspaceId, userId, new Date().toISOString()).run();
  const relationship = await readWorkspaceRelationship(db, workspaceId, userId);
  if (!relationship) throw new Error("workspace_relationship_missing_after_creation");
  return relationship;
}

/** The guarded write authorizes the actor and target in the same D1 statement. */
export async function promoteWorkspaceGuest(db: D1Database, input: {
  workspaceId: string; userId: string; actorUserId: string; incarnation: string; expectedRevision: number;
}): Promise<{ status: "promoted"; relationship: WorkspaceRelationship } | { status: "not_applied" }> {
  WorkspaceIdSchema.parse(input.workspaceId);
  UserIdSchema.parse(input.userId);
  UserIdSchema.parse(input.actorUserId);
  const row = await db.prepare(`UPDATE workspace_members SET access_class = 'member', role = 'member', revision = revision + 1
    WHERE workspace_id = ? AND user_id = ? AND access_class = 'guest' AND status = 'active'
      AND incarnation = ? AND revision = ?
      AND EXISTS (SELECT 1 FROM workspace_members actor JOIN workspaces workspace ON workspace.id = actor.workspace_id
        WHERE actor.workspace_id = ? AND actor.user_id = ? AND actor.status = 'active'
          AND actor.access_class = 'member' AND actor.role IN ('owner','admin') AND workspace.abandoned_at IS NULL)
    RETURNING ${selection}`)
    .bind(input.workspaceId, input.userId, input.incarnation, input.expectedRevision, input.workspaceId, input.actorUserId)
    .first();
  return row ? { status: "promoted", relationship: WorkspaceRelationshipSchema.parse(row) } : { status: "not_applied" };
}
