import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/** How a glide moves: the composer's settle from the middle of an empty Canvas to its dock. */
const GLIDE = { duration: 460, easing: 'cubic-bezier(.22, .9, .25, 1)' } as const;

/**
 * Slide an element from where it was drawn to where a layout change puts it,
 * whenever `layoutKey` changes: the FLIP technique. The element stays mounted
 * in one place in the tree and only the layout around it changes, so focus and
 * anything typed in it survive the move; this only plays the difference as a
 * transform so the move reads as one motion rather than a jump.
 *
 * The last position is taken after every commit and on every window resize, so
 * the glide starts from where the element was last seen rather than from a
 * position a resize has since moved. Reduced motion, and a hidden window, move
 * it without the glide.
 */
export function useLayoutGlide(ref: RefObject<HTMLElement | null>, layoutKey: string | boolean): void {
  const last = useRef<{ key: string | boolean; top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      last.current = null;
      return;
    }
    const rect = element.getBoundingClientRect();
    const before = last.current;
    last.current = { key: layoutKey, top: rect.top, left: rect.left };
    if (!before || before.key === layoutKey) return;
    if (document.visibilityState === 'hidden' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const dx = before.left - rect.left;
    const dy = before.top - rect.top;
    if (dx === 0 && dy === 0) return;
    element.animate?.([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], GLIDE);
  });

  useEffect(() => {
    const remember = (): void => {
      const element = ref.current;
      if (!element || !last.current) return;
      const rect = element.getBoundingClientRect();
      last.current = { ...last.current, top: rect.top, left: rect.left };
    };
    window.addEventListener('resize', remember);
    return () => window.removeEventListener('resize', remember);
  }, [ref]);
}
