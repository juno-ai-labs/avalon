import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/** How a glide moves: the composer's settle from the middle of an empty Canvas to its dock. */
const GLIDE = { duration: 460, easing: 'cubic-bezier(.22, .9, .25, 1)' } as const;

interface Point { top: number; left: number }

/**
 * Slide an element between where it is drawn while `active` and where it
 * lands when `active` turns false: the FLIP technique. The element stays
 * mounted in one place in the tree and only the layout around it changes, so
 * focus and anything typed in it survive the move.
 *
 * It measures only while `active` is true and on the commit that turns it
 * off, so a conversation that is not starting, which commits on every streamed
 * token, never pays for a forced layout. When `active` comes back (the first
 * message failed and was withdrawn), it slides back from wherever the element
 * is drawn at that moment, mid-glide or landed, rather than jumping. Reduced
 * motion, and a hidden window, move it without the glide.
 */
export function useLayoutGlide(ref: RefObject<HTMLElement | null>, active: boolean): void {
  /** Where the element is laid out while active. */
  const resting = useRef<Point | null>(null);
  /** The glide away from it, and where that glide lands. */
  const glide = useRef<{ animation: Animation | undefined; landed: Point } | null>(null);

  useLayoutEffect(() => {
    if (!active && !resting.current) return;
    const element = ref.current;
    if (!element) {
      resting.current = null;
      glide.current = null;
      return;
    }
    let from: Point | null = null;
    if (active && glide.current) {
      // Where it is drawn now: its landing spot plus whatever the glide has
      // left to travel. Cancelled before measuring, so the measure is layout.
      const { animation, landed } = glide.current;
      const transform = animation ? getComputedStyle(element).transform : 'none';
      const offset = transform === 'none' ? null : new DOMMatrixReadOnly(transform);
      from = { top: landed.top + (offset?.m42 ?? 0), left: landed.left + (offset?.m41 ?? 0) };
      animation?.cancel();
      glide.current = null;
    } else if (!active) {
      from = resting.current;
    }
    const rect = element.getBoundingClientRect();
    const here = { top: rect.top, left: rect.left };
    resting.current = active ? here : null;
    if (!from) return;
    const animation = play(element, from, here);
    if (!active) glide.current = { animation, landed: here };
  });

  // While active, a resize moves the element without a commit.
  useEffect(() => {
    if (!active) return;
    const remember = (): void => {
      const element = ref.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      resting.current = { top: rect.top, left: rect.left };
    };
    window.addEventListener('resize', remember);
    return () => window.removeEventListener('resize', remember);
  }, [ref, active]);
}

function play(element: HTMLElement, from: Point, to: Point): Animation | undefined {
  if (document.visibilityState === 'hidden' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  if (dx === 0 && dy === 0) return undefined;
  return element.animate?.([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], GLIDE);
}
