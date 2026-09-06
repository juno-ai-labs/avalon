import { ArrowDown, LoaderCircle, RefreshCcw, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button, IconButton } from './primitives';

/** Retain transient activity until its exit completes, without animating height. */
export function ActivityPresence({ children }: { children: ReactNode }): React.JSX.Element | null {
  const visible = Boolean(children);
  const [retained, setRetained] = useState(visible);
  const previous = useRef(children);
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (visible) previous.current = children; }, [children, visible]);
  useLayoutEffect(() => {
    if (visible) setRetained(true);
    const element = container.current;
    if (!element) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || !element.animate) {
      setRetained(visible);
      return;
    }
    const frames = [{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'scale(1)' }];
    const animation = element.animate(visible ? frames : frames.toReversed(), { duration: 160, easing: 'ease-out' });
    animation.onfinish = () => { if (!visible) setRetained(false); };
    return () => { animation.onfinish = null; animation.cancel(); };
  }, [visible, retained]);
  if (!visible && !retained) return null;
  return <div aria-hidden={!visible || undefined} className="activity-presence" ref={container}>{visible ? children : previous.current}</div>;
}

/** Product-neutral control shared by every ordered conversation surface. */
export function JumpToLatestButton({ onJump, visible = true }: { onJump: () => void; visible?: boolean }): React.JSX.Element | null {
  const [retained, setRetained] = useState(visible);
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (visible) setRetained(true);
    const element = button.current;
    if (!element) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || !element.animate) {
      setRetained(visible);
      return;
    }
    const frames = [
      { opacity: 0, transform: 'translateX(-50%) translateY(6px)' },
      { opacity: 1, transform: 'translateX(-50%) translateY(0)' },
    ];
    const animation = element.animate(visible ? frames : frames.toReversed(), { duration: 160, easing: 'ease-out' });
    animation.onfinish = () => { if (!visible) setRetained(false); };
    return () => { animation.onfinish = null; animation.cancel(); };
  }, [visible, retained]);
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
