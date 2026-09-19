import { z } from "zod";
import { IdSchema, WorkspaceIdSchema, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { ScopeInvitationDescriptionSchema, type ScopeInvitationCredential } from "@rally/contracts/scope-grants";
import { defineLinkPayload, issueLinkPayload, openLinkPayload } from "@rally/db/link-payloads";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workstreamDOName } from "../durable-objects/names";

/**
 * Everything the emailed link used to spell out in its fragment, now behind one
 * token.
 *
 * The recipient was never the audience for any of it: which workspace, which
 * work stream and which invitation are the *server's* routing, and publishing
 * them told a forwarded-to stranger the shape of a team they have no access to.
 * Only the secret was ever a credential, and it is no less of one in a row.
 */
const SCOPE_INVITATION_LINK = defineLinkPayload("inv", z.strictObject({
  workspaceId: WorkspaceIdSchema, parentId: IdSchema, invitationId: IdSchema, token: z.string().min(1),
}));
export type ScopeInvitationAddress = z.infer<typeof SCOPE_INVITATION_LINK.schema>;

/** One sentence for every unusable invitation: an unreadable token tells its holder no less and no more than a revoked one. */
export const UNAVAILABLE_INVITATION = "This invitation is unavailable. Ask the sender for a new invitation.";

/** Only the database: minting and reading a link is not a reason to hold a Worker's whole environment. */
type LinkStore = Pick<Env, "DB">;

/**
 * The token the email carries. It dies with the invitation it addresses, so an
 * expiring invitation does not leave a row behind that outlives it.
 */
export function issueScopeInvitationLink(
  env: LinkStore, address: ScopeInvitationAddress, expiresAt: number | null,
): Promise<string> {
  return issueLinkPayload(env.DB, SCOPE_INVITATION_LINK, address,
    { expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString() });
}

/** The whole fragment, so nothing beside the token names a parameter the recipient could read as a setting. */
export function scopeInvitationLinkUrl(origin: URL, token: string): URL {
  const link = new URL("/invite", origin);
  link.hash = token;
  return link;
}

/**
 * Where an invitation credential points, or null when this deployment cannot
 * say — a token of another kind, one edited in transit, one another deployment
 * issued, or one whose row has expired. All four owe their holder the same
 * answer as an invitation that was never minted.
 */
export async function openScopeInvitationCredential(
  env: LinkStore, credential: ScopeInvitationCredential,
): Promise<ScopeInvitationAddress | null> {
  if (!("link" in credential)) return credential;
  return openLinkPayload(env.DB, SCOPE_INVITATION_LINK, credential.link);
}

export function workstreamStub(env: Env, workspaceId: string, parentId: string) {
  return durableObjectStubForWorkspace(env, env.WORKSTREAM_DOS, workspaceId,
    workstreamDOName(env.AVALON_REGION, asWorkspaceId(workspaceId), asWorkstreamId(parentId)));
}

/**
 * The invited mailbox behind a credential, for a page that has to ask before
 * anyone is signed in. Null covers every reason the invitation cannot be
 * offered: the holder learns whether their link still works, never anything
 * about a workspace they have not joined.
 */
export async function describeScopeInvitation(
  env: Env, credential: ScopeInvitationCredential,
): Promise<{ email: string } | null> {
  const address = await openScopeInvitationCredential(env, credential);
  if (!address) return null;
  const description = ScopeInvitationDescriptionSchema.parse(
    await (await workstreamStub(env, address.workspaceId, address.parentId)).describeScopeInvitation(address));
  return description.status === "ready" ? { email: description.email } : null;
}
