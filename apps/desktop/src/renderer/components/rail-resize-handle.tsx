import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';

import { MAX_RAIL_WIDTH, MIN_RAIL_WIDTH } from '../lib/ui-store';

// Both right sidebars are pinned this far from the window's right edge, so the
// width under the pointer is what is left of the window once that gap and the
// pointer's own distance from the edge are taken off.
const RAIL_EDGE_GAP = 8;
const KEYBOARD_STEP = 16;

/**
 * The grab handle shared by HyperSight and the inspector rail: a short pill
 * rather than a full-height border, which colors and grows as it is grabbed so
 * the affordance is legible without drawing a second edge beside the sidebar's.
 */
export function RailResizeHandle({
  label,
  width,
  onResize,
}: {
  label: string;
  width: number;
  onResize: (width: number) => void;
}): React.JSX.Element {
  const [resizing, setResizing] = useState(false);
  const pointerRef = useRef<number | null>(null);

  const finishDrag = (element?: HTMLDivElement): void => {
    if (pointerRef.current === null) return;
    if (element?.hasPointerCapture?.(pointerRef.current)) element.releasePointerCapture(pointerRef.current);
    pointerRef.current = null;
    setResizing(false);
    document.body.classList.remove('is-resizing-rail');
  };

  useEffect(() => () => {
    pointerRef.current = null;
    document.body.classList.remove('is-resizing-rail');
  }, []);

  return (
    <div
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={MAX_RAIL_WIDTH}
      aria-valuemin={MIN_RAIL_WIDTH}
      aria-valuenow={width}
      className={clsx('rail-resizer', resizing && 'is-resizing')}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        onResize(width + (event.key === 'ArrowLeft' ? KEYBOARD_STEP : -KEYBOARD_STEP));
      }}
      onLostPointerCapture={(event) => finishDrag(event.currentTarget)}
      onPointerCancel={(event) => finishDrag(event.currentTarget)}
      onPointerDown={(event) => {
        event.preventDefault();
        finishDrag(event.currentTarget);
        pointerRef.current = event.pointerId;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setResizing(true);
        document.body.classList.add('is-resizing-rail');
      }}
      onPointerMove={(event) => {
        if (event.pointerId !== pointerRef.current) return;
        onResize(window.innerWidth - event.clientX - RAIL_EDGE_GAP);
      }}
      onPointerUp={(event) => {
        if (event.pointerId === pointerRef.current) finishDrag(event.currentTarget);
      }}
      role="separator"
      tabIndex={0}
    >
      <span />
    </div>
  );
}
