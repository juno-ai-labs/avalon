import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Keep a transient element mounted through its exit, reversing interrupted motion in place. */
export function useRetainedPresence(visible: boolean, ref: RefObject<HTMLElement | null>, frames: Keyframe[]): boolean {
  const [retained, setRetained] = useState(visible);
  const motion = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    if (visible) setRetained(true);
    const element = ref.current;
    if (!element) return;
    if (document.visibilityState === 'hidden'
      || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || !element.animate) {
      motion.current?.cancel();
      motion.current = null;
      setRetained(visible);
      return;
    }
    let animation = motion.current;
    if (animation?.playState === 'running') {
      animation.reverse();
    } else {
      animation?.cancel();
      animation = element.animate(visible ? frames : [...frames].reverse(), {
        duration: 160, easing: 'ease-out', fill: 'forwards',
      });
      motion.current = animation;
    }
    animation.onfinish = () => { if (!visible) setRetained(false); };
  }, [visible, ref, frames]);
  useLayoutEffect(() => () => {
    if (motion.current) {
      motion.current.onfinish = null;
      motion.current.cancel();
    }
  }, []);
  return retained;
}
