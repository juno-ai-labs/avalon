import { z } from "zod";
import { IdSchema } from "./identifiers";
import { ConfiguredRegionSchema } from "./regions";
import { HttpUrlSchema } from "./url-schemas";

const TimestampSchema = z.string().datetime({ offset: true });

/**
 * Support access: an Organization lets Rally staff act as its people for a
 * bounded time, and staff open a session as one of them from the account menu.
 * `docs/impersonation.md` owns the mechanism.
 */

/**
 * An Organization's own view of its grant. `available` is false in the staff
 * Organization itself, which has nobody to grant access to.
 */
export const SupportAccessSchema = z.object({
  available: z.boolean(),
  expiresAt: TimestampSchema.nullable(),
});
export type SupportAccess = z.infer<typeof SupportAccessSchema>;

/** An Organization with a live grant, as a staff member's account menu lists it. */
export const SupportWorkspaceSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(120),
  region: ConfiguredRegionSchema,
  expiresAt: TimestampSchema,
});
export type SupportWorkspace = z.infer<typeof SupportWorkspaceSchema>;
export const SupportWorkspacesSchema = z.object({ workspaces: z.array(SupportWorkspaceSchema) });

/** A member or guest a staff member may act as. */
export const SupportPersonSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  email: z.string().email(),
  avatarUrl: HttpUrlSchema.nullable(),
  accessClass: z.enum(["member", "guest"]),
});
export type SupportPerson = z.infer<typeof SupportPersonSchema>;
export const SupportPeopleSchema = z.object({ people: z.array(SupportPersonSchema) });

export const StartSupportSessionRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
});
export type StartSupportSessionRequest = z.infer<typeof StartSupportSessionRequestSchema>;
