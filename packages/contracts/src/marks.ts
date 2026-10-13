import {
  GENERATED_APPEARANCE_ICON_KEYS,
  STORABLE_APPEARANCE_ICON_KEYS,
  type StorableAppearanceIconKey,
} from "./appearance-icons";
import { PALETTE_KEYS, PALETTE_RING, type PaletteKey } from "./palette";

/**
 * A mark: the glyph and colour a Channel, thread or Breakout is recognised by,
 * and the shape it sits in. A Channel is a squircle and a thread or a Breakout
 * a circle, as in the app's sidebar.
 *
 * This module is what a surface outside the app needs to draw one: the
 * id-derived mark for an object nobody gave an appearance, and the public
 * image address `rallywith.ai/marks/...` serves it at. See `docs/marks.md`.
 */
export type MarkShape = "circle" | "squircle";

export interface Mark {
  shape: MarkShape;
  icon: StorableAppearanceIconKey;
  color: PaletteKey;
}

const MARK_SHAPES: readonly MarkShape[] = ["circle", "squircle"];
const ICON_KEYS: ReadonlySet<string> = new Set(STORABLE_APPEARANCE_ICON_KEYS);
const COLOR_KEYS: ReadonlySet<string> = new Set(PALETTE_KEYS);

export function isStorableIconKey(value: unknown): value is StorableAppearanceIconKey {
  return typeof value === "string" && ICON_KEYS.has(value);
}

export function isPaletteKey(value: unknown): value is PaletteKey {
  return typeof value === "string" && COLOR_KEYS.has(value);
}

/**
 * The mark of an object without a chosen appearance, seeded by its id.
 *
 * Deterministic on purpose: an identity that changed on every launch would make
 * the sidebar harder to scan even though it looked more random. The colour
 * comes from the ring, never `black`, which is a neutral somebody picks rather
 * than a colour to hand out.
 */
export function generatedAppearance(id: string): {
  icon: (typeof GENERATED_APPEARANCE_ICON_KEYS)[number];
  color: (typeof PALETTE_RING)[number];
} {
  let hash = 2_166_136_261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  const unsigned = hash >>> 0;
  return {
    color: PALETTE_RING[unsigned % PALETTE_RING.length] ?? "purple",
    icon: GENERATED_APPEARANCE_ICON_KEYS[
      Math.floor(unsigned / PALETTE_RING.length) % GENERATED_APPEARANCE_ICON_KEYS.length
    ] ?? "sparkles",
  };
}

/** Where the site serves a mark as a PNG: `/marks/<shape>/<color>/<icon>.png`. */
export function markImagePath(mark: Mark): string {
  return `/marks/${mark.shape}/${mark.color}/${mark.icon}.png`;
}

/** The mark a `/marks/...` path names, or null for any other path or an unknown key. */
export function parseMarkImagePath(pathname: string): Mark | null {
  const match = /^\/marks\/([a-z]+)\/([a-z]+)\/([a-z0-9-]+)\.png$/u.exec(pathname);
  if (!match) return null;
  const [, shape, color, icon] = match;
  if (!MARK_SHAPES.includes(shape as MarkShape) || !isPaletteKey(color) || !isStorableIconKey(icon)) return null;
  return { shape: shape as MarkShape, color, icon };
}
