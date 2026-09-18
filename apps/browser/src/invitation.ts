import { z } from "zod";
import { ConfiguredRegionSchema } from "@rally/contracts/regions";
import { AcceptScopeInvitationSchema, type ScopeGrantTarget } from "@rally/contracts/scope-grants";
import { workstreamCanonicalUrl } from "@rally/contracts/workstream-links";

export const BrowserInvitationSchema = z.strictObject({
  region: ConfiguredRegionSchema,
  request: AcceptScopeInvitationSchema.omit({ userId: true }),
});
export type BrowserInvitation = z.infer<typeof BrowserInvitationSchema>;

export function invitationFromFragment(fragment: URLSearchParams): BrowserInvitation | null {
  const parsed = BrowserInvitationSchema.safeParse({ region: fragment.get("region"), request: {
    workspaceId: fragment.get("workspace"), parentId: fragment.get("workstream"),
    invitationId: fragment.get("invitation"), token: fragment.get("token"),
  } });
  return parsed.success ? parsed.data : null;
}

/** Child-only shares must never navigate through Main as an intermediate view. */
export function invitationTargetPath(origin: string, region: string, target: ScopeGrantTarget): string {
  return new URL(workstreamCanonicalUrl(origin, { region, workspaceId: target.workspaceId,
    workstreamId: target.parentId,
    ...(target.kind === "conversation" && target.substreamId !== "0" ? { substreamId: target.substreamId } : {}),
  })).pathname;
}
