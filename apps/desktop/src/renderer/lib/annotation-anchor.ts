import type { ArtifactElementRect } from '@rally/contracts';

/** The comment editor's footprint, as `.annotation-comment` draws it, with room for the textarea to grow. */
export const ANNOTATION_EDITOR_SIZE = { width: 292, height: 160 } as const;

/**
 * Where the comment editor goes for a selection inside a frame.
 *
 * Beside the element, to its right, when the window has room there; else
 * below it, aligned to its left edge; else above it. It never covers the
 * element it is about while any of those fit. Always inside the window, and
 * never further from the frame than its edges: an element scrolled out of
 * the frame keeps its editor parked at the frame's nearest edge rather than
 * leaving the person with a box that drifted off screen.
 */
export function placeAnnotationEditor(
  rect: ArtifactElementRect,
  frame: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
  gap = 12,
): { x: number; y: number } {
  const { width, height } = ANNOTATION_EDITOR_SIZE;
  const right = frame.x + rect.x + rect.width;
  const beside = right + gap + width <= viewport.width - 8;
  const x = beside ? right + gap : Math.max(8, Math.min(frame.x + rect.x, viewport.width - width - 8));
  const low = Math.max(8, frame.y);
  const high = Math.max(low, Math.min(viewport.height - height - 8, frame.y + frame.height - height));
  const top = frame.y + rect.y;
  const below = top + rect.height + gap;
  const above = top - gap - height;
  const wanted = beside ? top : below <= high ? below : above >= low ? above : below;
  return { x, y: Math.max(low, Math.min(wanted, high)) };
}
