import { asWorkspaceId } from "@rally/contracts";
import { WorkspaceRelationshipSchema } from "@rally/contracts/scope-grants";

import type { Env } from "../../src/env";
import { workspaceDOName } from "../../src/durable-objects/names";

/**
 * Deliveries are ordered by D1's own sequence in production. One counter for
 * the whole run keeps every event newer than the last, across tests too.
 */
let sequence = 0;

const RELATIONSHIP = `SELECT workspace_id AS workspaceId, user_id AS userId, access_class AS accessClass,
  role, status, incarnation, revision FROM workspace_members WHERE workspace_id = ? AND user_id = ?`;

/**
 * A D1 relationship write, then the `workspace_relationship_changed` event the
 * product dispatches for each person it touched, applied the way the
 * relationship consumer applies it (`WorkspaceDO.applyMemberStatus`).
 *
 * The Organization object answers access checks from its own copy of each
 * relationship, and the event is what keeps that copy current: a D1 write on
 * its own is not seen once the object has read that person. A person whose
 * row the write deleted is announced as removed, with the relationship they
 * had before it.
 */
export async function changeRelationships(
  env: Env,
  workspaceId: string,
  userIds: readonly string[],
  ...statements: D1PreparedStatement[]
): Promise<void> {
  const read = (userId: string) => env.DB.prepare(RELATIONSHIP).bind(workspaceId, userId).first();
  const before = new Map<string, unknown>();
  for (const userId of userIds) before.set(userId, await read(userId));
  if (statements.length > 0) await env.DB.batch(statements);
  const workspace = env.WORKSPACE_DOS.getByName(workspaceDOName("global", asWorkspaceId(workspaceId)));
  for (const userId of userIds) {
    const after = await read(userId);
    const known = after ?? before.get(userId);
    if (!known) throw new Error(`no relationship to announce for ${userId}`);
    sequence += 1;
    await workspace.applyMemberStatus({
      workspaceId, sequence, removed: after === null, relationship: WorkspaceRelationshipSchema.parse(known),
    });
  }
}
