import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/** How a glide moves: the composer's settle from the middle of an empty Canvas to its dock. */
const GLIDE = { duration: 460, easing: 'cubic-bezier(.22, .9, .25, 1)' } as const;

/**
 * Slide an element from where it was drawn while `active` to where it lands
 * when `active` turns false: the FLIP technique. The element stays mounted in
 * one place in the tree and only the layout around it changes, so focus and
 * anything typed in it survive the move.
 *
 * It measures only while `active` is true and on the commit that turns it off,
 * so a conversation that is not starting, which commits on every streamed
 * token, never pays for a forced layout. Reduced motion, and a hidden window,
 * move it without the glide.
 */
export function useLayoutGlide(ref: RefObject<HTMLElement | null>, active: boolean): void {
  const last = useRef<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const before = last.current;
    if (!active && !before) return;
    const element = ref.current;
    if (!element) {
      last.current = null;
      return;
    }
    const rect = element.getBoundingClientRect();
    last.current = active ? { top: rect.top, left: rect.left } : null;
    if (active || !before) return;
    if (document.visibilityState === 'hidden' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const dx = before.left - rect.left;
    const dy = before.top - rect.top;
    if (dx === 0 && dy === 0) return;
    element.animate?.([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], GLIDE);
  });

  // While active, a resize moves the element without a commit.
  useEffect(() => {
    if (!active) return;
    const remember = (): void => {
      const element = ref.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      last.current = { top: rect.top, left: rect.left };
    };
    window.addEventListener('resize', remember);
    return () => window.removeEventListener('resize', remember);
  }, [ref, active]);
}
