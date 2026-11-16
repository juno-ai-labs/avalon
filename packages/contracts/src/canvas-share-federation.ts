import { z } from "zod";

import { IdSchema, UserIdSchema, WorkspaceIdSchema } from "./identifiers";
import { RegionSchema } from "./regions";
import { WorkstreamAppearanceSchema } from "./workstream-appearance";

/*
 * Canvases shared with a person, federated across their Organizations
 * (`docs/canvas-share-federation.md`). The Canvas's own Organization is the
 * authority and only publishes; the person's "Shared with me" inbox is a
 * per-person index in the regional D1; every other Organization the person
 * opens reads that inbox onto their socket.
 */

/**
 * The outbox's activity-queue message: an address only. The consumer asks the
 * Canvas's Organization for this person's current state of it, so a removal
 * needs no record of whom it told, and a late delivery reads the latest state.
 */
export const CanvasShareChangedMessageSchema = z.strictObject({
  kind: z.literal("canvas_share_changed"),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  canvasId: IdSchema,
  userId: UserIdSchema,
});
export type CanvasShareChangedMessage = z.infer<typeof CanvasShareChangedMessageSchema>;

/**
 * One person's state of one Canvas, as its Organization answers the consumer.
 * `revision` orders deliveries: the inbox keeps the highest it has seen. A
 * Canvas that no longer exists answers `gone`, which removes it whatever its
 * revision, since a deleted Canvas never comes back.
 */
export const CanvasShareStateSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("shared"),
    revision: z.number().int().nonnegative(),
    title: z.string().max(300),
    appearance: WorkstreamAppearanceSchema.nullable(),
    updatedAt: z.number().int().nonnegative(),
  }),
  z.strictObject({ state: z.literal("unshared"), revision: z.number().int().nonnegative() }),
  z.strictObject({ state: z.literal("gone") }),
]);
export type CanvasShareState = z.infer<typeof CanvasShareStateSchema>;

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
 * Organizations: after every subscribe, and whenever their inbox or their
 * setting changes. Its own event type, which a released client ignores.
 * `items` is empty while `enabled` is off.
 */
export const WorkspaceSharedCanvasesEventSchema = z.strictObject({
  type: z.literal("workspace_shared_canvases"),
  occurredAt: z.string().datetime(),
  enabled: z.boolean(),
  items: z.array(SharedCanvasSchema).max(250),
});
export type WorkspaceSharedCanvasesEvent = z.infer<typeof WorkspaceSharedCanvasesEventSchema>;

/** `GET` and `PUT /workspace/me/shared-canvases`: whether other Organizations' shared Canvases join every list. */
export const SharedCanvasesSettingSchema = z.strictObject({ enabled: z.boolean() });
export type SharedCanvasesSetting = z.infer<typeof SharedCanvasesSettingSchema>;
