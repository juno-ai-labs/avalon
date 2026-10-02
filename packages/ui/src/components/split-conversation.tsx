import clsx from 'clsx';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { SIDEBAR_CONTENT_MIN_WIDTH } from '../lib/sidebar-geometry';

const KEYBOARD_STEP = 16;

/**
 * Which panes of a Channel are on screen.
 *
 * - `main`: the Channel alone, the ordinary state.
 * - `split`: the Channel and its open Breakout side by side.
 * - `breakout`: the Breakout alone, in the Channel's place. Either the right
 *   slot went to a panel the Breakout opened, or the reader cannot open the
 *   Channel's Main at all.
 *
 * A panel the Channel opens while a Breakout is open takes the Breakout's
 * place instead, which is `main` with the Breakout still mounted.
 */
export type SplitConversationMode = 'main' | 'split' | 'breakout';

/** The Breakout's width, keeping both panes at least the conversation minimum. */
export function clampBreakoutWidth(requested: number, containerWidth: number): number {
  const max = Math.max(SIDEBAR_CONTENT_MIN_WIDTH, containerWidth - SIDEBAR_CONTENT_MIN_WIDTH);
  return Math.round(Math.max(SIDEBAR_CONTENT_MIN_WIDTH, Math.min(max, requested)));
}

/**
 * A Channel and its open Breakout as two panes with one resize edge between.
 *
 * Both panes stay mounted whatever the mode, so moving between the split and a
 * single pane neither reconnects a conversation nor loses its scroll. The host
 * owns persistence of the width; null means half.
 */
export function SplitConversationLayout({ breakout, breakoutWidth, main, mode, onBreakoutWidthChange }: {
  breakout: ReactNode | null;
  breakoutWidth: number | null;
  main: ReactNode | null;
  mode: SplitConversationMode;
  onBreakoutWidthChange: (width: number) => void;
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);
  // Too narrow for two conversations at their minimum, a split shows the
  // Breakout alone; its close button returns to the Channel.
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    const measure = (): void => {
      const width = element.getBoundingClientRect().width;
      // Zero is a container not laid out yet, not a narrow one.
      setNarrow(width > 0 && width < 2 * SIDEBAR_CONTENT_MIN_WIDTH);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const drag = useRef<number | null>(null);
  useEffect(() => {
    if (!resizing) return undefined;
    const move = (event: PointerEvent): void => {
      if (drag.current !== event.pointerId) return;
      const bounds = container.current?.getBoundingClientRect();
      if (!bounds) return;
      onBreakoutWidthChange(clampBreakoutWidth(bounds.right - event.clientX, bounds.width));
    };
    const stop = (event: PointerEvent): void => {
      if (drag.current !== event.pointerId) return;
      drag.current = null;
      setResizing(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [onBreakoutWidthChange, resizing]);
  const shown: SplitConversationMode = mode === 'split' && narrow ? 'breakout' : mode;
  const split = shown === 'split' && main !== null && breakout !== null;
  const style = breakoutWidth === null ? undefined : { '--split-breakout-width': `${breakoutWidth}px` } as CSSProperties;
  return <div className={clsx('split-conversation', resizing && 'is-resizing')} ref={container} style={style}>
    {main !== null && <div className="split-conversation-pane is-main" hidden={shown === 'breakout'}>{main}</div>}
    {split && <div
      aria-label="Resize breakout"
      aria-orientation="vertical"
      aria-valuemin={SIDEBAR_CONTENT_MIN_WIDTH}
      aria-valuenow={breakoutWidth ?? undefined}
      className={clsx('split-conversation-resizer', resizing && 'is-resizing')}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const bounds = container.current?.getBoundingClientRect();
        if (!bounds) return;
        const current = breakoutWidth ?? bounds.width / 2;
        onBreakoutWidthChange(clampBreakoutWidth(current + (event.key === 'ArrowLeft' ? KEYBOARD_STEP : -KEYBOARD_STEP), bounds.width));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = event.pointerId;
        setResizing(true);
      }}
      role="separator"
      tabIndex={0}
    />}
    {breakout !== null && <div
      className={clsx('split-conversation-pane is-breakout', (shown === 'breakout' || main === null) && 'is-alone')}
      hidden={shown === 'main'}
    >{breakout}</div>}
  </div>;
}
