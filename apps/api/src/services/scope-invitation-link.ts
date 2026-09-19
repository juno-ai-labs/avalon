import { z } from "zod";
import { IdSchema, WorkspaceIdSchema, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { codeShaped, describeZodIssues } from "@rally/contracts/zod-diagnostics";
import { ScopeInvitationDescriptionSchema, type ScopeInvitationCredential } from "@rally/contracts/scope-grants";
import type { Env } from "../env";
import { openPayload, sealPayload } from "../lib/crypto";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workstreamDOName } from "../durable-objects/names";

/**
 * Bound into the sealed link so a credential minted here cannot be presented to
 * another opener of the same key, and so a future kind of link reusing this
 * primitive cannot be confused with an invitation.
 */
const SCOPE_INVITATION_LINK_PURPOSE = "scope-invitation-link";

/**
 * Everything the emailed link used to spell out in its fragment, now sealed.
 *
 * The recipient was never the audience for any of it: which workspace, which
 * work stream and which invitation are the *server's* routing, and publishing
 * them told a forwarded-to stranger the shape of a team they have no access to.
 * Only the token was ever a credential, and it is no less of one inside.
 */
const ScopeInvitationLinkPayloadSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema, parentId: IdSchema, invitationId: IdSchema, token: z.string().min(1),
});
export type ScopeInvitationAddress = z.infer<typeof ScopeInvitationLinkPayloadSchema>;

/** One sentence for every unusable invitation: an unopenable link tells its holder no less and no more than a revoked one. */
export const UNAVAILABLE_INVITATION = "This invitation is unavailable. Ask the sender for a new invitation.";

/** Only the key: sealing and opening a link is not a reason to hold a Worker's whole environment. */
type LinkSealing = Pick<Env, "OAUTH_STATE_ENCRYPTION_KEY">;

export function sealScopeInvitationLink(env: LinkSealing, address: ScopeInvitationAddress): Promise<string> {
  return sealPayload(address, env.OAUTH_STATE_ENCRYPTION_KEY, SCOPE_INVITATION_LINK_PURPOSE);
}

/** The whole fragment, so nothing beside the credential names a parameter the recipient could read as a setting. */
export function scopeInvitationLinkUrl(origin: URL, sealed: string): URL {
  const link = new URL("/invite", origin);
  link.hash = sealed;
  return link;
}

/**
 * Where an invitation credential points, or null when this deployment cannot
 * say — an edited or foreign link, which is indistinguishable from one that was
 * never minted and owes its holder the same answer.
 */
export async function openScopeInvitationCredential(
  env: LinkSealing, credential: ScopeInvitationCredential,
): Promise<ScopeInvitationAddress | null> {
  if (!("link" in credential)) return credential;
  const payload = await openPayload(credential.link, env.OAUTH_STATE_ENCRYPTION_KEY, SCOPE_INVITATION_LINK_PURPOSE);
  if (payload === null) return null;
  const parsed = ScopeInvitationLinkPayloadSchema.safeParse(payload);
  if (parsed.success) return parsed.data;
  // Decryption already proved this deployment sealed it, so a rejection here is
  // our own payload shape drifting rather than a forged credential. Reporting
  // it as one more unavailable link would hide a deploy that stopped honouring
  // every invitation already in an inbox.
  throw new Error(codeShaped(`scope_invitation_link_invalid:${describeZodIssues(parsed.error)}`));
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
