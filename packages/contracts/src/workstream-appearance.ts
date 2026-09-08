import { z } from "zod";
import { PROJECT_COLOR_KEYS, PROJECT_ICON_KEYS } from "./projects";

export const WORKSTREAM_ICON_KEYS = [
  "aperture", "atom", "boxes", "circle-dot", "circuit-board", "component",
  "dices", "orbit", "sparkles", "spline", "wand-sparkles", "workflow",
  ...PROJECT_ICON_KEYS,
] as const;
export const WorkstreamAppearanceSchema = z.strictObject({
  icon: z.enum(WORKSTREAM_ICON_KEYS).nullable(),
  /** Stable semantic palette key; resolve through the current appearance tokens, never store a CSS color. */
  color: z.enum(PROJECT_COLOR_KEYS).nullable(),
});
export const WorkstreamAppearancePatchSchema = WorkstreamAppearanceSchema.partial();
export type WorkstreamAppearance = z.infer<typeof WorkstreamAppearanceSchema>;
export type WorkstreamAppearancePatch = z.infer<typeof WorkstreamAppearancePatchSchema>;
