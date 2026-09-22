import { z } from "zod";
import { ConfiguredRegionSchema } from "@rally/contracts/regions";
import { ScopeInvitationCredentialSchema, type ScopeGrantTarget } from "@rally/contracts/scope-grants";
import { workstreamCanonicalUrl } from "@rally/contracts/workstream-links";

/**
 * A region only an addressed fragment can name.
 *
 * Current links carry one opaque token and nothing else, so the page opens them
 * against the deployment serving it — the only one it can reach, and the only
 * one holding the row the token reads. Adding a second browser deployment means
 * giving the link its own routing again rather than asking every deployment in
 * turn for a token only one of them can resolve.
 */
export const BrowserInvitationSchema = z.strictObject({
  region: ConfiguredRegionSchema.nullable(),
  credential: ScopeInvitationCredentialSchema,
});
export type BrowserInvitation = z.infer<typeof BrowserInvitationSchema>;

/**
 * The whole fragment is the token unless it spells out parameters, which only
 * the fragment format predating opaque links does.
 */
export function invitationFromFragment(fragment: string): BrowserInvitation | null {
  if (!fragment.includes("=")) {
    const parsed = BrowserInvitationSchema.safeParse({ region: null, credential: { link: fragment } });
    return parsed.success ? parsed.data : null;
  }
  const addressed = new URLSearchParams(fragment);
  const parsed = BrowserInvitationSchema.safeParse({ region: addressed.get("region"), credential: {
    workspaceId: addressed.get("workspace"), parentId: addressed.get("workstream"),
    invitationId: addressed.get("invitation"), token: addressed.get("token"),
  } });
  // An addressed fragment without its region cannot be sent anywhere, even
  // though the credential itself parses: this deployment is not an answer.
  return parsed.success && parsed.data.region !== null ? parsed.data : null;
}

/** Child-only shares must never navigate through Main as an intermediate view. */
export function invitationTargetPath(origin: string, region: string, target: ScopeGrantTarget, spaceId: string): string {
  return new URL(workstreamCanonicalUrl(origin, { region, workspaceId: target.workspaceId, spaceId,
    workstreamId: target.parentId,
    ...(target.kind === "conversation" && target.substreamId !== "0" ? { substreamId: target.substreamId } : {}),
  })).pathname;
}
