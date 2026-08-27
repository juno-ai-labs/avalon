import { cn } from './cn';

/**
 * One treatment for everything that floats above the page.
 *
 * The renderer had two. `.menu-content` was a `surface-raised` panel with a
 * `line-4` edge and a medium shadow; `.dropdown-select-content` was
 * `surface-elevated-hover` with a `line-5` edge, a larger radius and its own
 * highlight fill one ramp step brighter than the menu's. Nothing chose that —
 * the select was written later, by someone who could not see the menu. Two
 * popovers with different edges, opened one after the other from the same
 * toolbar, read as one of them belonging to a different application.
 *
 * The menu's is the one that survived: it is the more common of the two, and
 * every value in it already had a semantic name, where the select reached past
 * the surface ramp for a highlight the ramp does not define.
 */
export const overlaySurface = cn(
  'rounded border border-line-hover bg-surface-raised p-[5px] shadow-md',
  'animate-[fade-in_100ms_ease-out]',
);

/** A row inside one. */
export const overlayItem = cn(
  'flex w-full items-center gap-2 rounded-sm px-2 py-1 text-start text-[12px] text-ink-subtle',
  'min-h-[30px] outline-0 select-none',
  'data-[highlighted]:bg-surface-raised-hover data-[highlighted]:text-ink',
  'data-[disabled]:opacity-[0.42]',
);
