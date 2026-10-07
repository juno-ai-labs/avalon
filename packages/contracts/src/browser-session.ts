import { z } from "zod";
import { SessionSchema, WorkspaceIdSchema, WorkspaceSchema } from "./index";
import { ConfiguredRegionSchema } from "./regions";
import { IdSchema } from "./identifiers";
import { HttpsUrlSchema } from "./url-schemas";

/** Browser metadata deliberately excludes bearer and refresh credentials. */
export const BrowserSessionSchema = SessionSchema.pick({ user: true, workspace: true, expiresAt: true });
export type BrowserSession = z.infer<typeof BrowserSessionSchema>;
export const BrowserWorkspacesSchema = z.object({ workspaces: z.array(WorkspaceSchema) });
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
export const BrowserGoogleStartSchema = z.strictObject({ returnPath: z.string().optional() });
export const BrowserGoogleStartedSchema = z.object({ url: HttpsUrlSchema });
export const EmailLoginStartSchema = z.strictObject({
  challengeId: IdSchema,
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
});
export const EmailLoginRedeemSchema = z.strictObject({
  challengeId: IdSchema, redemptionId: IdSchema,
  method: z.enum(["magic", "otp"]), credential: z.string().min(1),
});
export const EmailLoginStartedSchema = z.strictObject({ challengeId: IdSchema, expiresAt: z.number().int() });
