import { z } from "zod";
import { PROJECT_COLOR_KEYS_STORABLE, PROJECT_COLOR_RING, type ProjectColorKey } from "./projects";
import {
  APPEARANCE_ICON_DESCRIPTIONS,
  GENERATED_APPEARANCE_ICON_KEYS,
  PICKABLE_APPEARANCE_ICON_KEYS,
  STORABLE_APPEARANCE_ICON_KEYS,
} from "./appearance-icons";

/**
 * The icons a person or a model may choose, section by section. The catalog,
 * its sections and why it is split from what may be stored live in
 * `appearance-icons.ts`; these names are the ones every caller already imports.
 */
export const WORKSTREAM_ICON_KEYS = PICKABLE_APPEARANCE_ICON_KEYS;
/**
 * What a stored icon may hold, deliberately wider than the menu: every key any
 * catalog has offered. The schema below parses on every read, so it validates
 * against this rather than {@link WORKSTREAM_ICON_KEYS}.
 */
export const WORKSTREAM_ICON_KEYS_STORABLE = STORABLE_APPEARANCE_ICON_KEYS;
/** The id-derived default marks, in their original order. */
export const GENERATED_WORKSTREAM_ICON_KEYS = GENERATED_APPEARANCE_ICON_KEYS;
export const WorkstreamIconKeySchema = z.enum(WORKSTREAM_ICON_KEYS_STORABLE);
export type WorkstreamIconKey = z.infer<typeof WorkstreamIconKeySchema>;
/** Only what the catalog offers today; what a model's answer is held to. */
export const PickableWorkstreamIconKeySchema = z.enum(WORKSTREAM_ICON_KEYS);
export type PickableWorkstreamIconKey = z.infer<typeof PickableWorkstreamIconKeySchema>;

/**
 * The icon to fall back on when no mark in the catalog suits the work.
 *
 * The one place the product has an opinion about *which* icon to use, and it is
 * here rather than in a description because it is a rule about the choice
 * rather than a fact about the drawing: something has to be picked when nothing
 * fits, and the prompt's fallback and the one a caller reaches for must not
 * drift apart.
 *
 * `circle-dot` rather than `sparkles`, which reads as the obvious "generic"
 * mark and is the wrong one here: sparkles is already Rally's own glyph in this
 * product — the mention icon in the composer and the account menu — so putting
 * it on every work stream no icon suits would badge exactly those rows as "the
 * agent did this". A plain dot in a ring says nothing, which is what a fallback
 * should say.
 */
export const DEFAULT_WORKSTREAM_ICON_KEY = "circle-dot" satisfies PickableWorkstreamIconKey;

/** What each pickable icon draws; see `APPEARANCE_ICON_DESCRIPTIONS`. */
export const WORKSTREAM_ICON_DESCRIPTIONS = APPEARANCE_ICON_DESCRIPTIONS;

export const WorkstreamAppearanceSchema = z.strictObject({
  icon: WorkstreamIconKeySchema.nullable(),
  /**
   * Stable semantic palette key; resolve through the current appearance tokens,
   * never store a CSS color. Validated against the *storable* vocabulary, not the
   * pickable one: this schema parses on every work-stream read, so narrowing it to
   * what the picker currently offers would make a retired colour throw instead of
   * render.
   */
  color: z.enum(PROJECT_COLOR_KEYS_STORABLE).nullable(),
});
export const WorkstreamAppearancePatchSchema = WorkstreamAppearanceSchema.partial();
export type WorkstreamAppearance = z.infer<typeof WorkstreamAppearanceSchema>;
export type WorkstreamAppearancePatch = z.infer<typeof WorkstreamAppearancePatchSchema>;

/**
 * An icon and a colour both set, as the Sidekick setup chat submits them.
 *
 * Neither may be null: the chat always states both. The colour takes the whole
 * storable vocabulary rather than only the ring, because the chat is told to
 * keep a Sidekick's current colour and that colour may be `black` or a retired
 * one. Whether a colour outside the ring is allowed is a question about what is
 * already stored, so `SidekickDO` answers it, not this schema.
 */
export const PickedAppearanceSchema = z.strictObject({
  icon: WorkstreamIconKeySchema,
  color: z.enum(PROJECT_COLOR_KEYS_STORABLE),
});
export type PickedAppearance = z.infer<typeof PickedAppearanceSchema>;

/** Stable fallback shared by conversation glyphs and creation-time color inheritance. */
export function generatedWorkstreamAppearance(id: string): { color: ProjectColorKey; iconIndex: number } {
  let hash = 2_166_136_261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  const unsigned = hash >>> 0;
  return {
    color: PROJECT_COLOR_RING[unsigned % PROJECT_COLOR_RING.length] ?? "purple",
    iconIndex: Math.floor(unsigned / PROJECT_COLOR_RING.length) % GENERATED_WORKSTREAM_ICON_KEYS.length,
  };
}
