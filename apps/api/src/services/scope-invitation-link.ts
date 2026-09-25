import { z } from "zod";
import { asWorkspaceId, IdSchema, WorkspaceIdSchema } from "@rally/contracts";
import { ScopeInvitationDescriptionSchema, type ScopeInvitationCredential } from "@rally/contracts/scope-grants";
import { defineLinkPayload, discardLinkPayloads, issueLinkPayload, openLinkPayload } from "@rally/db/link-payloads";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";

/**
 * Where the emailed link points, and nothing else.
 *
 * The recipient was never the audience for any of it: which workspace, which
 * work stream and which invitation are the *server's* routing, and publishing
 * them told a forwarded-to stranger the shape of a team they have no access to.
 *
 * **The acceptance secret is deliberately not in here.** The token that reads
 * this row *is* that secret — the owner holds its HMAC, this table holds its
 * SHA-256 — so no copy of either store carries anything a holder could present.
 * An earlier revision stored a second secret beside these three fields, which
 * made a dump of this table a set of working invitations through the addressed
 * request body that is still accepted.
 */
const SCOPE_INVITATION_LINK = defineLinkPayload("inv", z.strictObject({
  workspaceId: WorkspaceIdSchema, parentId: IdSchema, invitationId: IdSchema,
}));
export type ScopeInvitationTarget = z.infer<typeof SCOPE_INVITATION_LINK.schema>;

/** Where an invitation is, and the secret presented for it: one address, however the recipient's link spelled it. */
export type ScopeInvitationAddress = ScopeInvitationTarget & { token: string };

/** One sentence for every unusable invitation: an unreadable token tells its holder no less and no more than a revoked one. */
export const UNAVAILABLE_INVITATION = "This invitation is unavailable. Ask the sender for a new invitation.";

/** Only the database: minting and reading a link is not a reason to hold a Worker's whole environment. */
type LinkStore = Pick<Env, "DB">;

/**
 * The token the email carries. It dies with the invitation it addresses, so an
 * expiring invitation does not leave a row behind that outlives it.
 */
export function issueScopeInvitationLink(
  env: LinkStore, target: ScopeInvitationTarget, expiresAt: number | null,
): Promise<string> {
  return issueLinkPayload(env.DB, SCOPE_INVITATION_LINK, target,
    { expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString() });
}

/**
 * Drops links that were minted for an invitation this deployment then did not
 * record. Only the minting call can do this — a row is reachable by its token
 * alone — so a creation that mints before it commits cleans up after itself
 * rather than leaving a row nothing will ever resolve or sweep.
 */
export function discardScopeInvitationLinks(env: LinkStore, tokens: string[]): Promise<void> {
  return discardLinkPayloads(env.DB, tokens);
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
  const target = await openLinkPayload(env.DB, SCOPE_INVITATION_LINK, credential.link);
  // The token the holder presented is the secret the owner checks. Reading the
  // row proves only which invitation they are asking about.
  return target && { ...target, token: credential.link };
}

/** The Organization object, which hosts the parent that owns every invitation. */
export function parentStub(env: Env, workspaceId: string) {
  return durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)));
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
    await (await parentStub(env, address.workspaceId)).describeScopeInvitation(address));
  return description.status === "ready" ? { email: description.email } : null;
}
