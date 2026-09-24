import { ArrowDown, TriangleAlert } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { IconButton } from './primitives';

const ACTIVITY_FRAMES = [{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'scale(1)' }];
const JUMP_FRAMES = [
  { opacity: 0, transform: 'translateX(-50%) translateY(6px)' },
  { opacity: 1, transform: 'translateX(-50%) translateY(0)' },
];

function useRetainedPresence(visible: boolean, ref: RefObject<HTMLElement | null>, frames: Keyframe[]): boolean {
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
      // Reverse from the current visual position, not from an entrance keyframe.
      animation.reverse();
    } else {
      animation?.cancel();
      animation = element.animate(visible ? frames : frames.toReversed(), {
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

/** Retain transient activity until its exit completes, without animating height. */
export function ActivityPresence({ children }: { children: ReactNode }): React.JSX.Element | null {
  const visible = Boolean(children);
  const previous = useRef(children);
  const container = useRef<HTMLDivElement>(null);
  const retained = useRetainedPresence(visible, container, ACTIVITY_FRAMES);
  useLayoutEffect(() => { if (visible) previous.current = children; }, [children, visible]);
  if (!visible && !retained) return null;
  return <div aria-hidden={!visible || undefined} className="activity-presence" ref={container}>{visible ? children : previous.current}</div>;
}

/** Product-neutral control shared by every ordered conversation surface. */
export function JumpToLatestButton({ onJump, visible = true }: { onJump: () => void; visible?: boolean }): React.JSX.Element | null {
  const button = useRef<HTMLButtonElement>(null);
  const retained = useRetainedPresence(visible, button, JUMP_FRAMES);
  if (!visible && !retained) return null;
  return (
    <IconButton aria-hidden={!visible || undefined} className="jump-bottom" disabled={!visible} label="Jump to latest" onClick={onJump} ref={button} tabIndex={visible ? 0 : -1} tooltipSide="top">
      <ArrowDown aria-hidden="true" size={15} />
    </IconButton>
  );
}

/** Live inference status; deliberately not retained for an exit animation. */
export function InferenceDelayNotice(): React.JSX.Element {
  return (
    <div className="inference-delay-notice" role="status">
      <TriangleAlert aria-hidden="true" size={15} />
      <span>The model is currently slowed down. Responses might take longer.</span>
    </div>
  );
}
