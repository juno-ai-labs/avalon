import { ArrowDown, TriangleAlert } from 'lucide-react';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useRetainedPresence } from '@rally/ui/lib/retained-presence';
import { IconButton } from './primitives';

const ACTIVITY_FRAMES = [{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'scale(1)' }];
const JUMP_FRAMES = [
  { opacity: 0, transform: 'translateX(-50%) translateY(6px)' },
  { opacity: 1, transform: 'translateX(-50%) translateY(0)' },
];

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
