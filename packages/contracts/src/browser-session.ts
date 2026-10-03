import { z } from "zod";
import { SessionSchema, WorkspaceSchema } from "./index";
import { IdSchema } from "./identifiers";
import { HttpsUrlSchema } from "./url-schemas";

/** Browser metadata deliberately excludes bearer and refresh credentials. */
export const BrowserSessionSchema = SessionSchema.pick({ user: true, workspace: true, expiresAt: true });
export type BrowserSession = z.infer<typeof BrowserSessionSchema>;
export const BrowserWorkspacesSchema = z.object({ workspaces: z.array(WorkspaceSchema) });
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
