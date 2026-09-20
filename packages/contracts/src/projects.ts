import {
  PALETTE_RING,
  SPACE_COLOR_KEYS,
  SPACE_COLOR_KEYS_STORABLE,
  SPACE_ICON_KEYS,
  type SpaceColorKey,
} from "./spaces";

/**
 * What is left of Projects: the appearance vocabulary, under its old names.
 *
 * The product abstraction is gone — its routes answer `410`, its authority was
 * deleted with WorkspaceDO migration 62, and `docs/projects.md` records what
 * that took with it. These five names stay because the Spaces decision log
 * kept them deliberately: the `--av-sys-color-project-*` design tokens, the
 * `project` colour helpers and the stored appearance values are internal
 * vocabulary, and renaming them touches every glyph and avatar in the desktop
 * client for no visible change.
 *
 * Every value below is the same array `spaces.ts` exports, so a colour stored
 * under either name parses under both. Nothing here describes a Project.
 */
export const PROJECT_ICON_KEYS = SPACE_ICON_KEYS;
export const PROJECT_COLOR_KEYS = SPACE_COLOR_KEYS;
export const PROJECT_COLOR_KEYS_STORABLE = SPACE_COLOR_KEYS_STORABLE;
/** Retained name for the ring; a derived colour has never included the neutral. */
export const PROJECT_COLOR_RING = PALETTE_RING;
export type ProjectColorKey = SpaceColorKey;
