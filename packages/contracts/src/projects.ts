import { PICKABLE_APPEARANCE_ICON_KEYS } from "./appearance-icons";
import { PALETTE_KEYS, PALETTE_RING, type PaletteKey } from "./palette";

/**
 * What is left of Projects and Spaces: the appearance vocabulary, under its
 * old names.
 *
 * The product abstractions are gone — `docs/projects.md` records the Project
 * retirement and the Canvases and Sidekicks pivot retired Spaces. These names
 * stay because the stored appearance values, the `--av-sys-color-project-*`
 * design tokens and the `project` colour helpers are internal vocabulary a
 * Sidekick's glyph still reads, and renaming them touches every glyph and
 * avatar in the desktop client for no visible change.
 *
 * A colour is any key of the palette, the neutral included, so every stored
 * value parses; a derived colour is drawn from the ring, which never includes
 * the neutral.
 */
export const PROJECT_ICON_KEYS = PICKABLE_APPEARANCE_ICON_KEYS;
export const PROJECT_COLOR_KEYS = PALETTE_RING;
export const PROJECT_COLOR_KEYS_STORABLE = PALETTE_KEYS;
/** Retained name for the ring; a derived colour has never included the neutral. */
export const PROJECT_COLOR_RING = PALETTE_RING;
export type ProjectColorKey = PaletteKey;
