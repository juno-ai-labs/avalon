import { ArrowDown, LoaderCircle, RefreshCcw, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button, IconButton } from './primitives';

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

/**
 * What a conversation says after somebody stopped it.
 *
 * Shared by the work-stream feed and the automation builder rather than
 * imported from one screen into the other: a screen that re-exports a
 * component becomes a second import path for it, and the next reader
 * cannot tell which one is the real home.
 */
export function RunStoppedNotice({
  retrying,
  onRetry,
}: {
  retrying: boolean;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <section aria-label="Run stopped" className="run-stopped-notice" role="status">
      <span aria-hidden="true" className="run-stopped-icon"><X size={16} /></span>
      <div className="run-stopped-copy">
        <strong>Run stopped</strong>
        <p>This run was stopped by request. Its partial tool activity is no longer running.</p>
      </div>
      <Button className="button-primary" disabled={retrying} onClick={onRetry}>
        {retrying ? <LoaderCircle aria-hidden="true" className="spin" size={13} /> : <RefreshCcw aria-hidden="true" size={13} />}
        Retry
      </Button>
    </section>
  );
}
