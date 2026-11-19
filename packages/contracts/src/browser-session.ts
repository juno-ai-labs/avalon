import { UuidV7Schema } from "./telemetry";
import { z } from "zod";
import { PendingWorkspaceInvitationSchema, SessionSchema, WorkspaceAttentionSchema, WorkspaceIdSchema, WorkspaceSchema } from "./index";
import { ConfiguredRegionSchema } from "./regions";
import { IdSchema } from "./identifiers";
import { HttpsUrlSchema } from "./url-schemas";
import { ArtifactHostnameStubSchema } from "./artifacts";
import { deferredZodSchema } from "./deferred-zod-schema";

/** Browser metadata deliberately excludes bearer and refresh credentials. */
export const BrowserSessionSchema = SessionSchema.pick({ user: true, workspace: true, impersonator: true, expiresAt: true });
export type BrowserSession = z.infer<typeof BrowserSessionSchema>;
export const BrowserWorkspacesSchema = deferredZodSchema(() => z.object({ workspaces: z.array(WorkspaceSchema) }));
/** Attention for each listed membership; guests and failed reads are absent. */
export const BrowserWorkspaceAttentionSchema = deferredZodSchema(() => z.object({
  attention: z.array(z.object({ region: ConfiguredRegionSchema, workspaceId: WorkspaceIdSchema, attention: WorkspaceAttentionSchema })),
}));
export type BrowserWorkspaceAttention = z.infer<typeof BrowserWorkspaceAttentionSchema>;
/** A site's hostname stub, sent by the browser client's site-opening page. */
export const BrowserSiteResolveSchema = deferredZodSchema(() => z.strictObject({ hostnameStub: ArtifactHostnameStubSchema }));
/**
 * The organization and resource behind a site, answered only to someone who can
 * read it, so the page can open that organization and then the site.
 */
export const BrowserSiteResolutionSchema = deferredZodSchema(() => z.strictObject({ workspaceId: WorkspaceIdSchema, resourceId: IdSchema }));
/** Asks Global to open a workspace in another deployment for this browser. */
export const BrowserWorkspaceActivateSchema = deferredZodSchema(() => z.strictObject({ region: ConfiguredRegionSchema, workspaceId: WorkspaceIdSchema }));
/**
 * Creates an organization for a signed-in browser on Global. `operationId` makes
 * a retry of the same name return the same organization rather than a second.
 */
export const BrowserWorkspaceCreateSchema = deferredZodSchema(() => z.strictObject({
  name: z.string().trim().min(2).max(120),
  operationId: IdSchema,
}));
/** Where the browser opens the organization it just created. No credential crosses. */
export const BrowserWorkspaceCreatedSchema = deferredZodSchema(() => z.object({ region: ConfiguredRegionSchema, workspaceId: WorkspaceIdSchema }));
/** Invitations to join an organization waiting for the signed-in address, read on Global. */
export const BrowserInvitationsSchema = deferredZodSchema(() => z.object({ invitations: z.array(PendingWorkspaceInvitationSchema) }));
/**
 * Accepts one of them. `operationId` makes a retry return the same membership,
 * and the answer is `BrowserWorkspaceCreatedSchema`: where to open it.
 */
export const BrowserInvitationAcceptSchema = deferredZodSchema(() => z.strictObject({ region: ConfiguredRegionSchema, operationId: IdSchema }));
export const BrowserInvitationDeclineSchema = deferredZodSchema(() => z.strictObject({ region: ConfiguredRegionSchema }));
/** Starts Google sign-in for a browser; `returnPath` is a path on the browser host. */
export const BrowserGoogleStartSchema = deferredZodSchema(() => z.strictObject({ returnPath: z.string().optional(), signupFlowId: UuidV7Schema.optional() }));
export const BrowserGoogleStartedSchema = deferredZodSchema(() => z.object({ url: HttpsUrlSchema }));
export const EmailLoginStartSchema = deferredZodSchema(() => z.strictObject({
  challengeId: IdSchema,
  signupFlowId: UuidV7Schema.optional(),
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
  /** The `/app/` path on the browser host the emailed link lands on, so a shared link survives sign-in. */
  returnPath: z.string().optional(),
}));
export const EmailLoginRedeemSchema = deferredZodSchema(() => z.strictObject({
  challengeId: IdSchema, redemptionId: IdSchema,
  method: z.enum(["magic", "otp"]), credential: z.string().min(1),
}));
export const EmailLoginStartedSchema = deferredZodSchema(() => z.strictObject({ challengeId: IdSchema, expiresAt: z.number().int() }));

/**
 * The page on the browser host that an emailed Approve or Decline link for a
 * Sidekick source request opens. The link's fragment carries the region and
 * the fields below; the page posts them back and shows the answer.
 * `docs/sidekick-sources.md` owns the request.
 */
export const SOURCE_DECISION_PATH = "/app/source-requests/decision";
/**
 * One emailed decision: the request, the person asked, what they chose, and
 * the signature that binds the four to each other and to the Organization and
 * Sidekick. It names no session: holding the link sent to the person's own
 * mailbox is the proof.
 */
export const SourceDecisionLinkSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: WorkspaceIdSchema,
  sidekickId: IdSchema,
  requestId: IdSchema,
  userId: IdSchema,
  decision: z.enum(["approve", "decline"]),
  token: z.string().min(1).max(200),
}));
export type SourceDecisionLink = z.infer<typeof SourceDecisionLinkSchema>;
/**
 * Where the request stands once the link was opened. `applied` says whether
 * that is what this link asked for: the first opening and every later one of
 * the same link. It is false when the request was already answered the other
 * way, or replaced by a newer ask, before this link was opened.
 */
export const SourceDecisionResultSchema = deferredZodSchema(() => z.object({
  state: z.enum(["pending", "approved", "declined", "cancelled"]),
  applied: z.boolean(),
  sidekickName: z.string(),
  requestedByName: z.string(),
  connectorName: z.string(),
  eventLabels: z.array(z.string()),
  condition: z.string().nullable(),
}));
export type SourceDecisionResult = z.infer<typeof SourceDecisionResultSchema>;
