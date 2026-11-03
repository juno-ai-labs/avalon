import { UuidV7Schema } from "./telemetry";
import { z } from "zod";
import { SessionSchema, WorkspaceAttentionSchema, WorkspaceIdSchema, WorkspaceSchema } from "./index";
import { ConfiguredRegionSchema } from "./regions";
import { IdSchema } from "./identifiers";
import { HttpsUrlSchema } from "./url-schemas";
import { ArtifactHostnameStubSchema } from "./artifacts";

/** Browser metadata deliberately excludes bearer and refresh credentials. */
export const BrowserSessionSchema = SessionSchema.pick({ user: true, workspace: true, impersonator: true, expiresAt: true });
export type BrowserSession = z.infer<typeof BrowserSessionSchema>;
export const BrowserWorkspacesSchema = z.object({ workspaces: z.array(WorkspaceSchema) });
/** Attention for each listed membership; guests and failed reads are absent. */
export const BrowserWorkspaceAttentionSchema = z.object({
  attention: z.array(z.object({ region: ConfiguredRegionSchema, workspaceId: WorkspaceIdSchema, attention: WorkspaceAttentionSchema })),
});
export type BrowserWorkspaceAttention = z.infer<typeof BrowserWorkspaceAttentionSchema>;
/** A site's hostname stub, sent by the browser client's site-opening page. */
export const BrowserSiteResolveSchema = z.strictObject({ hostnameStub: ArtifactHostnameStubSchema });
/**
 * The organization and resource behind a site, answered only to someone who can
 * read it, so the page can open that organization and then the site.
 */
export const BrowserSiteResolutionSchema = z.strictObject({ workspaceId: WorkspaceIdSchema, resourceId: IdSchema });
/** Asks Global to open a workspace in another deployment for this browser. */
export const BrowserWorkspaceActivateSchema = z.strictObject({ region: ConfiguredRegionSchema, workspaceId: WorkspaceIdSchema });
/**
 * Creates an organization for a signed-in browser on Global. `operationId` makes
 * a retry of the same name return the same organization rather than a second.
 */
export const BrowserWorkspaceCreateSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  operationId: IdSchema,
});
/** Where the browser opens the organization it just created. No credential crosses. */
export const BrowserWorkspaceCreatedSchema = z.object({ region: ConfiguredRegionSchema, workspaceId: WorkspaceIdSchema });
/** Starts Google sign-in for a browser; `returnPath` is a path on the browser host. */
export const BrowserGoogleStartSchema = z.strictObject({ returnPath: z.string().optional(), signupFlowId: UuidV7Schema.optional() });
export const BrowserGoogleStartedSchema = z.object({ url: HttpsUrlSchema });
export const EmailLoginStartSchema = z.strictObject({
  challengeId: IdSchema,
  signupFlowId: UuidV7Schema.optional(),
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
  /** The `/app/` path on the browser host the emailed link lands on, so a shared link survives sign-in. */
  returnPath: z.string().optional(),
});
export const EmailLoginRedeemSchema = z.strictObject({
  challengeId: IdSchema, redemptionId: IdSchema,
  method: z.enum(["magic", "otp"]), credential: z.string().min(1),
});
export const EmailLoginStartedSchema = z.strictObject({ challengeId: IdSchema, expiresAt: z.number().int() });
