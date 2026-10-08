import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { ScopeInvitationSummary } from "@rally/contracts/scope-grants";
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
 * Publishes guest relationships that claims may have created, now rather than
 * on the next cron sweep, so the rest of the Organization hears of them.
 */
export async function publishJoined(env: Env, workspaceId: string, userIds: Iterable<string>): Promise<void> {
  await Promise.all([...new Set(userIds)].map((userId) => dispatchWorkspaceRelationshipChanges(env, { workspaceId, userId })
    .catch((error: unknown) => {
      logWarn(env, "workspace_relationship_dispatch_failed", {
        workspace_id: workspaceId, error: diagnosticErrorCode(error, "workspace_relationship_dispatch_failed"),
      });
    })));
}

/**
 * Asks each Channel, in parallel, to claim what it holds for these addresses.
 * A Channel that cannot be reached is logged and left: its lookup row stays,
 * so the next sign-in tries it again.
 */
async function claimFrom(env: Env, userId: string, emails: string[],
  parents: Iterable<{ workspaceId: string; parentId: string }>): Promise<ScopeInvitationSummary[]> {
  const results = await Promise.all([...parents].map(async ({ workspaceId, parentId }) => {
    try {
      return { workspaceId, claimed: await (await parentStub(env, workspaceId)).claimScopeInvitations({
        workspaceId: asWorkspaceId(workspaceId), parentId, userId: asUserId(userId), emails }) };
    } catch (error) {
      logWarn(env, "scope_invitation_claim_failed", {
        workspace_id: workspaceId, workstream_id: parentId,
        error: diagnosticErrorCode(error, "scope_invitation_claim_failed"),
      });
      return { workspaceId, claimed: [] };
    }
  }));
  const joined = new Set(results.filter((result) => result.claimed.length > 0).map((result) => result.workspaceId));
  await Promise.all([...joined].map((workspaceId) => publishJoined(env, workspaceId, [userId])));
  return results.flatMap((result) => result.claimed);
}

/**
 * Claims every share in this deployment addressed to one of the user's
 * verified addresses: signing in is the whole of joining.
 *
 * `verifiedEmail` is an address the caller verified that this deployment's
 * `user_verified_emails` may not hold yet, such as a Global identity's address
 * in another region. Never an unverified profile address.
 *
 * On the sign-in path, so it never fails it: a failed lookup is logged and the
 * rows stay for the next sign-in. With nothing pending it is one D1 read.
 */
export async function claimScopeInvitations(env: Env, userId: string, verifiedEmail?: string): Promise<void> {
  try {
    const routes = await env.DB.prepare(`SELECT email, workspace_id, parent_id FROM scope_share_recipients
      WHERE email IN (SELECT email FROM user_verified_emails WHERE user_id = ?) OR email = ?`)
      .bind(userId, verifiedEmail ?? null).all<{ email: string; workspace_id: string; parent_id: string }>();
    if (routes.results.length === 0) return;
    const emails = [...new Set(routes.results.map((row) => row.email.toLowerCase()))];
    const parents = new Map(routes.results.map((row) =>
      [`${row.workspace_id}:${row.parent_id}`, { workspaceId: row.workspace_id, parentId: row.parent_id }]));
    await claimFrom(env, userId, emails, parents.values());
  } catch (error) {
    logWarn(env, "scope_invitation_claim_lookup_failed", {
      error: diagnosticErrorCode(error, "scope_invitation_claim_lookup_failed"),
    });
  }
}
