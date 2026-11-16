import { z } from "zod";

import { IdSchema, UserIdSchema, WorkspaceIdSchema } from "./identifiers";
import { RegionSchema } from "./regions";
import { WorkstreamAppearanceSchema } from "./workstream-appearance";

/*
 * Canvases shared with a guest, shown in every other Organization they open
 * (`docs/canvas-share-federation.md`). Nothing about a Canvas is stored outside
 * its Organization: when a list is built, the Canvas's own Organization is
 * asked, and it answers only for a guest of its own explicitly added to the
 * Canvas. Changes there only invalidate; nothing is replicated.
 */

/**
 * The activity-queue message that rebuilds one person's shared-Canvas lists.
 * `others`: something changed for them in `workspaceId` (a share, an unshare,
 * a rename, their relationship), so every other Organization they are in
 * rebuilds. `this`: their socket in `workspaceId` just subscribed. `all`: they
 * changed their switch, so every Organization they are in rebuilds.
 */
export const SharedCanvasesRefreshMessageSchema = z.strictObject({
  kind: z.literal("shared_canvases_refresh"),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  userId: UserIdSchema,
  scope: z.enum(["others", "this", "all"]),
});
export type SharedCanvasesRefreshMessage = z.infer<typeof SharedCanvasesRefreshMessageSchema>;

/** One Canvas as its own Organization answers for a guest it is shared with. */
export const GuestSharedCanvasSchema = z.strictObject({
  id: IdSchema,
  title: z.string().max(300),
  appearance: WorkstreamAppearanceSchema.nullable(),
  updatedAt: z.number().int().nonnegative(),
});
export type GuestSharedCanvas = z.infer<typeof GuestSharedCanvasSchema>;

/** A Canvas shared with this person in another of their Organizations, as their list shows it. */
export const SharedCanvasSchema = z.strictObject({
  organization: z.strictObject({ id: WorkspaceIdSchema, name: z.string(), region: RegionSchema }),
  canvas: z.strictObject({
    id: IdSchema,
    title: z.string().max(300),
    appearance: WorkstreamAppearanceSchema.optional(),
    updatedAt: z.string().datetime(),
  }),
});
export type SharedCanvas = z.infer<typeof SharedCanvasSchema>;

/**
 * The workspace socket's push of a person's shared Canvases from their other
 * Organizations: after every subscribe, and whenever one of those Canvases or
 * their setting changes. Its own event type, which a released client ignores.
 * `items` is empty while `enabled` is off. `unavailable` names the
 * Organizations that could not answer for this build: the client keeps what it
 * last showed from them, and a complete build follows.
 */
export const WorkspaceSharedCanvasesEventSchema = z.strictObject({
  type: z.literal("workspace_shared_canvases"),
  occurredAt: z.string().datetime(),
  enabled: z.boolean(),
  items: z.array(SharedCanvasSchema).max(250),
  unavailable: z.array(WorkspaceIdSchema),
});
export type WorkspaceSharedCanvasesEvent = z.infer<typeof WorkspaceSharedCanvasesEventSchema>;

/** `GET` and `PUT /workspace/me/shared-canvases`: whether other Organizations' shared Canvases join every list. */
export const SharedCanvasesSettingSchema = z.strictObject({ enabled: z.boolean() });
export type SharedCanvasesSetting = z.infer<typeof SharedCanvasesSettingSchema>;
