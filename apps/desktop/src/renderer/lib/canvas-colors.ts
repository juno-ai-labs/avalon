import { PALETTE_RING, type WorkstreamAppearance } from '@rally/contracts';
import { markColors } from '@rally/ui/lib/project-palette';

/**
 * A Canvas's default hue: one of the project palette's pastel hues, stable for
 * its id, the way a person's accent is chosen from theirs. design.html §1
 * colours each Canvas on its own; somebody may choose another
 * (`appearance.color`), and this is what an unchosen one wears.
 */
export function canvasHue(id: string): (typeof PALETTE_RING)[number] {
  const hash = [...id].reduce((total, character) => total + character.charCodeAt(0), 0);
  return PALETTE_RING[hash % PALETTE_RING.length]!;
}

/** Resolve colors without importing the glyph catalog into a host's startup bundle. */
export function canvasColors(id: string | undefined, appearance?: WorkstreamAppearance) {
  const color = appearance?.color ?? (id ? canvasHue(id) : 'cyan');
  return { color, ...markColors(color) };
}
