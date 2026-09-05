import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';

import { COLLAPSED_SIDEBAR_WIDTH, MIN_RAIL_WIDTH, SIDEBAR_CONTENT_MIN_WIDTH, useUiStore } from '../lib/ui-store';

// The right sidebar is pinned this far from the window's right edge, so the
// width under the pointer is what is left of the window once that gap and the
// pointer's own distance from the edge are taken off.
const RAIL_EDGE_GAP = 0;
const KEYBOARD_STEP = 16;

function widthUnderPointer(clientX: number): number {
  return window.innerWidth - clientX - RAIL_EDGE_GAP;
}

/**
 * The inspector rail's full-height grab handle: a neutral divider inside a
 * wider pointer target, with a stronger line on hover. It is a sibling of
 * the sidebar rather than a child, both
 * because the sidebar clips its own contents and because the handle belongs to
 * the space beside it.
 */
export function RailResizeHandle({
  label,
  width,
  onResize,
}: {
  label: string;
  /** The sidebar's current width — what the keyboard steps from. */
  width: number;
  onResize: (width: number) => void;
}): React.JSX.Element {
  const [resizing, setResizing] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const sidebarWidth = useUiStore((state) => state.sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : state.sidebarWidth);
  const maxWidth = Math.max(MIN_RAIL_WIDTH, viewportWidth - sidebarWidth - SIDEBAR_CONTENT_MIN_WIDTH);
  useEffect(() => {
    const resized = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', resized);
    return () => window.removeEventListener('resize', resized);
  }, []);
  const pointerRef = useRef<number | null>(null);
  // The handle stands beside the sidebar rather than on its edge, so the width
  // under the pointer is not the sidebar's width. Holding the difference from
  // the moment of the grab keeps the sidebar from jumping to meet the pointer.
  const grabOffsetRef = useRef(0);

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
      aria-valuemax={maxWidth}
      aria-valuemin={MIN_RAIL_WIDTH}
      aria-valuenow={Math.min(maxWidth, width)}
      className={clsx('rail-resizer', resizing && 'is-resizing')}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        onResize(Math.max(MIN_RAIL_WIDTH, Math.min(maxWidth, Math.min(width, maxWidth) + (event.key === 'ArrowLeft' ? KEYBOARD_STEP : -KEYBOARD_STEP))));
      }}
      onLostPointerCapture={(event) => finishDrag(event.currentTarget)}
      onPointerCancel={(event) => finishDrag(event.currentTarget)}
      onPointerDown={(event) => {
        event.preventDefault();
        finishDrag(event.currentTarget);
        pointerRef.current = event.pointerId;
        grabOffsetRef.current = widthUnderPointer(event.clientX) - width;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setResizing(true);
        document.body.classList.add('is-resizing-rail');
      }}
      onPointerMove={(event) => {
        if (event.pointerId !== pointerRef.current) return;
        onResize(Math.max(MIN_RAIL_WIDTH, Math.min(maxWidth, widthUnderPointer(event.clientX) - grabOffsetRef.current)));
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
