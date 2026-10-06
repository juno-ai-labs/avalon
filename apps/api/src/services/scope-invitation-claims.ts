import { z } from "zod";
import { asUserId, asWorkspaceId, IdSchema, WorkspaceIdSchema } from "@rally/contracts";
import type { ScopeInvitationSummary } from "@rally/contracts/scope-grants";
import { defineLinkPayload, openLinkPayload } from "@rally/db/link-payloads";
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

/** The user's verified addresses here, with any the caller verified itself, lowercased once. */
async function verifiedAddresses(env: Env, userId: string, verifiedEmails: string[]): Promise<string[]> {
  const known = await env.DB.prepare("SELECT email FROM user_verified_emails WHERE user_id = ?")
    .bind(userId).all<{ email: string }>();
  return [...new Set([...known.results.map((row) => row.email), ...verifiedEmails].map((email) => email.toLowerCase()))];
}

/**
 * Asks each Channel to claim what it holds for these addresses, and publishes
 * any guest relationship that created. A Channel that cannot be reached is
 * logged and left: its lookup row stays, so the next sign-in tries it again.
 */
async function claimFrom(env: Env, userId: string, emails: string[],
  parents: Iterable<{ workspaceId: string; parentId: string }>): Promise<ScopeInvitationSummary[]> {
  const claimed: ScopeInvitationSummary[] = [];
  const joined = new Set<string>();
  for (const { workspaceId, parentId } of parents) {
    try {
      const result = await (await parentStub(env, workspaceId)).claimScopeInvitations({
        workspaceId: asWorkspaceId(workspaceId), parentId, userId: asUserId(userId), emails });
      if (result.length > 0) joined.add(workspaceId);
      claimed.push(...result);
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
  return claimed;
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
 * Never fails a sign-in. Its callers await it on the sign-in path, so a
 * failed lookup is logged and the person signs in without the share; the
 * lookup rows are untouched, so the next sign-in tries again.
 */
export async function claimScopeInvitations(env: Env, userId: string, verifiedEmails: string[] = []): Promise<void> {
  try {
    const emails = await verifiedAddresses(env, userId, verifiedEmails);
    if (emails.length === 0) return;
    const routes = await env.DB.batch<{ workspace_id: string; parent_id: string }>(emails.map((email) =>
      env.DB.prepare("SELECT workspace_id, parent_id FROM scope_share_recipients WHERE email = ?").bind(email)));
    const parents = new Map(routes.flatMap((result) => result.results)
      .map((row) => [`${row.workspace_id}:${row.parent_id}`, { workspaceId: row.workspace_id, parentId: row.parent_id }]));
    await claimFrom(env, userId, emails, parents.values());
  } catch (error) {
    logWarn(env, "scope_invitation_claim_lookup_failed", {
      error: diagnosticErrorCode(error, "scope_invitation_claim_lookup_failed"),
    });
  }
}

/**
 * Where an invitation email sent before claiming existed points.
 *
 * Those emails carry an `inv_` token whose `link_payloads` row names the
 * Channel, and shares made then have no `scope_share_recipients` row, so the
 * token is the only way back to them. Reading it is routing, not proof: the
 * claim it leads to still requires one of the user's verified addresses.
 * Remove this once no such link can still be pending.
 */
const LEGACY_INVITATION_LINK = defineLinkPayload("inv", z.object({ workspaceId: WorkspaceIdSchema, parentId: IdSchema }));

/** Claims through an old emailed token for the signed-in user, returning what it claimed. */
export async function claimLegacyInvitationLink(env: Env, userId: string, link: string): Promise<ScopeInvitationSummary[]> {
  const target = await openLinkPayload(env.DB, LEGACY_INVITATION_LINK, link);
  if (!target) return [];
  const emails = await verifiedAddresses(env, userId, []);
  if (emails.length === 0) return [];
  return claimFrom(env, userId, emails, [target]);
}
