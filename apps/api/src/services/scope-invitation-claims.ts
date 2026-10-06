import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";
import { diagnosticErrorCode, logWarn } from "../observability/logger";
import { dispatchWorkspaceRelationshipChanges } from "./workspace-relationship-delivery";

/** The Organization object, which hosts the parent that owns every share. */
export function parentStub(env: Env, workspaceId: string) {
  return durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)));
}

/**
 * Claims every share in this deployment addressed to one of the user's
 * verified mailboxes, so signing in is the whole of joining.
 *
 * `verifiedEmails` adds addresses the caller has verified that this
 * deployment's `user_verified_emails` may not hold yet, such as a Global
 * identity's address arriving in another region. Never pass an unverified
 * profile address: the mailbox is the only proof a share asks for.
 *
 * A Channel that cannot be reached is logged and left: its lookup row stays,
 * so the next sign-in tries it again, and a sign-in is never failed over a
 * share it could not yet claim.
 */
export async function claimScopeInvitations(env: Env, userId: string, verifiedEmails: string[] = []): Promise<void> {
  const known = await env.DB.prepare("SELECT email FROM user_verified_emails WHERE user_id = ?")
    .bind(userId).all<{ email: string }>();
  const emails = [...new Set([...known.results.map((row) => row.email), ...verifiedEmails].map((email) => email.toLowerCase()))];
  if (emails.length === 0) return;
  const routes = await env.DB.batch<{ workspace_id: string; parent_id: string }>(emails.map((email) =>
    env.DB.prepare("SELECT workspace_id, parent_id FROM scope_share_recipients WHERE email = ?").bind(email)));
  const parents = new Map(routes.flatMap((result) => result.results)
    .map((row) => [`${row.workspace_id}:${row.parent_id}`, row]));
  const joined = new Set<string>();
  for (const { workspace_id: workspaceId, parent_id: parentId } of parents.values()) {
    try {
      const claimed = await (await parentStub(env, workspaceId)).claimScopeInvitations({ workspaceId: asWorkspaceId(workspaceId), parentId, userId: asUserId(userId), emails });
      if (claimed.length > 0) joined.add(workspaceId);
    } catch (error) {
      logWarn(env, "scope_invitation_claim_failed", {
        workspace_id: workspaceId, workstream_id: parentId,
        error: diagnosticErrorCode(error, "scope_invitation_claim_failed"),
      });
    }
  }
  // A claim may have created the guest relationship. Publish it now rather
  // than on the next cron sweep, so the rest of the Organization hears of it.
  await Promise.all([...joined].map((workspaceId) => dispatchWorkspaceRelationshipChanges(env, { workspaceId, userId })
    .catch((error: unknown) => {
      logWarn(env, "workspace_relationship_dispatch_failed", {
        workspace_id: workspaceId, error: diagnosticErrorCode(error, "workspace_relationship_dispatch_failed"),
      });
    })));
}
